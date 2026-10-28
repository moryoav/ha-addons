<img src="https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/logo.png?raw=true" alt="WhatsApp" width="320"/>

![Supports aarch64 Architecture][aarch64-shield]
![Supports amd64 Architecture][amd64-shield]
[![HACS][hacs-badge]][hacs-url]
[![License][license-badge]][license-url]

# WhatsApp for Home Assistant

Send WhatsApp messages, call your Home Assistant for a conversation, or have
your home call you when something needs attention. The companion app also
delivers message, receipt, call, and presence events for automations.

This project has two parts, installed separately:

- **WhatsApp add-on:** runs the local WhatsApp Web client bridge.
- **WhatsApp integration:** exposes account devices, status sensors, actions,
  diagnostics, and setup in Home Assistant.

The integration connects to the add-on's local API. Each WhatsApp account is
paired through the add-on web UI with a QR code or a one-time phone-pairing code.

## What it can do

- **Talk to your home:** make and receive [WhatsApp voice calls](#voice-calls)
  with GPT-Live and your existing Home Assistant OpenAI conversation agent.
  Ask about devices, control exposed entities, and run exposed scripts.
- **Send messages:** text, images, videos, documents, stickers, voice messages,
  locations, contacts, polls, reactions, edits, deletions, and quoted replies.
- **Receive events:** incoming and outgoing messages, delivery and read receipts,
  calls, presence, contact updates, chat archive state, and decoded poll votes.
- **Recover missed messages:** opt selected accounts into a [persistent inbox](https://moryoav.github.io/ha-addons/examples/reliable-incoming-messages/) that replays messages after Home Assistant restarts, without automation changes.
- **Process incoming attachments:** [download and decrypt media](#decrypted-incoming-media)
  for OCR, transcription, document processing, or AI automations.
- **Look up recipients:** check phone numbers, fetch saved contacts and profiles,
  and list groups and their members with the [WhatsApp actions](#actions).
- **Monitor connections:** [devices and sensors](#devices-and-sensors) show the
  app connection and each account's WhatsApp connection and session state.
- **Use multiple accounts:** configure separate sessions and pair each one
  through the add-on web UI.

## Important limitation

This project uses WhatsApp Web through an unofficial client library. WhatsApp
may restrict or block accounts that use unofficial clients. Use a dedicated
account if that risk matters to you.

## Installation

### 1. Install the add-on

[![Add the WhatsApp add-on repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fmoryoav%2Fha-addons)

Add this repository as a Home Assistant add-on repository:

```text
https://github.com/moryoav/ha-addons
```

[![Open the WhatsApp add-on page](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=ea396823_whatsapp_addon&repository_url=https%3A%2F%2Fgithub.com%2Fmoryoav%2Fha-addons)

Install and start the `WhatsApp` add-on. Home Assistant should show a persistent notification with a QR code and an
**Open pairing page** link. Open the link or select **Open Web UI** on the
add-on page.

Choose an account in **Connection**, then scan its QR code with WhatsApp or
select **Link with code** to pair using the account's phone number.

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

If the integration cannot detect the add-on yet, confirm the `WhatsApp` add-on is installed and running, then submit the setup flow again or restart the add-on.

## Configuration parameters

See the [complete add-on option reference](whatsapp_addon/DOCS.md#configuration)
for voice calls, media downloads, retention, and logging options.

### Add-on

Common add-on options include:

- `clients`: one or more unique WhatsApp session names. The default is
  `default`. Names must start with a letter or digit, may contain letters,
  digits, `_`, and `-`, and may be at most 64 characters long.
- `log_level`: `info` (the default) for normal operation, or `debug` for
  additional privacy-safe runtime diagnostics while investigating a problem.

The app creates its internal API credential automatically on first startup,
saves it privately, and keeps it across restarts. Supervisor discovery shares
it with the integration, which applies credential changes automatically.
There is no token to enter or manage in the app configuration.

Each client gets its own choice of QR or phone-number pairing and persisted add-on session data.

Supplemental delivery receipts for decrypted own-device LID messages are always
enabled for every account. They do not mark chats as read. Detailed decryption
tracing is disabled; neither behavior has a configuration switch.

The add-on page includes an **Open Web UI** action through Home Assistant Ingress.
One account workspace provides **Connection**, **Calls**, and **Recordings**,
with each account's connection state visible as you move between them. The
Connection view shows the current QR code while an account is pairing. Select
**Link with code**, enter the account's phone number with its country code, and
request a one-time code to enter in WhatsApp. **Scan QR code** returns to QR pairing.

Choose the configured calling account to start a call with a phone number or
WhatsApp user ID, add an optional opening message, and browse completed
recordings. The active account and **Hang up** control stay visible while you
navigate. Messages continue through Home Assistant actions and automations.
See the [Web UI guide](whatsapp_addon/DOCS.md#web-ui) for details.

If the add-on detects a sustained burst of libsignal decryption failures, it
pauses all WhatsApp clients while keeping the add-on healthy. The web UI then
offers **Retry connection**, which keeps the saved sessions, and **Reset and
re-pair** for a selected client. Reset requires typing that client's exact ID
before deleting its local session.

### Integration

The integration has no user-entered setup parameters. It detects the running
app address and managed API credential through Home Assistant Supervisor discovery.

You can use the integration entry menu to reconfigure later; reconfiguration rediscovers the add-on URL automatically.

## Voice calls

Call the linked WhatsApp account and talk to your Home Assistant. You can ask
"Did I leave any lights on?", turn devices on or off, and keep asking follow-up
questions. Automations can also call you with an opening message, such as an
alert about a water leak.

In the app's **Voice calls** settings, choose one existing **Calling account**,
enter your **OpenAI conversation agent** entity ID, and allow the callers you
want it to answer. The app uses that agent's existing OpenAI API key and Assist
permissions. Calls and messages share the existing linked device, so there is
no second WhatsApp pairing. Other accounts keep working for messaging.

Choose from 22 voices, random or fixed greetings, automatic hang-up after a
goodbye, a call time limit, and advanced audio settings. Optional call recording
is off by default and has 30-day retention. Only direct audio calls are supported,
one at a time. Leave the calling account and agent empty for messaging only.

See the [voice call setup and automation examples](https://moryoav.github.io/ha-addons/examples/voice-calls/),
including upgrade steps for existing installations.

## Devices and sensors

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
- `whatsapp.make_call`: start an AI voice call from the selected calling account,
  with an optional opening message after the recipient answers.
- `whatsapp.hang_up`: end the selected account's active AI call.
- `whatsapp.get_profile`: look up a contact's profile picture URL, about text,
  and business profile, or a group's picture.
- `whatsapp.list_groups`: list every group the linked account belongs to, with
  its JID, name, description, and settings.
- `whatsapp.get_contacts`: fetch a fresh saved-contact snapshot for the selected
  account, with original contact fields including names and LIDs when supplied.
  Requires `response_variable`. See the [saved contact example](https://moryoav.github.io/ha-addons/examples/recipients/#get-saved-contacts).

`whatsapp.send_message` can return response data when called with
`response_variable`; it also fires the event
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
| `whatsapp_call_log` | An incoming call stops ringing, or the phone shares an outgoing call record. |
| `whatsapp_presence_update` | A contact presence update. |
| `whatsapp_contacts_sync` | Available contact records from WhatsApp synchronization or contact updates. |
| `whatsapp_send_message_result` | Result event after a successful send action. |
| `whatsapp_addon_health_failure` | Sanitized diagnostics after a previous add-on run ends unhealthy. |

Message events include the configured `clientId`, detected message `type`,
Baileys message `key`, and `message` payload. Use only `new_whatsapp_message`
for replies and read markers so outgoing messages do not trigger another reply.
Logging automations can listen to both message events.

A sent-message event confirms that the session observed the send, not that the
recipient received or read it. Use `whatsapp_message_status` for delivery and
read receipts. Use `whatsapp_chat_read` to detect messages read on another
device, such as your phone.

For incoming-call automations, filter `whatsapp_call_update` to the status you
need. Use `offer` to act once per call. When another device answers,
`terminate` means ringing stopped on the add-on; it does not mean the call
ended. Calls made from the phone appear later in `whatsapp_call_log`. To start
an AI voice call from Home Assistant, use the [voice call actions](#voice-calls).

See the [event reference](https://moryoav.github.io/ha-addons/reference/events/)
for payload fields, chat archive state, poll votes, contact metadata, call logs,
and health reports. The [automation examples](https://moryoav.github.io/ha-addons/examples/automations/)
cover message logging, unread-alert escalation, and missed-call notifications.

## Examples

Find action and automation examples in the
[WhatsApp knowledge base](https://moryoav.github.io/ha-addons/).

- [Messages and media](https://moryoav.github.io/ha-addons/examples/messages/): text, stickers, documents, videos, polls, voice messages, locations, and reactions.
- [Recipients and lookups](https://moryoav.github.io/ha-addons/examples/recipients/): identifiers, registration checks, profiles, and group lists.
- [Presence](https://moryoav.github.io/ha-addons/examples/presence/): subscriptions, online notifications, and typing indicators.
- [Automations](https://moryoav.github.io/ha-addons/examples/automations/): declining calls, call logs, unread-alert escalation, logging, replies, read markers, sensor alerts, and local webhooks.
- [Reusable scripts](https://moryoav.github.io/ha-addons/examples/scripts/): send responses, quoted follow-ups, and saved message keys.
- [Decrypt incoming media](https://moryoav.github.io/ha-addons/examples/incoming-media/): setup, authenticated files, retention, and attachment processing.
- [Incoming messages and agents](https://moryoav.github.io/ha-addons/examples/incoming-messages/): chat filters, text extraction, and conversation replies.
- [AI-written notifications](https://moryoav.github.io/ha-addons/examples/ai-notifications/), [conversation history](https://moryoav.github.io/ha-addons/examples/conversation-history/), and [sensor charts](https://moryoav.github.io/ha-addons/examples/sensor-charts/): notification wording, stored context, and chart alerts.

## Data updates

The add-on pushes message, receipt, call, contact, and presence events into
Home Assistant as they arrive. Supervisor discovery provides the local API
connection, and actions call that API on demand. Status sensors read the app
and account state every 30 seconds.
For opt-in inbox accounts, the app delivers immediately when Home Assistant is
ready and retries unavailable delivery after ten seconds. Existing automations
keep using `new_whatsapp_message` without changes.

## Security notes

- The bridge API runs on Home Assistant's internal app network. A privately
  generated credential protects API requests and is shared automatically
  through Supervisor discovery.
- The web UI uses Home Assistant Ingress and accepts connections from the
  Supervisor ingress proxy. Pairing QR codes appear there and in Home Assistant
  persistent notifications.
- AppArmor restricts the Node bridge's writes to temporary files, persistent
  session data, private inbox snapshots, and attachments under `/media/whatsapp`. Container health checks
  use the local `/health` endpoint.

API tokens, pairing QR codes, session data, and WhatsApp identifiers are
sensitive. Redact them from issue reports, screenshots, logs, and shared
automation traces. Home Assistant may retain action inputs, response data,
and message bodies in traces. Review and redact those traces before sharing them.

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

Detailed decryption tracing remains disabled in debug mode.

Failed native health checks are retained at both log levels. If Supervisor
replaces an unhealthy container, the next add-on run replays the saved probe
result and surrounding runtime state into its log so the evidence survives the
restart. If the history ends with three consecutive failed probes, that run
also fires `whatsapp_addon_health_failure` for automations or webhooks. When `log_level` is `debug`, it creates a
Home Assistant persistent notification containing the same sanitized summary;
`info` mode never creates this health notification. A fixed notification id
updates the existing alert instead of accumulating duplicates.

See the [add-on troubleshooting and diagnostics guide](whatsapp_addon/DOCS.md#troubleshooting-and-diagnostics)
for encryption recovery and LID sender receipt handling.

## Troubleshooting

- If setup cannot connect, confirm the add-on is installed and running, then restart the add-on so it can publish Supervisor discovery.
- If actions fail with a client error, confirm the `clientId` exists in the
  add-on options and has completed QR-code or phone-number pairing.
- If an action reports `unauthorized`, make sure the add-on and integration are
  both current, then restart the add-on and reload the integration so Supervisor
  discovery refreshes the managed internal credential. Because `/health` is public for
  container monitoring, a stale token is detected on the first protected action rather
  than during setup.
- If an action is unsupported or its endpoint is missing, update both the
  add-on and HACS integration, then restart Home Assistant.
- A vote with `poll_vote.error: unknown_poll` belongs to a poll the add-on does
  not have: one it did not receive, one more than 30 days old, or one pushed out
  by 100 newer polls.
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
- If HACS does not show WhatsApp, search under **Integrations**. Use the
  [manual installation steps](#installation) as a fallback.
- Isolated libsignal `Bad MAC` and session lifecycle messages are summarized by
  the add-on instead of logging full stack traces or session data. A confirmed
  high-volume decryption failure burst activates the recovery pause described
  above.

## Removal

1. Delete the WhatsApp integration under **Settings > Devices & services**.
2. Remove the integration through HACS, or delete
   `/config/custom_components/whatsapp` if you installed it manually.
3. Remove the `WhatsApp` add-on.
4. Restart Home Assistant.

## ❤️ Help support this project

Support ongoing development through Ko-fi or GitHub Sponsors:

<p>
  <a href="https://ko-fi.com/Y5B124NZ2L"><img src="https://img.shields.io/badge/Support_on_Ko--fi-FF5E5B?style=for-the-badge&amp;logo=kofi&amp;logoColor=white" alt="Support on Ko-fi" height="36"></a>
  &nbsp;
  <a href="https://github.com/sponsors/moryoav"><img src="https://img.shields.io/badge/Sponsor_on_GitHub-EA4AAA?style=for-the-badge&amp;logo=githubsponsors&amp;logoColor=white" alt="Sponsor on GitHub" height="36"></a>
</p>

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development notes, [SECURITY.md](SECURITY.md) for vulnerability reporting, and [CHANGELOG.md](CHANGELOG.md) for release history.

See the [voice architecture and offline tests](whatsapp_addon/voice/README.md)
for the shared Baileys session adapter, native call worker, GPT-Live bridge,
and container validation. The messaging dependencies stay pinned while the
call worker is built from a fixed upstream revision and guarded patches.

[hacs-badge]: https://img.shields.io/badge/HACS-41BDF5.svg?style=flat-square
[hacs-url]: #installation
[license-badge]: https://img.shields.io/github/license/moryoav/ha-addons?style=flat-square
[license-url]: https://github.com/moryoav/ha-addons/blob/main/LICENSE

[aarch64-shield]: https://img.shields.io/badge/aarch64-yes-green.svg
[amd64-shield]: https://img.shields.io/badge/amd64-yes-green.svg
