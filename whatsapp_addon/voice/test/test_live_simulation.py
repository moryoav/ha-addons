"""Drive the actual voice bridge using fake GPT-Live and HA endpoints only."""
import asyncio
import base64
from contextlib import asynccontextmanager
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import aiohttp

BRIDGE = Path(__file__).parents[1] / "bridge"
sys.path.insert(0, str(BRIDGE))
spec = importlib.util.spec_from_file_location("simulated_live_bridge", BRIDGE / "bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeSocket:
    def __init__(self):
        self.closed = False
        self.events = []
        self.incoming = asyncio.Queue()
        self.greeted = asyncio.Event()
        self.delegated = asyncio.Event()
        self.ended = False

    async def receive(self, value):
        await self.incoming.put(types.SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=json.dumps(value)))

    async def send_json(self, event):
        self.events.append(event)
        kind = event["type"]
        if kind == "session.start":
            await self.receive({"type": "session.started"})
            if event["session"]["input"]:
                self.greeted.set()
                await self.receive({"type": "session.output_audio.delta", "delta": base64.b64encode(b"\x01\x02" * 320).decode()})
        elif kind == "session.commentary.append":
            self.delegated.set()
        elif kind == "session.close":
            await self.receive({"type": "session.closed", "usage": {"seconds": 123}})

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.ended:
            raise StopAsyncIteration
        value = await self.incoming.get()
        if json.loads(value.data)["type"] == "session.closed":
            self.ended = True
        return value


class FakeHttp:
    def __init__(self, socket, connect_gate=None):
        self.socket = socket
        self.connections = 0
        self.connecting = asyncio.Event()
        self.connect_gate = connect_gate

    @asynccontextmanager
    async def ws_connect(self, url, **options):
        assert url == "wss://api.openai.com/v1/live/sessions"
        self.connections += 1
        self.connecting.set()
        if self.connect_gate:
            await self.connect_gate.wait()
        yield self.socket

    async def close(self):
        self.socket.closed = True


class VoiceSimulationTests(unittest.IsolatedAsyncioTestCase):
    async def test_connected_greeting_audio_agent_delegation_and_graceful_close(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = module.Bridge({"agent_id": "conversation.synthetic_agent", "automatic_hangup": False}, directory)
            bridge.log = lambda *args, **kwargs: None
            bridge.key = "synthetic-api-key"
            socket = FakeSocket()
            bridge.http = FakeHttp(socket)
            commands, home_requests = [], []

            async def send_driver(command):
                commands.append(command)

            async def ha(path, data=None):
                if path.startswith("/states/"):
                    return {"state": "ready"}
                if path == "/services":
                    return [{"domain": "conversation", "services": {"process": {}}}]
                home_requests.append((path, data))
                return {"service_response": {"conversation_id": "synthetic-context", "response": {
                    "speech": {"plain": {"speech": "The synthetic sensor is on."}}, "response_type": "query_answer"
                }}}

            bridge.send_driver = send_driver
            bridge.ha = ha
            await bridge.preflight()
            await bridge.handle_driver_event({"type": "call_started", "call_id": "synthetic-call", "audio_codec": "opus"})
            await asyncio.sleep(0.02)
            self.assertFalse(bridge.call.voice_started)
            self.assertEqual(bridge.http.connections, 0, "GPT-Live must wait for the answered phone's audio")
            self.assertEqual(socket.events, [])
            self.assertEqual(commands, [])
            await bridge.handle_driver_event({"type": "audio", "call_id": "synthetic-call", "data": base64.b64encode(bytes(640)).decode()})
            await asyncio.wait_for(socket.greeted.wait(), 2)
            start = socket.events[0]["session"]
            self.assertEqual(start["model"], "gpt-live-1")
            self.assertFalse(start["store"])
            self.assertEqual(start["audio"]["format"]["rate"], 16000)
            self.assertEqual(start["delegation"], {"type": "client"})
            message, = start["input"]
            self.assertEqual(message["role"], "developer")
            self.assertEqual(message["content"][0]["type"], "input_text")
            self.assertIn("pause and listen", message["content"][0]["text"])
            self.assertNotIn("Wait for the application's", start["instructions"])
            await bridge.handle_driver_event({"type": "audio", "call_id": "synthetic-call", "data": base64.b64encode(bytes(640)).decode()})
            await socket.receive({"type": "session.input_transcript.delta", "delta": "Read the synthetic sensor.", "start_ms": 0, "end_ms": 1200})
            for _ in range(2):
                await socket.receive({"type": "session.delegation.created", "delegation": {"id": "synthetic-delegation"}})
            await asyncio.wait_for(socket.delegated.wait(), 3)
            self.assertEqual(len(home_requests), 1)
            self.assertEqual(home_requests[0][0], "/services/conversation/process?return_response")
            self.assertEqual(home_requests[0][1]["agent_id"], "conversation.synthetic_agent")
            self.assertNotIn("to", home_requests[0][1])
            self.assertNotIn("client_id", home_requests[0][1])
            self.assertTrue(any(command["action"] == "audio" for command in commands))
            self.assertTrue(any(event["type"] == "session.input_audio.append" for event in socket.events))
            self.assertEqual(sum(event["type"] == "session.start" for event in socket.events), 1)
            self.assertFalse(any(event["type"] == "session.instructions.append" for event in socket.events))
            self.assertTrue(bridge.call.greeting_accepted)
            await bridge.handle_driver_event({"type": "call_ended", "call_id": "synthetic-call"})
            await asyncio.wait_for(bridge.voice_task, 3)
            self.assertTrue(bridge.call.voice_finalized)
            self.assertEqual(bridge.call.voice_seconds, 123)
            await bridge.shutdown()
            reports = list(Path(directory).glob("call-metrics-*.json"))
            self.assertEqual(len(reports), 1)
            self.assertNotIn("Read the synthetic sensor", reports[0].read_text())

    async def test_stale_audio_command_cannot_reach_the_current_call(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = module.Bridge({}, directory)
            bridge.call = module.CallContext("current-call")
            with patch.object(module, "emit") as output:
                await bridge.send_driver({"action": "audio", "call_id": "old-call", "data": "AAA="})
                output.assert_not_called()

    async def test_live_api_error_ends_the_call_instead_of_leaving_a_silent_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = module.Bridge({"automatic_hangup": False}, directory)
            bridge.log = lambda *args, **kwargs: None
            bridge.key = "synthetic-api-key"
            socket = FakeSocket()
            await socket.receive({"type": "error", "error": {"code": "synthetic_invalid_session"}})
            bridge.http = FakeHttp(socket)
            commands = []

            async def send_driver(command):
                commands.append(command)

            bridge.send_driver = send_driver
            await bridge.handle_driver_event({"type": "call_started", "call_id": "synthetic-call", "audio_codec": "opus"})
            await bridge.handle_driver_event({"type": "audio", "call_id": "synthetic-call", "data": base64.b64encode(bytes(640)).decode()})
            await asyncio.wait_for(bridge.voice_task, 3)
            self.assertEqual(commands, [{"action": "hangup", "call_id": "synthetic-call"}])
            self.assertEqual(bridge.status["last_error_stage"], "gpt_live")
            await bridge.shutdown()

    async def test_ended_ringing_call_never_starts_live_or_speaks(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = module.Bridge({}, directory)
            bridge.log = lambda *args, **kwargs: None
            socket = FakeSocket()
            bridge.http = FakeHttp(socket)
            await bridge.handle_driver_event({"type": "call_started", "call_id": "unanswered"})
            await asyncio.sleep(0.02)
            await bridge.handle_driver_event({"type": "call_ended", "call_id": "unanswered"})
            await asyncio.wait_for(bridge.voice_task, 0.5)
            self.assertEqual(bridge.http.connections, 0)
            self.assertEqual(socket.events, [])
            self.assertFalse(bridge.call.greeting_sent)
            await bridge.shutdown()

    async def test_hangup_during_live_connection_prevents_session_start(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = module.Bridge({}, directory)
            bridge.log = lambda *args, **kwargs: None
            bridge.key = "synthetic-api-key"
            socket, connect_gate = FakeSocket(), asyncio.Event()
            bridge.http = FakeHttp(socket, connect_gate)
            await bridge.handle_driver_event({"type": "call_started", "call_id": "ended-while-connecting"})
            await bridge.handle_driver_event({"type": "audio", "call_id": bridge.call.call_id, "data": base64.b64encode(bytes(640)).decode()})
            await asyncio.wait_for(bridge.http.connecting.wait(), 0.5)
            await bridge.handle_driver_event({"type": "call_ended", "call_id": bridge.call.call_id})
            connect_gate.set()
            await asyncio.wait_for(bridge.voice_task, 0.5)
            self.assertEqual(socket.events, [])
            self.assertFalse(bridge.call.greeting_sent)
            await bridge.shutdown()

    async def test_disabled_greeting_keeps_continuous_input_without_opening_speech(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = module.Bridge({"greeting_text": ""}, directory)
            bridge.log = lambda *args, **kwargs: None
            bridge.key = "synthetic-api-key"
            socket = FakeSocket()
            bridge.http = FakeHttp(socket)
            await bridge.handle_driver_event({"type": "call_started", "call_id": "quiet-opening"})
            await bridge.handle_driver_event({"type": "audio", "call_id": bridge.call.call_id, "data": base64.b64encode(bytes(640)).decode()})
            for _ in range(50):
                if any(event["type"] == "session.input_audio.append" for event in socket.events):
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(socket.events[0]["session"]["input"], [])
            self.assertIn("Let the caller speak first", socket.events[0]["session"]["instructions"])
            self.assertTrue(any(event["type"] == "session.input_audio.append" for event in socket.events))
            self.assertFalse(socket.greeted.is_set())
            self.assertFalse(bridge.call.greeting_sent)
            self.assertFalse(bridge.call.greeting_accepted)
            await bridge.shutdown()
