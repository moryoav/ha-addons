# WhatsApp for Home Assistant

[![HACS][hacs-badge]][hacs-url] [![release][release-badge]][release-url] [![license][license-badge]][license-url]

---

## Support me on Ko-fi

If this project is useful to you, you can support its continued development:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/Y5B124NZ2L)

---

Send WhatsApp messages from Home Assistant automations and receive WhatsApp
message, call, and presence events through the companion add-on.

<img src="https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/logo.png?raw=true" width="320"/>

![Supports aarch64 Architecture][aarch64-shield]
![Supports amd64 Architecture][amd64-shield]

[aarch64-shield]: https://img.shields.io/badge/aarch64-yes-green.svg
[amd64-shield]: https://img.shields.io/badge/amd64-yes-green.svg

The add-on supports `aarch64` and `amd64`. Release 1.4.31 removes `armhf`,
`armv7`, and `i386`, which Home Assistant has not supported since 2025.12.

This repository contains two pieces:

- `whatsapp_addon`: the Home Assistant add-on that runs the local WhatsApp Web client bridge.
- `custom_components/whatsapp`: the Home Assistant integration that exposes actions, diagnostics, setup flow support, and add-on connectivity.

The integration talks only to the local add-on HTTP API. WhatsApp account pairing is handled by the add-on QR-code flow.

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
  temporary and persistent session data.
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

Add-on releases before 1.4.31 could install a bundled legacy component. The
current add-on neither updates nor deletes that copy. If you previously relied
on it, follow [Legacy integration migration](#legacy-integration-migration).

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
  random value when you want defense in depth. Leave it unset to preserve
  compatibility with older internal-network installations. A token may contain
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
| `whatsapp_call_update` | An incoming WhatsApp call lifecycle update. |
| `whatsapp_presence_update` | A contact presence update. |
| `whatsapp_send_message_result` | Compatibility result event after sending a message. |
| `whatsapp_addon_health_failure` | Sanitized diagnostics after a previous add-on run ends unhealthy. |

`new_whatsapp_message` includes the configured `clientId`, the detected message `type`, the Baileys message `key`, and the message payload.

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

**For direct chats, migrate automations to LID (`@lid`) targets whenever
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

### Send a text message

```yaml
action: whatsapp.send_message
data:
  clientId: default
  to: 12025550123@s.whatsapp.net
  body:
    text: Hi from Home Assistant
```

### Capture the sent message id

```yaml
- action: whatsapp.send_message
  response_variable: whatsapp_result
  data:
    clientId: default
    to: 12025550123@s.whatsapp.net
    body:
      text: This call stores the sent WhatsApp message id.
```

### Notify when an incoming WhatsApp call is offered

```yaml
- alias: Incoming WhatsApp call
  trigger:
    - platform: event
      event_type: whatsapp_call_update
      event_data:
        status: offer
  action:
    - action: persistent_notification.create
      data:
        title: Incoming WhatsApp call
        message: >-
          {{ "Video" if trigger.event.data.isVideo else "Voice" }} call from
          {{ trigger.event.data.from or "an unknown caller" }}.
  mode: queued
```

### Reply to `!ping`

```yaml
- alias: WhatsApp ping pong
  trigger:
    - platform: event
      event_type: new_whatsapp_message
  condition:
    - condition: template
      value_template: "{{ trigger.event.data.message.conversation == '!ping' }}"
  action:
    - action: whatsapp.send_message
      data:
        clientId: "{{ trigger.event.data.clientId }}"
        to: "{{ trigger.event.data.key.remoteJid }}"
        body:
          text: pong
  mode: single
```

### Mark incoming messages as read

```yaml
- alias: Mark WhatsApp messages as read
  trigger:
    - platform: event
      event_type: new_whatsapp_message
  action:
    - action: whatsapp.read_messages
      data:
        clientId: "{{ trigger.event.data.clientId }}"
        body:
          keys:
            id: "{{ trigger.event.data.key.id }}"
            remoteJid: "{{ trigger.event.data.key.remoteJid }}"
            fromMe: "{{ trigger.event.data.key.fromMe }}"
  mode: queued
```

### Check whether a phone number is registered

```yaml
- action: whatsapp.check_number
  data:
    clientId: default
    to: "+12025550123"
  response_variable: number_check
```

`whatsapp.check_number` requires `response_variable`. It accepts an
international phone number as bare digits with an optional leading `+`, or a
phone-number `@s.whatsapp.net` JID. It does not accept groups, LIDs, broadcasts,
or device-qualified JIDs.

The response has this shape:

```yaml
jid: 12025550123@s.whatsapp.net
exists: true
lid: 999000111222333@lid
```

`exists: false` is a successful lookup and normally has `lid: null`. The lookup
checks WhatsApp registration at that moment; it does not guarantee that a
subsequent message will be delivered. Avoid bulk or repeated enumeration, and
treat the returned JID and LID as private account identifiers.

Invalid input, an unknown or disconnected client, rate limiting, authentication
failure, and an upstream WhatsApp failure are reported as action errors. They
are never collapsed into `exists: false`.

`whatsapp.send_message` sends direct phone JIDs without a registration lookup;
bare phone numbers retain the existing lookup before sending. Call
`whatsapp.check_number` when an automation needs an explicit preflight and a
structured registration response.

## Data updates

The integration does not poll WhatsApp. The add-on pushes message, call, and
presence events into Home Assistant as they arrive, advertises its local API
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

The separate Decryption Diagnostics toggle is intended for investigating
message decryption failures. When enabled, it records raw message-stanza
attributes, exact message and participant identifiers, sender names,
timestamps, message stub data, retry counters, the complete decoded message
structure when available, and encrypted payload sizes and SHA-256
fingerprints. It remains enabled until the option is switched off and the
add-on is restarted. A failed encrypted message has no decoded body to record.

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
- `whatsapp.check_number` requires add-on and integration version 1.4.31 or
  newer. An endpoint/version error usually means only one half was updated.
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
- If HACS does not show the integration, confirm `hacs.json` exists at the repository root and `custom_components/whatsapp/manifest.json` exists.
- Isolated libsignal `Bad MAC` and session lifecycle messages are summarized by
  the add-on instead of logging full stack traces or session data. A confirmed
  high-volume decryption failure burst activates the recovery pause described
  above.

## Legacy integration migration

Add-on 1.4.31 retired the bundled compatibility component and removed the
add-on's read-write `/config` access. Updating or uninstalling the add-on leaves
any existing `/config/custom_components/whatsapp` directory untouched.

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

[hacs-badge]: https://img.shields.io/badge/HACS-Default-41BDF5.svg?style=flat-square
[hacs-url]: https://github.com/hacs/integration
[release-badge]: https://img.shields.io/github/v/release/moryoav/ha-addons?style=flat-square
[release-url]: https://github.com/moryoav/ha-addons/releases
[license-badge]: https://img.shields.io/github/license/moryoav/ha-addons?style=flat-square
[license-url]: https://github.com/moryoav/ha-addons/blob/main/LICENSE
