"""GPT-Live and Home Assistant call bridge; no WhatsApp authentication or session files."""
from __future__ import annotations
import asyncio
import base64
import contextlib
import json
import os
import random
import sys
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
import aiohttp
from call_control import decision_request, end_call_decision
OPENING_GREETINGS = tuple(json.loads((Path(__file__).parents[1] / "greetings.json").read_text(encoding="utf-8")))
CONTROL_SETTLE_SECONDS = 0.35
CONTROL_MIN_INTERVAL_SECONDS = 0.75


def utc_now():
    return datetime.now(timezone.utc).isoformat()

def checked_pcm(data):
    if not isinstance(data, str) or len(data) > 90000:
        raise ValueError("PCM frame is too large")
    raw = base64.b64decode(data, validate=True)
    if len(raw) % 2:
        raise ValueError("incomplete PCM sample")
    return raw

def playback_buffer_option(options):
    value = options.get("playback_buffer_ms", 180)
    if type(value) is not int or not 120 <= value <= 1500:
        raise ValueError("playback_buffer_ms must be an integer between 120 and 1500")
    return value

class CallContext:
    def __init__(self, call_id):
        self.call_id = call_id
        self.created = time.monotonic()
        self.report_stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        self.first_rx = None
        self.last_rx = None
        self.max_rx_gap = 0.0
        self.rx_samples = 0
        self.tx_samples = 0
        self.input_fragments = []
        self.output_fragments = []
        self.consumed_fragments = 0
        self.delegations = set()
        self.backend_count = 0
        self.backend_errors = 0
        self.conversation_id = None
        self.closed = False
        self.ended_at = None
        self.voice_started = False
        self.voice_finalized = False
        self.voice_seconds = None
        self.audio_codec = None
        self.inbound_codec = None
        self.media_stats = None
        self.playback_stats = None
        self.transport_stats = None
        self.playback_history = deque(maxlen=300)
        self.network_history = deque(maxlen=300)
        self.last_peer_sequence = None
        self.last_output_audio = None
        self.max_output_gap = 0.0
        self.output_gap_events = deque(maxlen=32)
        self.playback_buffer_ms = None
        self.network_stats = {"outbound_media_dropped_packets": 0, "peer_report_count": 0,
                              "max_peer_loss_percent": 0.0, "max_peer_jitter_ticks": 0,
                              "max_peer_cumulative_lost": 0}
        self.ws = None
        self.input_pcm = bytearray()
        self.input_available = asyncio.Event()
        self.input_sent_samples = 0
        self.input_silence_samples = 0
        self.input_dropped_samples = 0
        self.last_input_send = None
        self.max_input_send_gap = 0.0
        self.backend_lock = asyncio.Lock()
        self.media_ready = asyncio.Event()
        self.closed_event = asyncio.Event()
        self.greeting_sent = False
        self.greeting_accepted = False
        self.input_version = 0
        self.user_turn_text = ""
        self.last_input_end_ms = None
        self.last_input_transcript_at = 0.0
        self.control_task = None
        self.control_checks = 0
        self.control_errors = 0
        self.control_last_check = 0.0
        self.control_last_latency_ms = None
        self.control_max_latency_ms = 0.0
        self.control_input_tokens = 0
        self.control_cached_input_tokens = 0
        self.control_output_tokens = 0
        self.control_reasoning_tokens = 0
        self.hangup_after_last_transcript_ms = None
        self.ending = False
        self.end_reason = None

    def summary(self):
        now = self.ended_at if self.ended_at is not None else time.monotonic()
        return {
            "elapsed_seconds": round(now - self.created, 2),
            "audio_connected_seconds": round(now - self.first_rx, 2) if self.first_rx else 0,
            "received_audio_seconds": round(self.rx_samples / 16000, 2),
            "generated_audio_seconds": round(self.tx_samples / 16000, 2),
            "max_receive_gap_seconds": round(self.max_rx_gap, 2),
            "user_transcript_fragments": len(self.input_fragments),
            "assistant_transcript_fragments": len(self.output_fragments),
            "home_assistant_requests": self.backend_count,
            "home_assistant_errors": self.backend_errors,
            "voice_started": self.voice_started,
            "voice_finalized": self.voice_finalized,
            "voice_usage_seconds": self.voice_seconds,
            "ended": self.closed,
            "audio_codec": self.audio_codec,
            "inbound_codec": self.inbound_codec,
            "media_stats": self.media_stats,
            "playback_stats": self.playback_stats,
            "transport_stats": self.transport_stats,
            "playback_history": list(self.playback_history),
            "network_history": list(self.network_history),
            "max_output_audio_gap_seconds": round(self.max_output_gap, 3),
            "recent_output_gaps": list(self.output_gap_events),
            "playback_buffer_ms": self.playback_buffer_ms,
            "network_stats": dict(self.network_stats),
            "input_sent_seconds": round(self.input_sent_samples / 16000, 2),
            "input_silence_seconds": round(self.input_silence_samples / 16000, 2),
            "input_overflow_samples": self.input_dropped_samples,
            "max_input_send_gap_seconds": round(self.max_input_send_gap, 3),
            "greeting_sent": self.greeting_sent,
            "greeting_accepted": self.greeting_accepted,
            "call_control_checks": self.control_checks,
            "call_control_errors": self.control_errors,
            "call_control_last_latency_ms": self.control_last_latency_ms,
            "call_control_max_latency_ms": self.control_max_latency_ms,
            "call_control_input_tokens": self.control_input_tokens,
            "call_control_cached_input_tokens": self.control_cached_input_tokens,
            "call_control_output_tokens": self.control_output_tokens,
            "call_control_reasoning_tokens": self.control_reasoning_tokens,
            "hangup_after_last_transcript_ms": self.hangup_after_last_transcript_ms,
            "end_reason": self.end_reason,
        }

class Bridge:
    def __init__(self, options, output_dir, config_dir="/config"):
        self.options = options
        self.playback_buffer_ms = playback_buffer_option(options)
        self.output_dir = Path(output_dir)
        self.config_dir = Path(config_dir)
        self.status = {"state":"ready", "active_call":None, "last_call":None, "last_error_stage":None}
        self.call = None
        self.last_greeting = None
        self.http = None
        self.driver_lock = asyncio.Lock()
        self.tasks = set()
        self.stopping = False
        self.key = None
        self.key_source = None
        self.last_saved = 0.0
        self.status_queue = asyncio.Queue(maxsize=1)
        self.status_writer_running = False
        self.stop_event = asyncio.Event()
        self.ha_token = os.environ.get("SUPERVISOR_TOKEN") or os.environ.get("HA_TOKEN")
        self.ha_url = os.environ.get("HA_API_URL", "http://supervisor/core/api")
        self.ha_headers = {"Authorization": "Bearer " + (self.ha_token or "")}
        self.voice_task = None
        self.archive_tasks = set()

    def task(self, awaitable):
        task = asyncio.create_task(awaitable)
        self.tasks.add(task)
        def finished(done):
            self.tasks.discard(done)
            if not done.cancelled() and (error := done.exception()) is not None:
                self.log("background_task_failed", error_type=type(error).__name__)
        task.add_done_callback(finished)
        return task

    def save(self, force=True):
        now = time.monotonic()
        if not force and now - self.last_saved < 0.5:
            return
        self.last_saved = now
        self.status["updated_at"] = utc_now()
        if self.call and not self.call.closed:
            self.status["active_call"] = self.call.summary()
        else:
            self.status["active_call"] = None
        payload = dict(self.status)
        if self.status_writer_running:
            if self.status_queue.full():
                self.status_queue.get_nowait()
                self.status_queue.task_done()
            self.status_queue.put_nowait(payload)
        else:
            self.write_status(payload)

    def write_status(self, payload):
        if not isinstance(payload, str):
            payload = json.dumps(payload, indent=2)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.output_dir / "status.tmp"
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, self.output_dir / "status.json")

    async def status_writer(self):
        while True:
            payload = await self.status_queue.get()
            try:
                await asyncio.to_thread(self.write_status, payload)
            except Exception as exc:
                self.log("status_write_failed", error_type=type(exc).__name__)
            finally:
                self.status_queue.task_done()

    def archive_call(self, stamp, summary):
        # Only bounded counters and timings are retained, without identities or conversation.
        summary = {key: value for key, value in summary.items() if key != "call_id"}
        self.output_dir.mkdir(parents=True, exist_ok=True)
        (self.output_dir / ("call-metrics-" + stamp + ".json")).write_text(
            json.dumps(summary, indent=2), encoding="utf-8")
        reports = sorted(self.output_dir.glob("call-metrics-*.json"))
        for old in reports[:-20]:
            if old.is_file() and old.resolve().parent == self.output_dir.resolve():
                old.unlink()

    def log(self, event, **facts):
        # No audio, transcripts, caller IDs, pairing material, or API keys in app logs.
        print(json.dumps({"time": utc_now(), "event": event, **facts}), flush=True, file=sys.stderr)

    def load_key(self):
        self.key = None
        self.key_source = None
        entries = json.loads((self.config_dir / ".storage/core.config_entries").read_text(encoding="utf-8"))["data"]["entries"]
        try:
            registry = json.loads((self.config_dir / ".storage/core.entity_registry").read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise ValueError("Select a registered OpenAI conversation agent for voice calls") from None
        owners = {entity.get("config_entry_id") for entity in registry["data"]["entities"]
                  if entity.get("entity_id") == self.options.get("agent_id") and entity.get("config_entry_id")}
        if len(owners) != 1:
            raise ValueError("Select a registered OpenAI conversation agent for voice calls")
        matches = [entry for entry in entries
                   if entry.get("entry_id") in owners and entry.get("domain") == "openai_conversation"]
        if len(matches) != 1:
            raise ValueError("Voice calls require a conversation agent from the OpenAI integration")
        key = matches[0].get("data", {}).get("api_key")
        if not isinstance(key, str) or not key or len(key) > 4096:
            raise ValueError("The selected OpenAI integration has no API key")
        self.key = key
        self.key_source = "selected_agent"

    async def preflight(self):
        agent = await self.ha("/states/" + self.options["agent_id"])
        if agent.get("state") == "unavailable":
            raise ValueError("The selected conversation agent is unavailable")
        services = await self.ha("/services")
        if not any(domain["domain"] == "conversation" and "process" in domain.get("services", {})
                   for domain in services):
            raise ValueError("Home Assistant conversation.process is unavailable")
        return {"agent_service": "conversation.process", "openai_key_source": self.key_source}

    async def send_driver(self, command):
        call = self.call
        if not call or call.closed or command.get("call_id", call.call_id) != call.call_id:
            return
        async with self.driver_lock:
            emit({**command, "type": "command", "call_id": command.get("call_id", call.call_id)})

    async def shutdown(self):
        self.stopping = True
        if self.call and not self.call.closed:
            await self.handle_driver_event({"type": "call_ended", "call_id": self.call.call_id})
        if self.voice_task:
            with contextlib.suppress(asyncio.TimeoutError, asyncio.CancelledError, Exception):
                await asyncio.wait_for(asyncio.shield(self.voice_task), 4)
        if self.archive_tasks:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(asyncio.gather(*list(self.archive_tasks), return_exceptions=True), 2)
        if self.status_writer_running:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.status_queue.join(), 1)
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*list(self.tasks), return_exceptions=True)
        self.key = None
        if self.http:
            await self.http.close()

    async def ha(self, path, data=None):
        method = "POST" if data is not None else "GET"
        async with self.http.request(
            method, self.ha_url + path, headers=self.ha_headers,
            json=data, timeout=aiohttp.ClientTimeout(total=620 if data is not None else 10),
        ) as response:
            response.raise_for_status()
            return await response.json()

    async def call_limit(self, call):
        await asyncio.sleep(int(self.options.get("max_call_seconds", 300)))
        if self.call is call and not call.closed:
            self.log("call_time_limit")
            await self.send_driver({"action": "hangup"})

    async def input_audio_loop(self, call, ws):
        # Encoded Opus may stop sending during silence. GPT-Live still needs a paced PCM stream.
        await call.input_available.wait()
        deadline = time.monotonic()
        while self.call is call and not call.closed and not ws.closed:
            await asyncio.sleep(max(0, deadline - time.monotonic()))
            if self.call is not call or call.closed or ws.closed:
                break
            now = time.monotonic()
            if call.last_input_send is not None:
                call.max_input_send_gap = max(call.max_input_send_gap, now - call.last_input_send)
            call.last_input_send = now
            available = min(640, len(call.input_pcm))
            raw = bytes(call.input_pcm[:available]) + bytes(640 - available)
            del call.input_pcm[:available]
            call.input_sent_samples += 320
            call.input_silence_samples += (640 - available) // 2
            await ws.send_json({"type": "session.input_audio.append", "audio": base64.b64encode(raw).decode()})
            # Reset after a long scheduler stall instead of sending a microphone backlog in a burst.
            deadline += 0.020
            if deadline < time.monotonic():
                deadline = time.monotonic() + 0.020

    async def wait_for_call_audio(self, call):
        ready = asyncio.create_task(call.media_ready.wait())
        ended = asyncio.create_task(call.closed_event.wait())
        try:
            await asyncio.wait((ready, ended), return_when=asyncio.FIRST_COMPLETED)
        finally:
            ready.cancel()
            ended.cancel()
            await asyncio.gather(ready, ended, return_exceptions=True)
        return self.call is call and not call.closed and not self.stopping and call.media_ready.is_set()

    def greeting_input(self):
        text = self.options.get("greeting_text", "Hello! How can I help?").strip()
        if not text:
            return []
        if self.options.get("randomize_greeting", True):
            text = random.choice([greeting for greeting in OPENING_GREETINGS
                                  if greeting != self.last_greeting])
        self.last_greeting = text
        return [{"type": "message", "role": "developer", "content": [{
            "type": "input_text",
            "text": "The WhatsApp call is connected. Greet the caller immediately in the language "
                    "of this opening. Say this opening once: " + text[:300] +
                    " Then pause and listen. Use the caller's language after they speak.",
        }]}]

    def input_transcript(self, call, event):
        delta = event.get("delta", "")
        if not delta:
            return
        call.input_fragments.append(delta)
        start_ms, end_ms = event.get("start_ms"), event.get("end_ms")
        if start_ms is not None and call.last_input_end_ms is not None and start_ms - call.last_input_end_ms > 700:
            call.user_turn_text = ""
        call.user_turn_text += delta
        call.last_input_end_ms = end_ms if end_ms is not None else call.last_input_end_ms
        call.last_input_transcript_at = time.monotonic()
        call.input_version += 1
        # One detector request at a time. New speech never cancels its decision.
        if (self.options.get("automatic_hangup", True) and not call.ending
                and (not call.control_task or call.control_task.done())):
            call.control_task = self.task(self.check_call_control(call))

    async def check_call_control(self, call):
        while self.call is call and not call.closed and not call.ending and call.ws and not call.ws.closed:
            now = time.monotonic()
            await asyncio.sleep(max(0, CONTROL_SETTLE_SECONDS - (now - call.last_input_transcript_at),
                                    CONTROL_MIN_INTERVAL_SECONDS - (now - call.control_last_check)))
            if self.call is not call or call.closed or call.ending or not call.ws or call.ws.closed:
                return
            if time.monotonic() - call.last_input_transcript_at < CONTROL_SETTLE_SECONDS:
                continue
            version = call.input_version
            # Call control never waits for Home Assistant or an earlier spoken reply.
            call.control_checks += 1
            call.control_last_check = time.monotonic()
            request = decision_request("".join(call.input_fragments), "".join(call.output_fragments), call.user_turn_text)
            try:
                async with self.http.post("https://api.openai.com/v1/responses",
                    headers={"Authorization": "Bearer " + self.key}, json=request,
                    timeout=aiohttp.ClientTimeout(total=6)) as response:
                    response.raise_for_status()
                    body = await response.json()
                    latency_ms = round((time.monotonic() - call.control_last_check) * 1000, 2)
                    call.control_last_latency_ms = latency_ms
                    call.control_max_latency_ms = max(call.control_max_latency_ms, latency_ms)
                    usage = body.get("usage") or {}
                    call.control_input_tokens += usage.get("input_tokens", 0)
                    call.control_cached_input_tokens += (usage.get("input_tokens_details") or {}).get("cached_tokens", 0)
                    call.control_output_tokens += usage.get("output_tokens", 0)
                    call.control_reasoning_tokens += (usage.get("output_tokens_details") or {}).get("reasoning_tokens", 0)
                    decision = end_call_decision(body)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                call.control_errors += 1
                self.log("call_control_check_failed", error_type=type(exc).__name__)
                return
            if decision:
                await self.finish_conversation(call, decision["reason"])
                return
            # If speech arrived during a negative check, inspect the latest text next.
            if call.input_version == version:
                return

    async def finish_conversation(self, call, reason):
        if self.call is not call or call.closed or call.ending:
            return
        call.ending = True
        call.end_reason = reason
        if call.last_input_transcript_at:
            call.hangup_after_last_transcript_ms = round((time.monotonic() - call.last_input_transcript_at) * 1000, 2)
        self.log("conversation_finished", reason=reason)
        await self.send_driver({"action": "hangup"})

    async def voice(self, call):
        input_task = None
        opening = ("Open with the greeting in the initial developer message, then listen. "
                   if self.options.get("greeting_text", "Hello! How can I help?").strip()
                   else "Let the caller speak first, then respond. ")
        instructions = (
            "You are a helpful voice assistant on a WhatsApp phone call. "
            + opening + "Speak naturally and concisely "
            "in the caller's language. For ANY question about the home, its devices, sensors, "
            "scripts, personal information or actions, delegate to the existing Home Assistant "
            "agent. Do not invent device states or claim an action succeeded before the backend "
            "confirms it. Continue listening and allow natural interruptions. "
            "When the caller clearly ends the conversation or asks to hang up, keep any goodbye brief. "
            "The application disconnects immediately when it recognizes the request. "
            "Do not delegate greetings or goodbyes to Home Assistant."
        )
        try:
            # The controller releases decoded peer audio only after WhatsApp accepts
            # the call. Silence is enough; never wait for the caller to speak.
            if not await self.wait_for_call_audio(call):
                return
            async with self.http.ws_connect(
                "wss://api.openai.com/v1/live/sessions",
                headers={"Authorization": "Bearer " + self.key},
                heartbeat=20, max_msg_size=4 * 1024 * 1024,
            ) as ws:
                if self.call is not call or call.closed or self.stopping:
                    return
                call.ws = ws
                greeting = self.greeting_input()
                await ws.send_json({"type": "session.start", "session": {
                    "model": "gpt-live-1", "store": False, "instructions": instructions,
                    "input": greeting,
                    "audio": {"format": {"type": "audio/pcm", "rate": 16000},
                              "output": {"voice": self.options.get("voice", "marin")}},
                    "delegation": {"type": "client"},
                }})
                call.greeting_sent = bool(greeting)
                if greeting:
                    self.log("greeting_requested", method="startup_input")
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
                        continue
                    event = json.loads(msg.data)
                    kind = event.get("type")
                    if kind == "session.started":
                        call.voice_started = True
                        self.log("gpt_live_started")
                        if call.greeting_sent:
                            call.greeting_accepted = True
                            self.log("greeting_accepted", method="startup_input")
                        input_task = self.task(self.input_audio_loop(call, ws))
                        if call.closed:
                            await ws.send_json({"type": "session.close"})
                    elif kind == "session.output_audio.delta":
                        if self.call is call and not call.closed:
                            now = time.monotonic()
                            if call.last_output_audio is not None:
                                gap = now - call.last_output_audio
                                call.max_output_gap = max(call.max_output_gap, gap)
                                if gap >= 0.120:
                                    call.output_gap_events.append({"at_ms": round((now - call.created) * 1000),
                                                                   "gap_ms": round(gap * 1000)})
                            call.last_output_audio = now
                            raw = checked_pcm(event["delta"])
                            call.tx_samples += len(raw) // 2
                            await self.send_driver({"action": "audio", "call_id": call.call_id, "data": event["delta"]})
                    elif kind == "session.input_transcript.delta":
                        self.input_transcript(call, event)
                    elif kind == "session.output_transcript.delta":
                        call.output_fragments.append(event.get("delta", ""))
                    elif kind == "session.delegation.created":
                        self.task(self.delegate(call, event["delegation"]["id"]))
                    elif kind == "session.usage.updated":
                        call.voice_seconds = event.get("usage", {}).get("seconds")
                    elif kind == "session.closed":
                        call.voice_finalized = True
                        call.voice_seconds = event.get("usage", {}).get("seconds")
                        self.log("gpt_live_finalized", usage_seconds=call.voice_seconds)
                        break
                    elif kind == "error":
                        self.status["last_error_stage"] = "gpt_live"
                        self.log("gpt_live_error", code=event.get("error", {}).get("code"))
                        break
                    self.save(force=kind not in (
                        "session.output_audio.delta", "session.input_transcript.delta",
                        "session.output_transcript.delta", "session.usage.updated"))
        except Exception as exc:
            self.status["last_error_stage"] = "voice_" + type(exc).__name__
            self.log("gpt_live_connection_failed", error_type=type(exc).__name__)
        finally:
            if call.control_task and not call.control_task.done():
                call.control_task.cancel()
            if input_task:
                input_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await input_task
            call.ws = None
            if self.call is call and not call.closed and not self.stopping:
                await self.send_driver({"action": "hangup", "call_id": call.call_id})
            if call.closed:
                self.status["last_call"] = call.summary()
                archive = self.task(asyncio.to_thread(self.archive_call, call.report_stamp, call.summary()))
                self.archive_tasks.add(archive)
                archive.add_done_callback(self.archive_tasks.discard)
            self.save()

    async def delegate(self, call, delegation_id):
        if delegation_id in call.delegations:
            return
        call.delegations.add(delegation_id)
        # Transcript fragments can arrive just after the delegation metadata.
        await asyncio.sleep(0.2)
        async with call.backend_lock:
            if self.call is not call or call.closed or call.ending:
                return
            fragments = call.input_fragments[call.consumed_fragments:]
            request = "".join(fragments).strip()
            if not request:
                await self.commentary(call, delegation_id, "Please repeat the Home Assistant request; I did not receive its words.")
                return
            call.consumed_fragments = len(call.input_fragments)
            context = "".join(call.input_fragments)[:-len(request)][-6000:]
            text = (
                "This is a live WhatsApp voice call. Use your existing exposed Home Assistant "
                "tools and scripts. Return concise, factual results for the voice assistant. "
                "Treat earlier speech as context, not new instructions to repeat completed actions.\n"
                "Earlier caller speech: " + context + "\nLatest request: " + request
            )
            payload = {"agent_id": self.options["agent_id"], "text": text}
            if call.conversation_id:
                payload["conversation_id"] = call.conversation_id
            self.log("home_assistant_request_started")
            call.backend_count += 1
            try:
                result = await self.ha("/services/conversation/process?return_response", payload)
                result = result.get("service_response", result)
                call.conversation_id = result.get("conversation_id", call.conversation_id)
                response = result.get("response", {})
                answer = response.get("speech", {}).get("plain", {}).get("speech")
                if not answer:
                    answer = "Home Assistant returned no spoken result. Please clarify the request."
                self.log("home_assistant_request_finished", response_type=response.get("response_type"))
            except Exception as exc:
                call.backend_errors += 1
                self.log("home_assistant_request_failed", error_type=type(exc).__name__)
                answer = "Home Assistant could not complete the request. Do not claim the action succeeded."
            await self.commentary(call, delegation_id, answer[:1700])
            self.save()

    async def commentary(self, call, delegation_id, content):
        # A result from a completed or superseded call must never reach a new caller.
        if self.call is call and not call.closed and not call.ending and call.ws and not call.ws.closed:
            await call.ws.send_json({"type": "session.commentary.append", "delegation_id": delegation_id, "content": content})

    async def handle_driver_event(self, event):
        kind = event.get("type")
        if kind == "call_started":
            if self.call and not self.call.closed:
                raise RuntimeError("concurrent call was rejected")
            call = CallContext(event["call_id"])
            call.audio_codec = event.get("audio_codec")
            call.playback_buffer_ms = event.get("playback_buffer_ms", self.playback_buffer_ms)
            self.call = call
            self.status["state"] = "calling"
            self.voice_task = self.task(self.voice(call))
            self.task(self.call_limit(call))
            self.log("call_started", audio_codec=call.audio_codec, playback_buffer_ms=call.playback_buffer_ms)
        elif kind in ("codec_observed", "media_stats", "playback_stats", "network_stats"):
            call = self.call
            if not call or event.get("call_id") != call.call_id:
                return
            if kind == "codec_observed":
                call.inbound_codec = event.get("codec")
                self.log("inbound_codec_observed", codec=call.inbound_codec)
            elif kind == "media_stats":
                call.media_stats = event.get("stats")
            elif kind == "playback_stats":
                call.playback_stats = event.get("stats")
                call.transport_stats = event.get("transport_stats")
                # rtc-sctp's rtt() getter returns its retransmission timeout, not measured RTT.
                if isinstance(call.transport_stats, dict) and "sctp_rtt_ms" in call.transport_stats:
                    call.transport_stats = dict(call.transport_stats)
                    call.transport_stats["sctp_retransmit_timeout_ms"] = call.transport_stats.pop("sctp_rtt_ms")
                call.playback_history.append({"at_ms": event.get("at_ms"),
                                              "playback": call.playback_stats,
                                              "transport": call.transport_stats})
            else:
                stats = call.network_stats
                stats["outbound_media_dropped_packets"] += event.get("outbound_dropped_packets", 0)
                if "peer_loss_percent" in event:
                    stats["peer_report_count"] += 1
                    stats["max_peer_loss_percent"] = max(stats["max_peer_loss_percent"], event["peer_loss_percent"])
                    stats["max_peer_jitter_ticks"] = max(stats["max_peer_jitter_ticks"], event.get("peer_jitter_ticks", 0))
                    stats["max_peer_cumulative_lost"] = max(stats["max_peer_cumulative_lost"], event.get("peer_cumulative_lost", 0))
                    stats["last_peer_cumulative_lost"] = event.get("peer_cumulative_lost", 0)
                    point = {k: event[k] for k in ("at_ms", "peer_loss_percent", "peer_cumulative_lost", "peer_jitter_ticks")
                             if k in event}
                    sequence = event.get("peer_extended_highest_sequence")
                    if sequence is not None:
                        if call.last_peer_sequence is not None:
                            difference = (sequence - call.last_peer_sequence) & 0xffffffff
                            if difference < 1_000_000:
                                point["packets_expected_since_report"] = difference
                        call.last_peer_sequence = sequence
                    call.network_history.append(point)
        elif kind == "audio":
            call = self.call
            if not call or call.closed or event.get("call_id") != call.call_id:
                return
            raw = checked_pcm(event["data"])
            now = time.monotonic()
            if call.first_rx is None:
                call.first_rx = now
                call.media_ready.set()
                self.status["state"] = "in_call"
                self.log("peer_audio_started")
            if call.last_rx:
                call.max_rx_gap = max(call.max_rx_gap, now - call.last_rx)
            call.last_rx = now
            call.rx_samples += len(raw) // 2
            call.input_pcm.extend(raw)
            if len(call.input_pcm) > 64000:
                dropped = len(call.input_pcm) - 64000
                call.input_dropped_samples += dropped // 2
                del call.input_pcm[:dropped]
            call.input_available.set()
        elif kind == "call_event":
            self.log("call_media_event", media_event=event.get("event"))
            self.status["last_media_event"] = event.get("event")
        elif kind == "call_ended":
            if self.call and event.get("call_id") == self.call.call_id:
                self.call.closed = True
                self.call.closed_event.set()
                self.call.ended_at = time.monotonic()
                self.status["last_call"] = self.call.summary()
                self.status["active_call"] = None
                self.status["state"] = "ready"
                if self.call.ws and not self.call.ws.closed:
                    await self.call.ws.send_json({"type": "session.close"})
                self.log("call_ended", audio_seconds=self.status["last_call"]["audio_connected_seconds"])
        elif kind == "error":
            self.status["last_error_stage"] = event.get("stage")
            # Diagnostic details can contain private wire identifiers: keep them private.
            self.log("driver_error", stage=event.get("stage"))
        self.save(force=kind not in ("audio", "playback_stats", "network_stats", "media_stats"))


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


async def serve(network_allowed=False):
    reader = asyncio.StreamReader(limit=1024 * 1024)
    protocol = asyncio.StreamReaderProtocol(reader)
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin)
    bridge = None
    emit({"type": "ready", "protocol": 1})
    try:
        while line := await reader.readline():
            command = json.loads(line)
            if command.get("action") == "configure":
                if not network_allowed or bridge is not None:
                    raise ValueError("Live API connections are disabled or already configured")
                options = command["options"]
                bridge = Bridge(options, "/data/voice-metrics")
                bridge.load_key()
                if not bridge.ha_token:
                    raise ValueError("Home Assistant API authentication is missing")
                bridge.http = aiohttp.ClientSession()
                bridge.status_writer_running = True
                bridge.task(bridge.status_writer())
                configured = await bridge.preflight()
                emit({"type": "response", "id": command.get("id"), "ok": True, "result": configured})
            elif command.get("action") == "shutdown":
                if bridge:
                    await bridge.shutdown()
                    bridge = None
                emit({"type": "response", "id": command.get("id"), "ok": True, "result": {}})
                break
            elif bridge:
                await bridge.handle_driver_event(command)
            else:
                raise ValueError("Voice worker has not been configured")
    finally:
        if bridge:
            await bridge.shutdown()
        transport.close()


if __name__ == "__main__":
    try:
        asyncio.run(serve("--allow-network" in sys.argv[1:]))
    except Exception:
        print("Voice bridge stopped after an operation failed.", file=sys.stderr)
        sys.exit(1)
