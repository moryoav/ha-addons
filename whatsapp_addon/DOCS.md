# Home Assistant Add-on: WhatsApp

This add-on runs a local WhatsApp Web bridge for Home Assistant. The companion
WhatsApp integration provides account devices, status sensors, actions, and
diagnostics. Install both parts to send messages and build automations from
incoming message, receipt, call, contact, and presence events. Voice calling
connects WhatsApp audio to GPT-Live and your Home Assistant OpenAI agent.

Supported architectures are `aarch64` and `amd64`.

## Getting started

Follow the [installation guide](../README.md#installation) to install the
add-on and integration.

1. Start the add-on and select **Open Web UI** on its Home Assistant page.
2. Scan the pairing QR code with WhatsApp on your phone, or use **Link with phone
   number** in the web UI. The initial Home Assistant notification keeps the QR
   code and includes an **Open pairing page** link.
3. Add **WhatsApp** under **Settings > Devices & services**. Supervisor discovery
   supplies the local API address and automatically managed credential.
4. Use the configured session name, `default` unless changed, as `clientId`
   in Home Assistant actions.

## Configuration

The add-on options are:

- `clients`: one or more unique WhatsApp session names. The default is
  `default`. A name must match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`.

The app manages its internal API credential automatically. It is saved privately
and supplied to the integration through Supervisor discovery.

Each session name becomes the `clientId` used by Home Assistant actions. Every client has its own persisted WhatsApp pairing state under the add-on data folder.

### Add another WhatsApp session

Open the add-on configuration page and add another value under `clients`. Use
that value as the `clientId` in Home Assistant actions. Empty lists, duplicates,
invalid characters, and names longer than 64 characters are rejected before
any session directory is created.

### Voice call options

Expand **Voice calls** in the configuration. Calls reuse the selected account's
existing WhatsApp login. Leave the calling account and agent empty for messaging
only. Update both the app and HACS integration to use the new calling actions.

| Option | Default and purpose |
| --- | --- |
| `calling_account` | Empty. Choose one account ID already listed in `clients`, such as `default`. Only that account gains AI calling. |
| `allowed_callers` | Empty. Exact WhatsApp user JIDs ending in `@lid` or `@s.whatsapp.net` that may call the assistant. Empty answers nobody. |
| `agent_id` | Empty. The `conversation.*` entity from the Home Assistant OpenAI integration. Its API key and Assist permissions are used. |
| `voice` | `gleam`. Select from 22 GPT-Live voices. |
| `max_call_seconds` | `300`, from 60 to 900 seconds including setup. |
| `greeting_mode` | `random`. Use a random short greeting, `fixed` text, or `disabled`. Greeting waits for the call's audio connection. |
| `greeting_text` | Empty. Text to use in fixed mode, up to 300 characters. |
| `automatic_hangup` | `true`. A small OpenAI model detects a clear final goodbye and disconnects immediately. |
| `record_calls` | `false`. Save both voices in a local WAV file using a background writer. |
| `recording_retention_days` | `30`, from 1 to 365 days. Applies to existing recordings too. Cleanup continues when recording is disabled. |
| `advanced.audio_codec` | `opus`. Tested default; `mlow` is Meta's low-bandwidth speech codec. Compare them on your connection if needed. |
| `advanced.playback_buffer_ms` | `180`, from 120 to 1500 ms. Initial adaptive playback cushion. Larger values add delay. |

The app reads the API key belonging to the selected OpenAI conversation agent
through a read-only Home Assistant configuration mount. No extra key or custom
conversation service is configured. Home requests use `conversation.process`.
GPT-Live and goodbye detection use the OpenAI API and incur API charges.

Only one direct audio call runs at a time. Open the web UI for calling status
and completed recordings. Recordings are also in
`/media/whatsapp/call-recordings`; shared media permissions and backups apply.

See the [voice call guide](https://moryoav.github.io/ha-addons/examples/voice-calls/)
for setup, `whatsapp.make_call` and `whatsapp.hang_up`, optional per-call opening
messages, recordings, upgrade instructions, and troubleshooting.

### Incoming media options

- `download_media`: `false` by default. Save incoming attachments automatically
  and enrich their message events. Applies to all configured sessions and chats.
- `media_retention_hours`: `24` by default, from 1 to 720 hours. Expiry is set
  when each file completes; changes affect new downloads. Cleanup continues
  while downloads are disabled and catches up after an add-on restart.
- `media_max_file_mb`: `64` by default, from 1 to 1024 MiB per attachment.
- `media_max_storage_mb`: `1024` by default, from 1 to 102400 MiB of attachment
  content. Must be at least `media_max_file_mb`. New downloads are rejected
  when the budget is full; unexpired files are not removed to make room.

### Logging options

- `log_level`: `info` (the default) for normal operation, or `debug` for
  additional privacy-safe runtime diagnostics while investigating a problem.

Detailed decryption tracing is disabled. Supplemental [own-device LID delivery
receipts](#lid-sender-receipts) are always enabled for every account. Neither
behavior has a configuration switch; old saved switch values are ignored.

## Web UI

Follow **Open pairing page** in the pairing notification, or select **Open Web
UI** on the add-on page. Home Assistant handles access through Ingress using
your current Home Assistant address. While an account is waiting for pairing,
the app opens on its pairing page. Otherwise it opens on **WhatsApp calls**,
which links back through **Messaging and pairing**; the pairing page links to
**WhatsApp calls**. The pairing page shows each configured account, its
connection state, and the current pairing QR code.

To pair using your phone number:

1. Select **Link with phone number** for the unpaired account.
2. Enter the WhatsApp account's phone number including the country code.
   A leading `+`, spaces, parentheses, and hyphens are accepted.
3. Select **Generate pairing code**. The eight-character code appears on the
   page and replaces the QR image in the existing notification.
4. On your phone, open WhatsApp and select **Linked devices > Link a device >
   Link with phone number instead**. Enter the displayed code.

Use **Use QR code** to cancel phone pairing and obtain a fresh QR code. When
the connection changes, the old code is cleared. If WhatsApp rejects a code,
enter your number again and request a new one, waiting 30 seconds between code
requests. A request that fails can be retried right away. Pairing requests are
independent for each configured account. Saved accounts reconnect normally
without another pairing request.

Pairing codes and QR images are private credentials. They are available in the
protected web UI and Home Assistant notification, and are excluded from logs,
diagnostics, and the integration's status API.

## Decrypted incoming media

Enable **Download incoming media** in the add-on configuration, save, and
restart the add-on. Incoming images, audio, voice notes, videos, documents,
and stickers are decrypted into unique
files under `/media/whatsapp`. Their existing `new_whatsapp_message` event
includes `media.status`, `media.local_path`, `media.url`, MIME type, size, and
expiry after the file is ready and verified. Failed downloads still deliver
the message with an error code.

Use these files in Home Assistant OCR, transcription, or document-processing
automations.
See the [full incoming media guide](https://moryoav.github.io/ha-addons/examples/incoming-media/)
for event examples, authenticated access, limits, and troubleshooting.

## Action examples

I keep the examples in the [WhatsApp knowledge base](https://moryoav.github.io/ha-addons/).

- [Messages and media](https://moryoav.github.io/ha-addons/examples/messages/): text, stickers, documents, videos, polls, voice messages, locations, and reactions.
- [Recipients and number lookup](https://moryoav.github.io/ha-addons/examples/recipients/): identifiers, registration checks, saved contacts, profiles, and group lists.
- [Presence](https://moryoav.github.io/ha-addons/examples/presence/): subscriptions, online notifications, and typing indicators.
- [Automations](https://moryoav.github.io/ha-addons/examples/automations/): calls, logging, replies, read markers, sensor alerts, and local webhooks.
- [Reusable scripts](https://moryoav.github.io/ha-addons/examples/scripts/): send responses, quoted follow-ups, and saved message keys.
- [Decrypt incoming media](https://moryoav.github.io/ha-addons/examples/incoming-media/): setup, authenticated files, retention, and attachment processing.
- [Incoming messages and agents](https://moryoav.github.io/ha-addons/examples/incoming-messages/): chat filters, text extraction, and conversation replies.
- [AI-written notifications](https://moryoav.github.io/ha-addons/examples/ai-notifications/), [conversation history](https://moryoav.github.io/ha-addons/examples/conversation-history/), and [sensor charts](https://moryoav.github.io/ha-addons/examples/sensor-charts/): notification wording, stored context, and chart alerts.

## Events

| Event type                      | Description                                             |
| ------------------------------- | ------------------------------------------------------- |
| new_whatsapp_message            | The message that was received                           |
| whatsapp_message_sent           | An outgoing message reported by the connected session   |
| whatsapp_message_status         | A sent message was delivered, read, or played           |
| whatsapp_chat_read              | Received messages were read on another device           |
| whatsapp_call_update            | An incoming call lifecycle update                       |
| whatsapp_call_log               | One record per finished incoming or outgoing call       |
| whatsapp_presence_update        | Presence of contact in a chat updated                   |
| whatsapp_contacts_sync          | Contact names and identifiers supplied by WhatsApp      |
| whatsapp_send_message_result    | Result event fired after sending a message              |
| whatsapp_addon_health_failure   | Sanitized details after the prior run ended unhealthy   |

### Message events

`new_whatsapp_message` and `whatsapp_message_sent` event data includes the
configured `clientId`, the detected message `type`, the Baileys `key`, and the
`message` payload. Other fields, such as `messageTimestamp`, are passed through
when present. The dedupe layer runs before either event is fired and tracks
each direction separately. Media dedupe ignores wrapper-only fields such as
thumbnails, CDN paths, scan sidecars, and media key timestamp representation
because WhatsApp can vary those between phone-number and LID deliveries of the
same message.

`whatsapp_message_sent` fires for messages with
`key.fromMe: true` reported by the connected session. This includes messages
sent from the phone, other linked devices, and the add-on itself. The
`key.remoteJid` is the destination chat or group and can be a LID. This event
does not confirm delivery or that the recipient has read the message.

The add-on sends this event directly to Home Assistant. Logging automations
can listen to both message events; see the
[logging example](https://moryoav.github.io/ha-addons/examples/automations/#log-received-and-sent-messages).
Keep reply and mark-as-read automations on `new_whatsapp_message` so they do not
act on outgoing messages.

### Chat archive state

`new_whatsapp_message` includes `chat_archived`:
`true` (archived), `false` (unarchived), or `null` (unknown). It uses the latest
locally cached chat state, with no extra network request per message. Known
flags survive restarts and are updated by WhatsApp synchronization. Existing
chats remain unknown until WhatsApp supplies their state.
`whatsapp_message_sent` includes the same field for the destination chat,
using the same cache and values. See the
[archive-state details and automation condition](https://moryoav.github.io/ha-addons/reference/events/#chat-archive-state).

### Poll votes

The event for a poll vote
(`type: pollUpdateMessage`) includes a `poll_vote` object with `status`,
`poll_id`, `poll_name`, and `selected_options`, the names of the options the
voter has selected now. An empty list means the vote was withdrawn. WhatsApp
encrypts votes with a secret carried only by the poll's own message, so the
add-on keeps the secret, question, and option names of the newest 100 polls per
account for 30 days alongside the session data. Remembered polls survive
restarts and are cleared when the session is reset or logged out. A vote on a
poll the add-on does not have still fires, with `poll_vote.status: error` and
`poll_vote.error: unknown_poll`. See the
[poll vote fields and limits](https://moryoav.github.io/ha-addons/reference/events/#poll-votes)
and the [automation example](https://moryoav.github.io/ha-addons/examples/messages/#react-to-a-poll-vote).

### Contact metadata

`whatsapp_contacts_sync` forwards the contact records WhatsApp supplies,
including available names, LIDs, and phone identifiers. Each batch includes
its account ID and original Baileys event source. See the
[contact event reference](https://moryoav.github.io/ha-addons/reference/events/#contact-metadata)
for fields, partial updates, and delivery limits.

### Receipt events

`whatsapp_message_status` fires when a message this account sent, from Home
Assistant or the phone, is delivered, read, or played. Its data contains
`clientId`, `messageId`, `chatId`, `status` (`delivered`, `read`, `played`, or
`error`), `participant`, and `timestamp`. `messageId` matches the `message_id`
returned by `whatsapp.send_message`. In a direct chat, `participant` and
`timestamp` are `null`. In a group, every member's receipt is a separate event,
with `participant` set to that member and `timestamp` to the receipt time;
WhatsApp reports a voice message played in a group as `read`. Recipients who
turned off read receipts only produce `delivered`. Receipts for status updates
(stories) are not reported.

`whatsapp_chat_read` fires when this account reads or plays received messages on
another device, such as the phone. Its data contains `clientId`, `chatId`,
`status` (`read`, or `played` for voice messages), and `messageIds`, the IDs of
the received messages that were read. A large batch is split across several
events of at most 100 IDs. Check `messageIds` for the message you care about,
for example to dismiss its Home Assistant notification once you have read it on
the phone.

See the
[unread-alert escalation](https://moryoav.github.io/ha-addons/examples/automations/#escalate-when-an-alert-is-not-read) and
[notification dismissal](https://moryoav.github.io/ha-addons/examples/automations/#dismiss-a-notification-after-reading-the-chat-on-the-phone)
examples.

### Call events

`whatsapp_call_update` fires for each lifecycle update reported by Baileys. Its
`status` is one of `offer`, `ringing`, `accept`, `reject`, `timeout`, or
`terminate`. The stable event data contains `clientId`, `callId`, `status`,
`from`, `chatId`, `isVideo`, `isGroup`, `groupJid`, `date`, and `offline`;
fields omitted by Baileys are represented as `null`. Caller and chat identifiers
may use `@lid` and are not guaranteed to contain a phone number. The add-on
preserves the observed update order and retries transient delivery failures for
a 33-second backoff window when Home Assistant Core is unavailable. Baileys
updates can still be missing or arrive after a reconnect, so automations should
filter the desired status without assuming a complete lifecycle.

For a call answered on the phone or another device, `accept` is followed almost
immediately by `terminate`: the call stopped ringing on the add-on's linked
device, not the end of the call. WhatsApp sends a linked device nothing more
about an answered call, so there is no update when it ends. `ringing` can fire
once for each of your devices; trigger on `offer` to act once per call.

The `whatsapp.reject_call` action declines an
incoming call using the `callId` and `from` values of its `offer` event. See the
[night-time example](https://moryoav.github.io/ha-addons/examples/automations/#decline-calls-at-night-and-reply-with-a-message).
Calls made from the phone are not reported as call events;
`whatsapp_call_log` reports them after they end.

### Call log events

`whatsapp_call_log` fires once for each finished call, in either direction.
Its data contains `clientId`, `callId`, `direction` (`incoming` or `outgoing`),
`result`, `isVideo`, `durationSeconds`, `startedAt`, `peer`, `participants`,
and `groupJid`. `peer` is the other person's phone JID or LID.

- **Outgoing calls** made from the phone come from the call history the phone
  shares with the add-on, usually about 15 seconds after the call ends.
  `result` is WhatsApp's own outcome: `connected`, `missed`, `rejected`,
  `cancelled`, `unavailable`, `failed`, `abandoned`, `accepted_elsewhere`,
  `invalid`, or `unknown`. `durationSeconds` is the call length, and
  `participants` lists each called person as `{jid, result}`.
- **Incoming calls** are followed through their `whatsapp_call_update` events
  and reported when they stop ringing. `result` is `answered`, `declined`
  (rejected on a device or with `whatsapp.reject_call`), or `missed`.
  `durationSeconds` is always `null` and `participants` is empty, because
  WhatsApp does not tell a linked device when an answered call ends or who
  else joined it.

Calls are reported only while the add-on is connected, and only once per
`callId`. An incoming call whose `offer` the add-on did not see, or whose ending
does not arrive within 10 minutes, is not reported. See the
[missed-call example](https://moryoav.github.io/ha-addons/examples/automations/#notify-about-missed-calls).

### Health events

`whatsapp_addon_health_failure` includes its schema and service, a run id,
first and last failure timestamps, failure count and streak, the bounded failure
classification, HTTP and curl result, probe timings, and any available bounded
process or container metrics. It contains no message contents, account
identifiers, URLs, headers, tokens, or raw response bodies.

Isolated libsignal `Bad MAC`, message-counter, and session lifecycle console
logs are filtered and summarized as counts instead of exposing full stack
traces or session data. A confirmed high-volume decryption failure burst
activates the [recovery pause](#encryption-recovery).

## Security and network access

The add-on exposes no Home Assistant LAN port. Home Assistant Ingress is enabled
for the add-on web UI, and the web UI listener only accepts the Supervisor
ingress proxy address. QR pairing is shown in the add-on web UI and through Home
Assistant persistent notifications.

The add-on includes a custom AppArmor profile. Its trusted base-image bootstrap
uses the standard Home Assistant startup permissions, then the network-facing
Node bridge runs in a restricted child profile where packaged files are
read-only and writes are limited to temporary files, persistent session data,
and generated attachments under `/media/whatsapp`. The
add-on uses the default Supervisor API role.
A native container health check calls the local `/health` endpoint after
startup.

The shared `/media` mount makes decrypted files available to Home Assistant.
Download links require Home Assistant authentication, including for documents.
The files are not published through `/local` or an unauthenticated add-on port.

Protected API requests require `Authorization: Bearer <token>`. The app
generates a random credential on first startup and stores it privately under
its persistent data directory. It is retained across restarts and app updates.
An existing configured credential is adopted during migration when available.
The integration receives the credential through Supervisor discovery and
applies changes automatically. No token field or manual copy is needed.
Keep internal credentials private when collecting support information.

API startup fails if the saved credential cannot be read or created; it does
not silently disable authentication. The app's matching integration build
should be installed so discovery updates are applied automatically.

The `/health` route remains unauthenticated so container monitoring can use it.
Its response is deliberately limited to a non-sensitive status, the service
identifier `ha-whatsapp-addon`, API version, supported capabilities, and
configured-client count. It contains no token, add-on URL, recipient id,
session data, or message content.

## Privacy

WhatsApp events and Home Assistant automation traces can contain phone JIDs,
LIDs, call and message keys, quoted-message data, contact names, and message
bodies. Saved media files can also contain private information. Redact these fields, QR images, pairing codes, session data, and
internal API credentials before sharing diagnostics, logs, screenshots, or traces.

## Troubleshooting and diagnostics

### Debug and health diagnostics

Set `log_level` to `debug` and restart the add-on when investigating an
intermittent failure. Debug mode periodically summarizes event-loop
responsiveness, process and container resource use, API activity, health state,
reconnects, and aggregate message and call handling. It does not enable raw
Baileys logs or include message content, raw account identifiers, QR images, pairing codes,
session data, or API tokens. Identifier-related entries use run-scoped one-way
references for correlation. Return the option to `info` after collecting the
relevant logs.

Debug mode also logs WhatsApp app-state sync: the
collection names in each `server_sync` notification, resync progress, the kind
of each synced change, and a summary of any call-history entry the phone
shares. A call-history summary contains the call result, direction, video flag,
duration, start time, and whether the caller and participants are the linked
account, with identifiers replaced by one-way references. These entries show
how calls made from the phone reach a linked device.

Detailed decryption tracing is disabled. Its instrumentation remains commented
out in the source for future debugging. Normal debug logging and recovery
protection remain active.

After each connection the add-on logs how many offline messages WhatsApp
announced and delivered. If WhatsApp has not finished sending them one minute
after the connection opened, a warning is logged instead. Until WhatsApp
finishes, new messages can wait on the server until the next reconnect. These
lines contain counts only.

Failed native health checks are recorded in a small persistent history even at
the default `info` level. If Supervisor replaces an unhealthy container, the
next run replays the retained probe result and surrounding runtime state into
the add-on log. Include those replayed lines, with any surrounding private Home
Assistant data redacted, when reporting an unhealthy-container problem.

When that history ends with three consecutive failed probes, the next
successful run fires a silent `whatsapp_addon_health_failure` Home Assistant
event at either log level. In `debug` mode only, it also creates a persistent
notification with the same sanitized summary. The notification uses a fixed id
so later incidents update it instead of creating a stack of alerts. Normal
`info` operation never creates this health notification. Recovered and
shorter-lived probe failures do not trigger either report.

The add-on keeps a separate in-memory retry cache, even when diagnostics are off.
It stores original outgoing messages, including successfully decoded copies from
other linked devices, before Home Assistant event processing modifies them.
Baileys can retrieve these messages by exact conversation and message ID for its
existing retry mechanism; this does not rerun Home Assistant actions. The cache
does not guess phone-number/LID aliases or return a message from another account.
Each client retains up to 1,000 messages for four hours, with a 16 MiB serialized
data budget and a 1 MiB per-message limit. Older entries are evicted when a limit
is reached. Ordinary socket reconnects retain the cache; stopping the client,
logging out, entering recovery pause, or restarting the add-on clears it. Nothing
is written to disk. The protective recovery pause is enabled.
The cache improves retry support but is not a confirmed fix for
decryption storms.

### Encryption recovery

If the add-on detects a sustained burst of repeated libsignal decryption
failures, it pauses every WhatsApp client to protect the host from a
resource-consuming loop. The health endpoint and Ingress UI remain available,
and Home Assistant creates one persistent notification directing the user to the
Web UI. The privacy-safe pause marker survives an add-on or host restart.

The recovery panel offers two choices:

- Retry connection clears the pause and reconnects once with all saved
  sessions unchanged. If the decryption storm returns, the clients pause again.
- Reset and re-pair deletes only the selected client's local pairing session.
  You must type its client ID to confirm. Remove the old add-on entry from
  WhatsApp Linked Devices, then pair again using the app's QR or phone-number option.

Because the upstream error does not identify the responsible configured
client, detection pauses all clients. Normal action requests for a paused
client return the `client_recovery_paused` error until Retry or Reset and
re-pair is started. This recovery mode contains the failure but does not fix
the underlying upstream encryption problem.

### LID sender receipts

Supplemental own-device LID delivery receipts are always enabled for every
account. This handling addresses the receipt-routing and replay behavior from
[issue #7](https://github.com/moryoav/ha-addons/issues/7); it does not fix every
possible upstream decryption failure.

The app matches a direct encrypted own-device LID stanza to
its successfully decrypted message and sends a supplemental `sender` delivery
receipt to the originating device with the original recipient. This bypasses
the LID-specific receipt-routing problem without modifying or upgrading
Baileys. The existing Baileys receipt is not intercepted. These are not read
receipts and do not mark chats as read.

The supplemental receipt follows the same rule as the Baileys receipt it
corrects: it covers every successfully decrypted payload, including edits,
deletions, reactions and other control messages, because a misrouted receipt
leaves any of them pending for replay. A redelivered copy, or the fresh copy a
device sends in answer to a retry request, is acknowledged once that copy
decrypts, so a message that was already stuck can still leave the server queue.

A message the add-on already decrypted can never be decrypted again, because
its keys are used. If WhatsApp sends it again, for example after a reconnect,
the add-on answers the copy with the same receipt and does not pass it to
Baileys.

The receipt handling excludes groups, broadcasts, newsletters, peer synchronization
traffic, other people's incoming messages, failed or partial decryptions, and
local sends without a matching incoming stanza. If two of the account's devices
ever present the same message ID, the match is skipped rather than guessing a
device. It never acknowledges a message the add-on could not decrypt at least
once, resets sessions, changes encryption state, or weakens the protective
recovery pause.

Tracking is in-memory and per socket: at most 1,024 metadata records with a
five-minute expiry, at most 1,024 queued receipts, and one network write at a
time. No plaintext or ciphertext is read or retained by this tracking cache.
Disconnect, logout, reset, or socket replacement discards the tracking state.
Write errors are contained; there is no additional automatic receipt-retry loop.

The list of own messages already decrypted is also kept in memory. It holds only
account, chat and message IDs and the sending device, at most 2,048 entries for
24 hours. It survives reconnects. Stopping or restarting the add-on, logout,
recovery and reset clear it.

Detailed decryption tracing is disabled, including receipt outcome logging.
Normal runtime health, retry caching, offline-sync monitoring, and the recovery
pause remain active. Receipt handling does not clear an existing recovery pause;
use the existing Retry or Reset and re-pair controls when needed.

## Support and issues

For help, start with the root [README](../README.md), [SUPPORT](../SUPPORT.md), and [CHANGELOG](../CHANGELOG.md). If you find a bug, open an issue on GitHub and include the add-on version, Home Assistant version, add-on logs with secrets redacted, and the relevant automation or action payload.

## License

This add-on is published under the Apache License 2.0. See the repository [LICENSE](../LICENSE) file for the full license text.
