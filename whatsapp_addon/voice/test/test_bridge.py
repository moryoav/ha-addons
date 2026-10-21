import asyncio
import base64
import importlib.util
from pathlib import Path
from contextlib import asynccontextmanager
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
import json
import threading
import time
import sys

sys.path.insert(0, str(Path(__file__).parents[1] / "bridge"))

spec = importlib.util.spec_from_file_location("voice_bridge", Path(__file__).parents[1] / "bridge" / "bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Socket:
    closed = False

    def __init__(self):
        self.events = []

    async def send_json(self, event):
        self.events.append(event)


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.bridge = module.Bridge({"agent_id": "conversation.synthetic_agent", "agent_service": "whatsapp_conversation_guard.process"}, self.temp.name)
        self.bridge.log = lambda *args, **kwargs: None
        self.call = module.CallContext("synthetic-call-a")
        self.call.ws = Socket()
        self.call.input_fragments = ["What is the synthetic sensor state?"]
        self.bridge.call = self.call

    def tearDown(self):
        self.temp.cleanup()

    async def test_duplicate_delegation_executes_backend_once(self):
        requests = []

        async def ha(path, data):
            requests.append((path, data))
            return {"service_response": {"conversation_id": "synthetic-conversation", "response": {
                "response_type": "query_answer", "speech": {"plain": {"speech": "The sensor is on."}}
            }}}

        self.bridge.ha = ha
        await asyncio.gather(self.bridge.delegate(self.call, "same-delegation"),
                             self.bridge.delegate(self.call, "same-delegation"))
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0][0], "/services/conversation/process?return_response")
        self.assertEqual(set(requests[0][1]), {"agent_id", "text"})
        self.assertEqual(self.call.backend_count, 1)
        self.assertEqual(len(self.call.ws.events), 1)
        self.assertNotIn("to", requests[0][1], "Voice delegation must not send WhatsApp presence/messages")

    async def test_late_backend_result_is_not_spoken_to_next_call(self):
        started, finish = asyncio.Event(), asyncio.Event()

        async def ha(path, data):
            started.set()
            await finish.wait()
            return {"service_response": {"response": {"speech": {"plain": {"speech": "Old result"}}}}}

        self.bridge.ha = ha
        task = asyncio.create_task(self.bridge.delegate(self.call, "old-delegation"))
        await started.wait()
        replacement = module.CallContext("synthetic-call-b")
        replacement.ws = Socket()
        self.bridge.call = replacement
        self.call.closed = True
        finish.set()
        await task
        self.assertEqual(replacement.ws.events, [])
        self.assertEqual(self.call.ws.events, [])

    async def test_late_audio_from_another_call_is_discarded(self):
        await self.bridge.handle_driver_event({"type": "audio", "call_id": "other-call",
                                              "data": base64.b64encode(b"\x01\x00" * 960).decode()})
        self.assertEqual(self.call.rx_samples, 0)

    async def test_ended_call_duration_is_frozen(self):
        self.call.first_rx = self.call.created
        await self.bridge.handle_driver_event({"type": "call_ended", "call_id": self.call.call_id})
        first = self.call.summary()["audio_connected_seconds"]
        await asyncio.sleep(0.03)
        self.assertEqual(first, self.call.summary()["audio_connected_seconds"])
        self.bridge.save()
        self.assertIsNone(self.bridge.status["active_call"])

    def test_partial_pcm_sample_is_rejected(self):
        with self.assertRaises(ValueError):
            module.checked_pcm(base64.b64encode(b"\x01").decode())

    async def test_codec_diagnostics_belong_to_their_call(self):
        self.call.audio_codec = "opus"
        await self.bridge.handle_driver_event({"type": "codec_observed", "call_id": "old-call",
                                              "codec": "mlow"})
        self.assertIsNone(self.call.inbound_codec)
        await self.bridge.handle_driver_event({"type": "codec_observed", "call_id": self.call.call_id,
                                              "codec": "opus"})
        await self.bridge.handle_driver_event({"type": "media_stats", "call_id": self.call.call_id,
                                              "stats": {"codec_switches": 0}})
        self.assertEqual(self.call.summary()["inbound_codec"], "opus")
        self.assertEqual(self.call.summary()["media_stats"], {"codec_switches": 0})

    async def test_audio_stream_coalesces_disk_writes_and_saves_call_end(self):
        raw = base64.b64encode(b"\x01\x00" * 320).decode()
        events = [{"type": "audio", "call_id": self.call.call_id, "data": raw}] * 200
        events.append({"type": "call_ended", "call_id": self.call.call_id})

        with patch.object(module.os, "replace", wraps=module.os.replace) as writes:
            for event in events:
                await self.bridge.handle_driver_event(event)
        self.assertLess(writes.call_count, 10, "Streaming audio must not write status per chunk")
        saved = json.loads((Path(self.temp.name) / "status.json").read_text())
        self.assertTrue(saved["last_call"]["ended"])

    def test_playback_buffer_range(self):
        self.assertEqual(module.playback_buffer_option({}), 180)
        for value in (120, 180, 480, 1500):
            self.assertEqual(module.playback_buffer_option({"playback_buffer_ms": value}), value)
        for value in (119, 1501, "480", True):
            with self.assertRaises(ValueError):
                module.playback_buffer_option({"playback_buffer_ms": value})

    async def test_opus_silence_keeps_a_paced_continuous_input_stream(self):
        call = self.call
        call.input_pcm.extend(b"\x01\x00" * 960)
        call.input_available.set()
        events = []

        class PacedSocket:
            closed = False

            async def send_json(self, event):
                events.append((time.monotonic(), base64.b64decode(event["audio"])))
                if len(events) == 6:
                    call.closed = True

        await asyncio.wait_for(self.bridge.input_audio_loop(call, PacedSocket()), 3)
        self.assertEqual([len(data) for _, data in events], [640] * 6)
        self.assertEqual(b"".join(data for _, data in events[:3]), b"\x01\x00" * 960)
        self.assertEqual(b"".join(data for _, data in events[3:]), bytes(1920))
        self.assertGreaterEqual(events[-1][0] - events[0][0], 0.08)
        self.assertEqual(call.input_sent_samples, 1920)
        self.assertEqual(call.input_silence_samples, 960)

    async def test_slow_status_disk_does_not_block_the_audio_event_loop(self):
        entered, release = threading.Event(), threading.Event()

        def slow_write(payload):
            entered.set()
            release.wait(1)

        self.bridge.write_status = slow_write
        self.bridge.status_writer_running = True
        writer = self.bridge.task(self.bridge.status_writer())
        try:
            start = time.monotonic()
            self.bridge.save()
            deadline = time.monotonic() + 1
            while not entered.is_set() and time.monotonic() < deadline:
                await asyncio.sleep(0.005)
            self.assertTrue(entered.is_set())
            await asyncio.sleep(0.025)
            self.assertLess(time.monotonic() - start, 0.3)
        finally:
            release.set()
            await asyncio.wait_for(self.bridge.status_queue.join(), 2)
            writer.cancel()
            await asyncio.gather(writer, return_exceptions=True)
            self.bridge.status_writer_running = False

    async def test_peer_loss_history_retains_timing_and_final_loss(self):
        for at_ms, lost, sequence in ((1000, 87, 0xfffffffe), (2000, 85, 3)):
            await self.bridge.handle_driver_event({
                "type": "network_stats", "call_id": self.call.call_id,
                "at_ms": at_ms, "peer_loss_percent": 25.78125,
                "peer_cumulative_lost": lost, "peer_jitter_ticks": 524,
                "peer_extended_highest_sequence": sequence,
            })
        summary = self.call.summary()
        self.assertEqual(summary["network_stats"]["max_peer_cumulative_lost"], 87)
        self.assertEqual(summary["network_stats"]["last_peer_cumulative_lost"], 85)
        self.assertEqual(summary["network_history"][-1]["packets_expected_since_report"], 5)
        self.assertNotIn("peer_extended_highest_sequence", summary["network_history"][-1])

    async def test_transport_and_playback_history_is_bounded_and_call_scoped(self):
        for n in range(305):
            await self.bridge.handle_driver_event({
                "type": "playback_stats", "call_id": self.call.call_id, "at_ms": n * 1000,
                "stats": {"queued_ms": 180, "playback_rate": 0.982},
                "transport_stats": {"submitted_rtp_packets": n},
            })
        await self.bridge.handle_driver_event({
            "type": "playback_stats", "call_id": "old-call", "at_ms": 999999,
            "stats": {"queued_ms": 0}, "transport_stats": {"submitted_rtp_packets": -1},
        })
        self.assertEqual(len(self.call.playback_history), 300)
        self.assertEqual(self.call.playback_history[0]["at_ms"], 5000)
        self.assertEqual(self.call.transport_stats["submitted_rtp_packets"], 304)

    def test_random_greeting_input_avoids_consecutive_repeats(self):
        previous = None
        for _ in range(64):
            message, = self.bridge.greeting_input()
            self.assertEqual(message["type"], "message")
            self.assertEqual(message["role"], "developer")
            content, = message["content"]
            self.assertEqual(content["type"], "input_text")
            self.assertIn(self.bridge.last_greeting, module.OPENING_GREETINGS)
            self.assertNotEqual(self.bridge.last_greeting, previous)
            self.assertIn(self.bridge.last_greeting, content["text"])
            previous = self.bridge.last_greeting

    def test_fixed_and_disabled_greeting_input(self):
        self.bridge.options.update(greeting_text="Synthetic opening", randomize_greeting=False)
        message, = self.bridge.greeting_input()
        self.assertIn("Synthetic opening", message["content"][0]["text"])
        self.bridge.options["greeting_text"] = " "
        self.assertEqual(self.bridge.greeting_input(), [])

    async def test_confirmed_goodbye_hangs_up_without_audio_or_playback(self):
        commands = []

        async def driver(command): commands.append(command)

        self.bridge.send_driver = driver
        self.call.playback_stats = {"played_audio_ms": 0, "queued_ms": 3000}
        self.call.ws.send_json = AsyncMock(side_effect=AssertionError("No farewell instruction is needed"))
        await asyncio.wait_for(self.bridge.finish_conversation(self.call, "clear_goodbye"), 0.1)
        await self.bridge.finish_conversation(self.call, "clear_goodbye")
        self.assertEqual(commands, [{"action": "hangup"}])
        self.assertTrue(self.call.ending)
        self.assertEqual(self.call.end_reason, "clear_goodbye")

    async def test_caption_order_does_not_delay_a_confirmed_goodbye(self):
        commands = []

        async def driver(command): commands.append(command)

        self.bridge.send_driver = driver
        self.call.input_fragments = ["That is all. Goodbye."]
        self.call.output_fragments = ["Goodbye!"]
        self.call.last_input_transcript_at = time.monotonic()
        self.call.playback_stats = None
        await asyncio.wait_for(self.bridge.finish_conversation(self.call, "clear_goodbye"), 0.1)
        self.assertEqual(commands, [{"action": "hangup"}])
        self.assertEqual(self.call.ws.events, [])
        self.assertLess(self.call.hangup_after_last_transcript_ms, 100)

    async def test_resumed_speech_does_not_cancel_a_confirmed_hangup(self):
        entered, release = asyncio.Event(), asyncio.Event()
        commands = []

        async def driver(command):
            entered.set()
            await release.wait()
            commands.append(command)

        self.bridge.send_driver = driver
        pending = asyncio.create_task(self.bridge.finish_conversation(self.call, "clear_goodbye"))
        await asyncio.wait_for(entered.wait(), 1)
        self.bridge.input_transcript(self.call, {"delta": "Actually, one more question."})
        self.assertTrue(self.call.ending)
        self.assertIsNone(self.call.control_task)
        release.set()
        await pending
        self.assertEqual(commands, [{"action": "hangup"}])

    async def test_hangup_does_not_wait_for_a_pending_home_assistant_request(self):
        commands, requests = [], []

        @asynccontextmanager
        async def post(url, **options):
            requests.append(options["json"])
            body = {"status": "completed", "output": [{"type": "function_call", "name": "end_whatsapp_call",
                    "arguments": '{"reason":"clear_goodbye"}'}],
                    "usage": {"input_tokens": 1000, "input_tokens_details": {"cached_tokens": 700},
                              "output_tokens": 30, "output_tokens_details": {"reasoning_tokens": 0}}}
            yield SimpleNamespace(raise_for_status=lambda: None, json=AsyncMock(return_value=body))

        async def driver(command): commands.append(command)

        self.bridge.key = "synthetic-key"
        self.bridge.http = SimpleNamespace(post=post)
        self.bridge.send_driver = driver
        self.call.user_turn_text = "Okay, bye."
        self.call.last_input_transcript_at = time.monotonic() - 2
        async with self.call.backend_lock:
            await asyncio.wait_for(self.bridge.check_call_control(self.call), 0.1)
        self.assertEqual(commands, [{"action": "hangup"}])
        self.assertEqual(requests[0]["reasoning"], {"effort": "none"})
        self.assertEqual(requests[0]["max_output_tokens"], 128)
        report = self.call.summary()
        self.assertEqual(report["call_control_input_tokens"], 1000)
        self.assertEqual(report["call_control_cached_input_tokens"], 700)
        self.assertEqual(report["call_control_output_tokens"], 30)
        self.assertEqual(report["call_control_reasoning_tokens"], 0)
        self.assertIsNotNone(report["call_control_last_latency_ms"])

    async def test_new_speech_does_not_cancel_an_inflight_positive_check(self):
        entered, release = asyncio.Event(), asyncio.Event()
        commands = []

        @asynccontextmanager
        async def post(url, **options):
            entered.set()
            await release.wait()
            body = {"status": "completed", "output": [{"type": "function_call", "name": "end_whatsapp_call",
                    "arguments": '{"reason":"clear_goodbye"}'}]}
            yield SimpleNamespace(raise_for_status=lambda: None, json=AsyncMock(return_value=body))

        async def driver(command): commands.append(command)

        self.bridge.key = "synthetic-key"
        self.bridge.http = SimpleNamespace(post=post)
        self.bridge.send_driver = driver
        pending = asyncio.create_task(self.bridge.check_call_control(self.call))
        self.call.control_task = pending
        await asyncio.wait_for(entered.wait(), 1)
        self.bridge.input_transcript(self.call, {"delta": "Actually, one more thing."})
        self.assertIs(self.call.control_task, pending)
        self.assertFalse(pending.cancelled())
        release.set()
        await asyncio.wait_for(pending, 0.1)
        self.assertEqual(commands, [{"action": "hangup"}])

    async def test_new_goodbye_is_checked_after_an_inflight_negative_check(self):
        entered, release = asyncio.Event(), asyncio.Event()
        commands, requests = [], []

        @asynccontextmanager
        async def post(url, **options):
            requests.append(json.loads(options["json"]["input"][0]["content"]))
            if len(requests) == 1:
                entered.set()
                await release.wait()
                body = {"status": "completed", "output": []}
            else:
                body = {"status": "completed", "output": [{"type": "function_call", "name": "end_whatsapp_call",
                        "arguments": '{"reason":"clear_goodbye"}'}]}
            yield SimpleNamespace(raise_for_status=lambda: None, json=AsyncMock(return_value=body))

        async def driver(command): commands.append(command)

        self.bridge.key = "synthetic-key"
        self.bridge.http = SimpleNamespace(post=post)
        self.bridge.send_driver = driver
        self.call.user_turn_text = "What is the sensor state?"
        self.call.last_input_end_ms = 1000
        with patch.object(module, "CONTROL_SETTLE_SECONDS", 0), patch.object(module, "CONTROL_MIN_INTERVAL_SECONDS", 0):
            pending = asyncio.create_task(self.bridge.check_call_control(self.call))
            self.call.control_task = pending
            await asyncio.wait_for(entered.wait(), 1)
            self.bridge.input_transcript(self.call, {"delta": "Thank you. Goodbye.", "start_ms": 3000, "end_ms": 4000})
            self.assertIs(self.call.control_task, pending)
            release.set()
            await asyncio.wait_for(pending, 0.1)
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[1]["latest_caller_utterance"], "Thank you. Goodbye.")
        self.assertEqual(commands, [{"action": "hangup"}])

    async def test_home_result_is_discarded_after_a_confirmed_hangup(self):
        self.call.ending = True
        await asyncio.wait_for(self.bridge.commentary(self.call, "synthetic-task", "The light is off."), 0.1)
        self.assertEqual(self.call.ws.events, [])
        self.bridge.ha = AsyncMock()
        await self.bridge.delegate(self.call, "synthetic-new-task")
        self.bridge.ha.assert_not_called()

    async def test_a_stale_decision_cannot_end_the_next_call(self):
        commands = []

        async def driver(command): commands.append(command)

        self.bridge.send_driver = driver
        old = self.call
        self.bridge.call = module.CallContext("replacement-call")
        await self.bridge.finish_conversation(old, "clear_goodbye")
        self.assertEqual(commands, [])

    def test_call_archives_are_numeric_private_and_bounded(self):
        for n in range(23):
            self.bridge.archive_call(str(n).zfill(3), self.call.summary())
        reports = sorted(Path(self.temp.name).glob("call-metrics-*.json"))
        self.assertEqual(len(reports), 20)
        saved = json.loads(reports[-1].read_text())
        self.assertNotIn("call_id", saved)
        self.assertNotIn("input_fragments", saved)
        self.assertNotIn("output_fragments", saved)

    async def test_stale_semantic_check_never_blocks_ha_or_ends_a_new_call(self):
        entered, release = asyncio.Event(), asyncio.Event()
        commands = []

        class Response:
            async def __aenter__(self):
                entered.set()
                await release.wait()
                return self
            async def __aexit__(self, *args): pass
            def raise_for_status(self): pass
            async def json(self):
                return {"status": "completed", "output": [{"type": "function_call", "name": "end_whatsapp_call",
                    "arguments": '{"reason":"clear_goodbye"}'}]}

        class HTTP:
            def post(self, *args, **kwargs): return Response()

        async def driver(command): commands.append(command)

        self.bridge.key = "synthetic-key"
        self.bridge.http = HTTP()
        self.bridge.send_driver = driver
        self.call.user_turn_text = "Okay, bye."
        pending = asyncio.create_task(self.bridge.check_call_control(self.call))
        await entered.wait()
        self.assertFalse(self.call.backend_lock.locked(), "Call checks must not delay Home Assistant")
        self.bridge.call = module.CallContext("replacement-call")
        release.set()
        await pending
        self.assertEqual(commands, [])


if __name__ == "__main__":
    unittest.main()
