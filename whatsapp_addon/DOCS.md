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
2. Choose the account and open **Connection**. Scan the pairing QR code with
   WhatsApp on your phone, or select **Link with code** to pair using your phone
   number. A persistent notification also includes the QR code and a link to
   this workspace.
3. Add **WhatsApp** under **Settings > Devices & services**. Supervisor discovery
   supplies the local API address and automatically managed credential.
4. Use the configured session name, `default` unless changed, as `clientId`
   in Home Assistant actions.

## Configuration

Configure WhatsApp accounts with:

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

### Persistent inbox

- `inbox_clients`: empty by default. Add account IDs from `clients` to retain
  incoming messages while Home Assistant is unavailable and replay them
  through `new_whatsapp_message` once the integration is ready.

Existing automations need no changes. Removing an account from this list
pauses its queued delivery; stored messages remain until the account is
enabled again. See [Recover incoming messages after a restart](https://moryoav.github.io/ha-addons/examples/reliable-incoming-messages/)
for setup, storage limits, and delivery guarantees.

### Logging options

- `log_level`: `info` (the default) for normal operation, or `debug` for
  additional privacy-safe runtime diagnostics while investigating a problem.

Detailed decryption tracing is disabled. Supplemental [own-device LID delivery
receipts](#lid-sender-receipts) are always enabled for every account. Neither
behavior has a configuration switch; old saved switch values are ignored.

## Web UI

Open the add-on page and select **Open Web UI**. The shared account workspace
uses Home Assistant Ingress and adapts to desktop and phone. Every account's
connection state remains visible while you move between **Connection**,
**Calls**, and **Recordings**. Existing links to the old `/voice/` page open
the Calls view in this workspace.

### Connection and pairing

Select an account to see its connection status and available features. When
it needs pairing, **Connection** shows the current QR code and instructions
for **WhatsApp > Linked devices > Link a device** on your phone. Keep the page
open while linking. The QR code changes as the WhatsApp runtime provides a new
one and disappears once the account connects.

To pair without scanning, select **Link with code** and enter the WhatsApp
account's phone number with its country code, such as `+1 202 555 0123`. This
number is separate from the configured account ID, such as `default`.
Request a code, then enter the displayed eight-character code in WhatsApp under
**Linked devices > Link a device > Link with phone number instead**.
Keep the page open while linking. If the code expires, request a new one.
Successful code requests are limited to one per account every 30 seconds;
failed requests can be retried without waiting for that cooldown.

Select **Scan QR code** to abandon the code and start fresh QR pairing.
Pairing codes are shown only in the authenticated workspace and pairing
notification. They are cleared after linking or disconnection and kept out of
the integration status API, logs, and diagnostics. Treat both codes and QR
images as private. Existing linked accounts keep their saved sessions.

Recovery controls appear when the runtime pauses accounts after repeated
encryption failures. **Retry connection** reconnects with the saved sessions.
**Reset and re-pair** deletes only the selected client's local session and
requires typing its exact client ID. These are recovery controls, rather than
a routine reconnect action for an otherwise connected account. See
[Encryption recovery](#encryption-recovery) before resetting a session.

### Calls

Select the account configured under **Voice calls > Calling account**, then
open **Calls**. Enter a phone number with its country code or a WhatsApp user
ID. You can add an opening message for this call before selecting **Call**.
The configured Home Assistant agent handles the conversation.

Only the selected calling account gains voice controls, and only one direct
audio call can run at a time. Other accounts keep their messaging behavior.
The active-call bar identifies the calling account and keeps **Hang up**
available when you change views, select another account, or scroll through
recordings. Settings remain in the add-on's **Configuration** page.

### Recordings

Open **Recordings** under the calling account to browse completed recordings,
search by date, play or seek audio, download WAV files, and check their expiry.
Recording must be enabled in **Configuration** to save new calls. Existing
recordings remain available until they expire, even when recording is off.

The library contains the add-on's saved recordings, including files from a
previous calling account if that selection has changed. Existing recording
metadata contains the date, duration, size, and expiry, but no account or
contact identity. The UI does not assign those older files to a caller or
account. See the [voice call guide](https://moryoav.github.io/ha-addons/examples/voice-calls/#record-calls)
for recording format, retention, storage, and privacy details.

The workspace manages connections and calls. Sending messages and reacting to
incoming messages continue through Home Assistant actions and automations.

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

Find action and automation examples in the
[WhatsApp knowledge base](https://moryoav.github.io/ha-addons/).

- [Messages and media](https://moryoav.github.io/ha-addons/examples/messages/): text, stickers, documents, videos, polls, voice messages, locations, and reactions.
- [Recipients and number lookup](https://moryoav.github.io/ha-addons/examples/recipients/): identifiers, registration checks, saved contacts, profiles, and group lists.
- [Presence](https://moryoav.github.io/ha-addons/examples/presence/): subscriptions, online notifications, and typing indicators.
- [Automations](https://moryoav.github.io/ha-addons/examples/automations/): calls, logging, replies, read markers, sensor alerts, and local webhooks.
- [Reusable scripts](https://moryoav.github.io/ha-addons/examples/scripts/): send responses, quoted follow-ups, and saved message keys.
- [Decrypt incoming media](https://moryoav.github.io/ha-addons/examples/incoming-media/): setup, authenticated files, retention, and attachment processing.
- [Incoming messages and agents](https://moryoav.github.io/ha-addons/examples/incoming-messages/): chat filters, text extraction, and conversation replies.
- [AI-written notifications](https://moryoav.github.io/ha-addons/examples/ai-notifications/), [conversation history](https://moryoav.github.io/ha-addons/examples/conversation-history/), and [sensor charts](https://moryoav.github.io/ha-addons/examples/sensor-charts/): notification wording, stored context, and chart alerts.

## Events

<!-- Preserve links to event sections moved to the knowledge-base reference. -->
<a id="message-events"></a>
<a id="chat-archive-state"></a>
<a id="poll-votes"></a>
<a id="contact-metadata"></a>
<a id="receipt-events"></a>
<a id="call-events"></a>
<a id="call-log-events"></a>
<a id="health-events"></a>

| Event | Purpose |
| --- | --- |
| `new_whatsapp_message` | An incoming message, with decrypted media when enabled. |
| `whatsapp_message_sent` | An outgoing message observed by the linked session. |
| `whatsapp_message_status` | A sent message was delivered, read, or played. |
| `whatsapp_chat_read` | Received messages were read or played on another device. |
| `whatsapp_call_update` | An incoming call lifecycle update. |
| `whatsapp_call_log` | An incoming call stops ringing, or the phone shares an outgoing call record. |
| `whatsapp_presence_update` | A contact's presence changes. |
| `whatsapp_contacts_sync` | WhatsApp supplies contact names or identifiers. |
| `whatsapp_send_message_result` | A send action succeeds. |
| `whatsapp_addon_health_failure` | A successful startup reports a previous run's failed health checks. |

Use `clientId` to filter message events to the intended account. Reply and
mark-as-read automations should listen only to `new_whatsapp_message`;
`whatsapp_message_sent` includes the linked account's own sends and is not a
delivery receipt.

For incoming-call automations, filter `whatsapp_call_update` by status. Use
`offer` to act once per call. When another device answers, `terminate` means
ringing stopped on the add-on, not that the call ended. Calls made from the
phone appear later in `whatsapp_call_log`.

See the [event reference](https://moryoav.github.io/ha-addons/reference/events/)
for payload fields, chat archive state, poll votes, contact metadata, receipt
semantics, and health reports. The [automation examples](https://moryoav.github.io/ha-addons/examples/automations/)
show how to handle these events.

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
bodies. Saved media files can also contain private information. Redact these fields, QR codes, session data, and
internal API credentials before sharing diagnostics, logs, screenshots, or traces.

## Troubleshooting and diagnostics

### Debug and health diagnostics

Set `log_level` to `debug` and restart the add-on when investigating an
intermittent failure. Debug mode periodically summarizes event-loop
responsiveness, process and container resource use, API activity, health state,
reconnects, and aggregate message and call handling. It does not enable raw
Baileys logs or include message content, raw account identifiers, QR codes,
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
  WhatsApp Linked Devices, then scan the new QR code shown by the add-on.

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
