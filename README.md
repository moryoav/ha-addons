# WhatsApp for Home Assistant

[![HACS][hacs-badge]][hacs-url]
[![License][license-badge]][license-url]

---

## ❤️ Help support this project

If this project is useful to you, you can support my work:

<p>
  <a href="https://ko-fi.com/Y5B124NZ2L"><img src="https://img.shields.io/badge/Support_on_Ko--fi-FF5E5B?style=for-the-badge&amp;logo=kofi&amp;logoColor=white" alt="Support on Ko-fi" height="36"></a>
  &nbsp;
  <a href="https://github.com/sponsors/moryoav"><img src="https://img.shields.io/badge/Sponsor_on_GitHub-EA4AAA?style=for-the-badge&amp;logo=githubsponsors&amp;logoColor=white" alt="Sponsor on GitHub" height="36"></a>
</p>

---

Send WhatsApp messages from Home Assistant automations and receive WhatsApp
message, receipt, call, and presence events through the companion app.

## What it can do

**Devices and sensors:**

| Device | Entity | What it shows |
| --- | --- | --- |
| WhatsApp app | App connection | Whether Home Assistant can reach the local app. |
| WhatsApp (account ID) | WhatsApp connection | Whether that account is connected to WhatsApp. |
| WhatsApp (account ID) | Session state | Connected, connecting, reconnecting, pairing required, logged out, disconnected, restarting, or paused for recovery. |

Each configured account gets a separate device, including accounts waiting for
pairing. One shared update runs every 30 seconds. App connection can be connected
while an account is disconnected. If account status cannot be read, its entities
become unavailable. Devices and entity IDs remain stable while the configured
account ID stays the same, including after a restart or re-pairing.

These are diagnostic entities, enabled by default. See
[Devices and sensors](https://moryoav.github.io/ha-addons/reference/entities/)
for states, account removal, and an alert example.

**Actions** (under the `whatsapp` domain):

| Action | What it does |
| --- | --- |
| `send_message` | Send text, images, videos, documents, stickers, voice messages, locations, contacts, polls, reactions, edits, deletions, and quoted replies. |
| `read_messages` | Mark a received message as read. |
| `presence_subscribe`, `send_presence_update`, `send_infinity_presence_update` | Follow a contact's presence and show online, typing, or recording. |
| `set_status` | Set the account's about text. |
| `check_number` | Check whether a phone number is on WhatsApp and get its LID. |
| `get_group_info` | Get a group's name, description, settings, and members. |
| `reject_call` | Decline an incoming call. |
| `get_profile` | Get a contact's profile picture, about text, and business profile, or a group's picture. |
| `list_groups` | List every group the account belongs to. |

**Events:**

| Event | Fires when |
| --- | --- |
| `new_whatsapp_message` | A message is received, optionally with its [decrypted media](https://moryoav.github.io/ha-addons/examples/incoming-media/) and the chat's archive state. |
| `whatsapp_message_sent` | This account sends a message, from Home Assistant, the phone, or another device. |
| `whatsapp_message_status` | A sent message is delivered, read, or played. |
| `whatsapp_chat_read` | You read or play received messages on another device, such as the phone. |
| `whatsapp_call_update` | An incoming call rings, is answered, declined, or stops ringing. |
| `whatsapp_call_log` | A call ends, incoming or made from the phone. |
| `whatsapp_presence_update` | A followed contact's presence changes. |
| `whatsapp_send_message_result` | `send_message` finishes. |
| `whatsapp_addon_health_failure` | The add-on restarts after its health checks failed. |

## Decrypted incoming media

Turn received WhatsApp attachments into inputs for Home Assistant automations.
The add-on can download and decrypt images, voice notes, audio, videos,
documents, and stickers automatically, then enrich `new_whatsapp_message`
with a ready-to-use local file, an authenticated download link, and its expiry.

Each message gets its own file, so the next attachment cannot overwrite it.
Files expire automatically after a configurable retention period, with size
and storage limits. Automations can send the decrypted file to an OCR,
transcription, document-processing, or AI integration of your choice.

**Enable Download incoming media in the add-on configuration.** Downloads
are off by default.

See [Decrypt incoming media](https://moryoav.github.io/ha-addons/examples/incoming-media/)
for setup, retention options, the enriched event, and an automation example.

<img src="https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/logo.png?raw=true" width="320"/>

![Supports aarch64 Architecture][aarch64-shield]
![Supports amd64 Architecture][amd64-shield]

[aarch64-shield]: https://img.shields.io/badge/aarch64-yes-green.svg
[amd64-shield]: https://img.shields.io/badge/amd64-yes-green.svg

The add-on supports `aarch64` and `amd64`.

This repository contains two pieces:

- `whatsapp_addon`: the Home Assistant add-on that runs the local WhatsApp Web client bridge.
- `custom_components/whatsapp`: the Home Assistant integration that exposes account devices, status sensors, actions, diagnostics, and setup flow support.

The integration uses the local add-on HTTP API and serves decrypted attachments
from the shared `/media/whatsapp` directory using Home Assistant authentication.
WhatsApp account pairing is handled by the add-on QR-code flow.

## Important limitation

This project uses WhatsApp Web through an unofficial client library. WhatsApp does not officially support bots or unofficial clients, so account restrictions or blocking are possible. Use a dedicated account if that risk matters to you.

## Security notes

The packaged add-on follows the current Home Assistant app presentation guidance where it is relevant to this project:

- No HTTP port is published to the LAN.
- The local bridge API is used from the Home Assistant add-on network and can
  optionally require a bearer token.
- The bridge API does not enable cross-origin browser access.
- A custom AppArmor profile is included and AppArmor is enabled. The trusted
  base-image bootstrap uses the standard Home Assistant startup permissions,
  then the network-facing Node bridge runs in a restricted child profile where
  packaged code and dependencies are read-only and writes are limited to
  temporary files, persistent session data, and `/media/whatsapp` attachments.
- No Docker API access.
- No host network, host PID, or host UTS access.
- No `full_access` mode.
- No privileged capabilities.
- No elevated Supervisor role.
- A native container health check uses the local `/health` endpoint.
- Home Assistant Ingress is enabled for the add-on web UI.
- The web UI listener only accepts the Supervisor ingress proxy address, and no HTTP port is published to the LAN.
- QR pairing is shown in the add-on web UI and through Home Assistant persistent notifications.
- The add-on has no `/config` mount and cannot install, overwrite, or remove
  Home Assistant custom-component files.

The API token, pairing QR codes, session data, and WhatsApp identifiers are
sensitive. Do not include them in logs, issue reports, screenshots, or shared
automation traces. Home Assistant traces may retain action inputs and response
data even though the integration and add-on avoid logging recipient identifiers.

## Stable and canary builds

Use the default repository URL for stable releases:

```text
https://github.com/moryoav/ha-addons
```

Home Assistant installs a prebuilt image from `ghcr.io/moryoav/whatsapp-addon`.
Each stable image is built from the matching GitHub release.

This repository does not currently publish a separate canary or `next` branch. If a canary channel is introduced later, it will be documented with its `#branch` repository URL and a distinct add-on name.

## Installation

### 1. Install the add-on

[![Add the WhatsApp add-on repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fmoryoav%2Fha-addons)

Add this repository as a Home Assistant add-on repository:

```text
https://github.com/moryoav/ha-addons
```

[![Open the WhatsappV2 add-on page](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=ea396823_whatsapp_addon&repository_url=https%3A%2F%2Fgithub.com%2Fmoryoav%2Fha-addons)

Install and start the `WhatsappV2` add-on. In a few seconds, Home Assistant should show a persistent notification with a QR code. You can also open the add-on web UI from the add-on page to view session status and the current pairing QR code. Scan the QR code with the WhatsApp mobile app.

### 2. Install the integration

[![Open the WhatsApp HACS repository](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=moryoav&repository=ha-addons&category=integration)

WhatsApp is available in the default HACS catalog, so no custom repository setup is required.

1. Select the button above, or open HACS and search for **WhatsApp** under **Integrations**.
2. Select **WhatsApp** and choose **Download**.
3. Restart Home Assistant.

As a manual fallback, copy `custom_components/whatsapp` into:

```text
/config/custom_components/whatsapp
```

Then restart Home Assistant.

### 3. Configure the integration

In Home Assistant, go to:

[![Add the WhatsApp integration](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=whatsapp)

```text
Settings > Devices & services > Add integration > WhatsApp
```

No URL is required. The add-on advertises itself through Supervisor discovery, and the integration stores the detected local add-on URL automatically.

If the integration cannot detect the add-on yet, confirm the `WhatsappV2` add-on is installed and running, then submit the setup flow again or restart the add-on.

## Configuration parameters

### Add-on

The add-on accepts these options:

- `clients`: one or more unique WhatsApp session names. The default is
  `default`. Names must start with a letter or digit, may contain letters,
  digits, `_`, and `-`, and may be at most 64 characters long.
- `log_level`: `info` (the default) for normal operation, or `debug` for
  additional privacy-safe runtime diagnostics while investigating a problem.
- `decryption_diagnostics`: `false` by default. This internal debugging option
  records complete message metadata and decoded message structures, exact JIDs
  and message IDs, retry activity, and encrypted payload fingerprints. Keep it
  disabled during normal operation.
- `api_token`: optional bearer token for the internal add-on API. Use a strong
  random value when you want defense in depth. Leave it unset if you do not need
  API authentication. A token may contain
  `A-Z`, `a-z`, `0-9`, `-`, `.`, `_`, `~`, `+`, and `/`, followed by optional
  `=` padding, with a maximum total length of 512 characters. Random hex or
  URL-safe Base64 is recommended; spaces, `:`, and other characters make the
  add-on reject its configuration at startup.

Token-enabled installations require Supervisor discovery; manual or fallback
URL detection cannot supply the token. After adding, changing, or removing
`api_token`, restart the add-on and reload the integration so the discovery
record authoritatively refreshes the stored credential.

Each client gets its own QR-code pairing flow and persisted add-on session data.

The add-on page includes an Open Web UI action through Home Assistant Ingress.
The web UI shows each configured session, its connection state, and the current
QR code when a session is waiting for pairing. If the add-on detects a sustained
burst of libsignal decryption failures, it pauses all WhatsApp clients while
keeping the add-on healthy. The web UI then offers Retry connection, which
keeps the saved sessions, and Reset and re-pair for a selected client, which
requires confirmation before deleting that client's local session.

### Integration

The integration has no user-entered setup parameters. It detects the running
add-on URL and optional API token through Home Assistant Supervisor discovery.

You can use the integration entry menu to reconfigure later; reconfiguration rediscovers the add-on URL automatically.

## Actions

The integration registers these Home Assistant actions under the `whatsapp` domain:

- `whatsapp.send_message`: send text, media, location, reactions, or any payload supported by the add-on.
- `whatsapp.set_status`: set the WhatsApp account status text.
- `whatsapp.presence_subscribe`: subscribe to presence updates for a contact.
- `whatsapp.send_presence_update`: send a one-shot presence update.
- `whatsapp.send_infinity_presence_update`: send a long-running presence update.
- `whatsapp.read_messages`: mark received messages as read.
- `whatsapp.check_number`: check whether a phone number is registered with
  WhatsApp and return its normalized phone JID and LID when available.
- `whatsapp.get_group_info`: look up a group by its `@g.us` JID and return its
  name, description, owner, settings, and participants.
- `whatsapp.reject_call`: decline an incoming call using the `callId` and
  `from` values of its `whatsapp_call_update` event.
- `whatsapp.get_profile`: look up a contact's profile picture URL, about text,
  and business profile, or a group's picture.
- `whatsapp.list_groups`: list every group the linked account belongs to, with
  its JID, name, description, and settings.

`whatsapp.send_message` can return response data when called with
`response_variable`; it also fires the compatibility event
`whatsapp_send_message_result`. A successful response means the linked client
accepted the send operation. It does not guarantee delivery, receipt, or that
the recipient read the message.

## Events

The add-on fires these Home Assistant events:

| Event type | Description |
| --- | --- |
| `new_whatsapp_message` | A received WhatsApp message. |
| `whatsapp_message_sent` | An outgoing WhatsApp message reported by the connected session. |
| `whatsapp_message_status` | A sent message was delivered, read, or played. |
| `whatsapp_chat_read` | Received messages were read or played on another device. |
| `whatsapp_call_update` | An incoming WhatsApp call lifecycle update. |
| `whatsapp_call_log` | One record per finished call, incoming or outgoing. |
| `whatsapp_presence_update` | A contact presence update. |
| `whatsapp_send_message_result` | Compatibility result event after sending a message. |
| `whatsapp_addon_health_failure` | Sanitized diagnostics after a previous add-on run ends unhealthy. |

`new_whatsapp_message` and `whatsapp_message_sent` include the configured
`clientId`, the detected message `type`, the Baileys message `key`, and the
`message` payload. Other fields, such as `messageTimestamp`, are passed through
when present.

`new_whatsapp_message` and `whatsapp_message_sent` also include `chat_archived`:
`true` for an archived chat, `false` for an unarchived chat,
or `null` if its state is not known. The value comes from the latest locally
cached WhatsApp chat state, with no extra network request per message. Known
flags survive add-on restarts and are updated by WhatsApp synchronization.
For `whatsapp_message_sent`, the field describes the destination chat.
See the
[archive-state details and automation condition](https://moryoav.github.io/ha-addons/reference/events/#chat-archive-state).

`whatsapp_message_sent` fires for messages with
`key.fromMe: true`, including messages sent from the phone, other linked
devices, and the add-on itself when reported by WhatsApp. For this event,
`key.remoteJid` identifies the destination chat or group and can be a LID.
Duplicate-message checks apply to both directions. The event reports a sent
message observed by the session; it is not a delivery or read receipt.

The add-on sends this event directly to Home Assistant. Logging automations can
listen to both events, as in the [logging example](https://moryoav.github.io/ha-addons/examples/automations/#log-received-and-sent-messages).
Reply and mark-as-read automations should listen only to `new_whatsapp_message`
to avoid acting on own sends.

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

`whatsapp_call_update` fires for every call lifecycle update reported by
Baileys. Its `status` is one of `offer`, `ringing`, `accept`, `reject`,
`timeout`, or `terminate`. Each event has a stable payload containing
`clientId`, `callId`, `status`, `from`, `chatId`, `isVideo`, `isGroup`,
`groupJid`, `date`, and `offline`. Fields that are absent from an upstream
update are `null`. The `from` and `chatId` values can be WhatsApp LIDs rather
than phone-number JIDs. The add-on preserves the observed update order and
retries transient delivery failures across a 33-second backoff window when Home
Assistant Core is unavailable. Baileys lifecycle updates can still be missing
or arrive after a reconnect, so automations should filter the status they need
without assuming that every call produces every status.

For a call answered on the phone or another device, `accept` is followed almost
immediately by `terminate`: the call stopped ringing on the add-on's linked
device, not the end of the call. WhatsApp sends a linked device nothing more
about an answered call, so there is no update when it ends. `ringing` can fire
once for each of your devices; trigger on `offer` to act once per call.

`whatsapp.reject_call` declines an incoming call.
Pass the `callId` and `from` values of its `offer` event, as in the
[night-time example](https://moryoav.github.io/ha-addons/examples/automations/#decline-calls-at-night-and-reply-with-a-message).
WhatsApp does not let a linked device start calls, and it does not report calls
made from the phone as call events; `whatsapp_call_log` reports them after they
end.

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

`whatsapp_addon_health_failure` fires on the next successful startup when the
saved history ends with three consecutive failed native health checks. Its
bounded data includes timestamps, failure classification, HTTP and curl result,
probe timings and streak, plus available process and container metrics. It never
includes message contents, account identifiers, URLs, headers, tokens, or raw
response bodies.

## Supported identifiers

Message targets can use:

- Phone-number user JID, such as the fictional `12025550123@s.whatsapp.net`.
- WhatsApp LID user JID, such as the synthetic `999000111222333@lid`.
- Group JID, such as the synthetic `120363000000000000@g.us`.
- Broadcast JID, such as `status@broadcast`.

**For direct chats, use LID (`@lid`) targets whenever
available.**
Phone-number JIDs (`@s.whatsapp.net`) are less reliable with Baileys. Run
`whatsapp.check_number` with the phone number, then use the returned `lid` as
the `to` target; fall back to the returned phone-number `jid` only when `lid`
is unavailable.

When replying to an incoming event, the safest target is usually:

```jinja2
{{ trigger.event.data.key.remoteJid }}
```

## Examples

I keep the examples in the [WhatsApp knowledge base](https://moryoav.github.io/ha-addons/).

- [Messages and media](https://moryoav.github.io/ha-addons/examples/messages/): text, stickers, documents, videos, polls, voice messages, locations, and reactions.
- [Recipients and lookups](https://moryoav.github.io/ha-addons/examples/recipients/): identifiers, registration checks, profiles, and group lists.
- [Presence](https://moryoav.github.io/ha-addons/examples/presence/): subscriptions, online notifications, and typing indicators.
- [Automations](https://moryoav.github.io/ha-addons/examples/automations/): declining calls, call logs, unread-alert escalation, logging, replies, read markers, sensor alerts, and local webhooks.
- [Reusable scripts](https://moryoav.github.io/ha-addons/examples/scripts/): send responses, quoted follow-ups, and saved message keys.
- [Incoming messages and agents](https://moryoav.github.io/ha-addons/examples/incoming-messages/): chat filters, text extraction, and conversation replies.
- [AI-written notifications](https://moryoav.github.io/ha-addons/examples/ai-notifications/), [conversation history](https://moryoav.github.io/ha-addons/examples/conversation-history/), and [sensor charts](https://moryoav.github.io/ha-addons/examples/sensor-charts/): notification wording, stored context, and chart alerts.

## Data updates

The integration does not poll WhatsApp. The add-on pushes message, receipt,
call, and presence events into Home Assistant as they arrive, advertises its local API
through Supervisor discovery, and actions call the local add-on API on demand.

## Diagnostics

The integration supports Home Assistant diagnostics. The public health
contract is limited to a non-sensitive status, the service identifier
`ha-whatsapp-addon`, API version, capabilities, and configured-client count.
Diagnostics do not include the detected URL, API token, recipient identifiers,
or message contents.

When diagnosing an intermittent add-on problem, set its `log_level` option to
`debug` and restart it. Debug mode adds periodic privacy-safe summaries of
event-loop responsiveness, process and container resource use, API activity,
health state, reconnects, and aggregate message and call handling. It does not
enable raw Baileys logs or include message content, raw account identifiers, QR
codes, session data, or API tokens. Identifier-related entries use run-scoped
one-way references for correlation. Return the option to `info` after collecting
the relevant logs.

Debug mode also logs WhatsApp app-state sync:
`server_sync` collection names, resync progress, the kind of each synced
change, and a summary of any call-history entry the phone shares, with
identifiers replaced by one-way references.

After each connection the add-on logs how many offline messages WhatsApp
announced and delivered. If WhatsApp has not finished sending them one minute
after the connection opened, a warning is logged instead. Until WhatsApp
finishes, new messages can wait on the server until the next reconnect. These
lines contain counts only.

The separate Decryption Diagnostics toggle is intended for investigating
message decryption failures. When enabled, it records raw message-stanza
attributes, exact message and participant identifiers, sender names,
timestamps, message stub data, retry counters, the complete decoded message
structure when available, and encrypted payload sizes and SHA-256
fingerprints. It also records incoming receipts and message acknowledgements,
outgoing receipt and acknowledgement routing reported by Baileys, and retry-cache
lookups, including the requested conversation, message ID, and whether it was
found. An outgoing log entry records a send attempt, not proof that WhatsApp
accepted the acknowledgement. It remains enabled until the option is switched
off and the add-on is restarted. A failed encrypted message has no decoded body
to record.

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

Failed native health checks are retained at both log levels. If Supervisor
replaces an unhealthy container, the next add-on run replays the saved probe
result and surrounding runtime state into its log so the evidence survives the
restart. That run also fires the silent `whatsapp_addon_health_failure` event
for explicit automations or webhooks. When `log_level` is `debug`, it creates a
Home Assistant persistent notification containing the same sanitized summary;
`info` mode never creates this health notification. A fixed notification id
updates the existing alert instead of accumulating duplicates.

## Troubleshooting

- If setup cannot connect, confirm the add-on is installed and running, then restart the add-on so it can publish Supervisor discovery.
- If actions fail with a client error, confirm the `clientId` exists in the add-on options and has completed QR-code pairing.
- If an action reports `unauthorized`, make sure the add-on and integration are
  both current, then restart the add-on and reload the integration so Supervisor
  discovery refreshes the configured API token. Because `/health` is public for
  container monitoring, a stale token is detected on the first protected action rather
  than during setup.
- If an action is unsupported or its endpoint is missing, update both the
  add-on and HACS integration, then restart Home Assistant.
- If messages are not received, check the add-on web UI and logs for QR-code, session, and WhatsApp connection messages.
- If the add-on reports that its clients are paused, open its Web UI. Try Retry
  connection first. If the same failure returns, use Reset and re-pair for the
  affected client, remove the old entry from WhatsApp Linked Devices, and scan
  the new QR code. Actions for paused clients return
  `client_recovery_paused` until recovery is started.
- If call updates are not received, confirm the automation listens for
  `whatsapp_call_update` and filters on a supported `status` value. The add-on
  log reports the call status, HTTP status, attempt number, and retry delay when
  Home Assistant Core is temporarily unavailable.
- Outgoing calls appear in `whatsapp_call_log` only after they end and the
  phone shares its call history, usually within about 15 seconds.
- If HACS does not show the integration, confirm `hacs.json` exists at the repository root and `custom_components/whatsapp/manifest.json` exists.
- Isolated libsignal `Bad MAC` and session lifecycle messages are summarized by
  the add-on instead of logging full stack traces or session data. A confirmed
  high-volume decryption failure burst activates the recovery pause described
  above.

## Legacy integration migration

The add-on and integration are managed separately. Updating or uninstalling the
add-on leaves any existing `/config/custom_components/whatsapp` directory untouched.

If an older add-on installed the integration for you:

1. Create a Home Assistant backup.
2. Install or update **WhatsApp** from the default HACS integration catalog.
3. Restart Home Assistant and confirm the WhatsApp integration loads under
   **Settings > Devices & services**.
4. Remove any legacy `whatsapp:` block from `configuration.yaml`, then restart
   Home Assistant again.

Do not manually delete `/config/custom_components/whatsapp` after HACS takes
ownership of it. For a manual installation, replace the whole directory with
the current repository copy before restarting Home Assistant.

## Removal

1. Delete the WhatsApp integration from Home Assistant.
2. Remove the `WhatsappV2` add-on.
3. Remove any legacy `whatsapp:` YAML from `configuration.yaml` if you still have it.
4. Delete `/config/custom_components/whatsapp` if you installed manually.
5. Restart Home Assistant.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development notes, [SECURITY.md](SECURITY.md) for vulnerability reporting, and [CHANGELOG.md](CHANGELOG.md) for release history.

[hacs-badge]: https://img.shields.io/badge/HACS-41BDF5.svg?style=flat-square
[hacs-url]: #installation
[license-badge]: https://img.shields.io/github/license/moryoav/ha-addons?style=flat-square
[license-url]: https://github.com/moryoav/ha-addons/blob/main/LICENSE
