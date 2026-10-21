# Shared-session WhatsApp calling

Voice calling ships inside the WhatsApp app. Baileys 6.7.23 continues to own
linked devices, authentication, Signal sessions, messaging, and the signaling
WebSocket. The voice adapter uses the selected account's existing socket and
Signal repository. A Rust child process supplies call stanzas, relay transport,
and audio; a Python child bridges audio to GPT-Live and the selected Home
Assistant OpenAI conversation agent.

For setup, settings, call actions, recording, and upgrades, see the
[voice call guide](../../docs/examples/voice-calls.md).

## Components

| Component | Responsibility |
| --- | --- |
| Parent messaging runtime | Account persistence, pairing, messaging API, media, discovery, and events |
| `app.js` | Adds voice routes and attaches the call adapter to one configured account |
| `calls.js` | Call lifecycle, Baileys crypto, device lookup, signaling, and worker isolation |
| `native/src/signaling.rs` | Call stanza builders and incoming offer parsing |
| `native/src/media.rs` | Native relay, Opus/MLOW, media encryption, playback, and transport metrics |
| `native/src/recording.rs` | Bounded recording queue, timed mixing, and background WAV writes |
| `recordings.js` | Retention, completed-file listing, and protected download access |
| `bridge/bridge.py` | GPT-Live audio, startup greeting, and `conversation.process` delegation |
| `bridge/call_control.py` | Contextual goodbye detector for immediate hang-up |
| `routes.js` | Authenticated call actions and Home Assistant ingress UI |

The Rust worker does not create a WhatsApp client, read Baileys credentials,
pair a device, open a WhatsApp signaling WebSocket, or maintain a Signal store.
It receives temporary media keys and per-call parameters over private child
pipes. It never receives Home Assistant or OpenAI credentials. The Python
bridge resolves the key belonging to the selected OpenAI conversation entity;
ambiguous ownership or a missing key fails closed.

Audio encoding and playback stay in the Rust worker. The Node adapter forwards
bounded audio messages without doing audio processing. Child processes terminate
when their parent closes the pipes. A voice failure ends the current call
without logging out or restarting the messaging socket.

Only one direct audio call runs at a time. The caller allowlist is exact and
empty answers nobody. Voice setup is optional. Fresh pairing and saved sessions
continue through the normal messaging runtime.

## Greeting, playback, and hang-up

The GPT-Live startup request waits for the WhatsApp call to connect and decoded
peer audio to arrive, including silence. The greeting is a developer message in
`session.input` of `session.start`, following the
[documented startup greeting](https://developers.openai.com/api/docs/guides/live-conversations#greet-before-the-caller-speaks).
Continuous microphone input starts after `session.started`. Ended ringing calls
do not request a greeting. A per-call opening message overrides the configured
greeting only for that call.

Playback uses an initial 180 ms cushion by default, source-clock correction,
and bounded recovery from brief shortages. The recording writer observes the
actual incoming and outgoing media through a bounded queue; it does not add a
playback buffer. Slow storage stops recording rather than waiting in media tasks.

A separate small model detects a clear final goodbye in context. A confirmed
hang-up disconnects immediately, without waiting for farewell playback or
cancelling if the caller speaks again. Unclear intent or detector failure keeps
the call open. Logs and bounded numeric reports omit conversations and audio.

## Offline tests

From `whatsapp_addon`, run `npm ci --ignore-scripts --no-audit --no-fund` and
`npm test`. This runs both messaging and voice Node tests. From the repository
root, run the Home Assistant integration suite with `pytest`.

Install `voice/requirements.txt` plus PyYAML in a Python environment, then run:

```powershell
python -m unittest discover -s whatsapp_addon/voice/test -p 'test_*.py' -v
```

Build the production image from the normal app directory. It runs native Rust
tests before packaging the worker:

```powershell
docker build --tag whatsapp-addon:local whatsapp_addon
./whatsapp_addon/voice/test/image-tests.ps1 -Image whatsapp-addon:local
```

The image tests disable networking and use synthetic keys, callers, audio,
Supervisor, and API responses. They check the real native/Baileys Signal
exchange, authentication, offline startup, health probes, and clean shutdown.
The explicit `--offline-simulation` startup argument creates no WhatsApp socket,
OpenAI connection, pairing notification, or voice worker. It is a test argument,
not a user configuration switch. Both workers also require `--allow-network`
before live API or media startup.

CI builds and smoke-tests both supported architectures and checks AppArmor on
amd64. Keep compiled artifacts, extracted binaries, recordings, and databases
outside the repository.

## Native dependency

The Rust call implementation is pinned to
`oxidezap/whatsapp-rust` revision
`0dc38af07632f48f0cf6c66df285f1643fc22b95`. `Cargo.lock` fixes dependency
resolution. Guarded patches preserve queued relay frames, add privacy-safe
transport counters, and enable Opus repair settings. They fail the build if
upstream source no longer matches the expected version. The existing Baileys
package and lockfile dependencies are unchanged.

The upstream MIT notice is preserved in `licenses/whatsapp-rust.txt` and included
in the runtime image.
