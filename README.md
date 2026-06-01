# WhatsApp for Home Assistant

[![HACS][hacs-badge]][hacs-url] [![release][release-badge]][release-url] ![downloads][downloads-badge] [![license][license-badge]][license-url]

Send WhatsApp messages from Home Assistant automations and receive WhatsApp message and presence events through the companion add-on.

<img src="https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/logo.png?raw=true" width="320"/>

![Supports aarch64 Architecture][aarch64-shield]
![Supports amd64 Architecture][amd64-shield]
![Supports armhf Architecture][armhf-shield]
![Supports armv7 Architecture][armv7-shield]
![Supports i386 Architecture][i386-shield]

[aarch64-shield]: https://img.shields.io/badge/aarch64-yes-green.svg
[amd64-shield]: https://img.shields.io/badge/amd64-yes-green.svg
[armhf-shield]: https://img.shields.io/badge/armhf-yes-green.svg
[armv7-shield]: https://img.shields.io/badge/armv7-yes-green.svg
[i386-shield]: https://img.shields.io/badge/i386-yes-green.svg

This repository contains two pieces:

- `whatsapp_addon`: the Home Assistant add-on that runs the local WhatsApp Web client bridge.
- `custom_components/whatsapp`: the Home Assistant integration that exposes actions, diagnostics, setup flow support, and add-on connectivity.

The integration talks only to the local add-on HTTP API. WhatsApp account pairing is handled by the add-on QR-code flow.

## Important limitation

This project uses WhatsApp Web through an unofficial client library. WhatsApp does not officially support bots or unofficial clients, so account restrictions or blocking are possible. Use a dedicated account if that risk matters to you.

## Security notes

The packaged add-on follows the current Home Assistant app presentation guidance where it is relevant to this project:

- No HTTP port is published to the LAN.
- The local bridge API is used from the Home Assistant add-on network.
- A custom AppArmor profile is included and AppArmor is enabled.
- No Docker API access.
- No host network, host PID, or host UTS access.
- No `full_access` mode.
- No privileged capabilities.
- No elevated Supervisor role.
- A Supervisor watchdog uses the local `/health` endpoint.
- Home Assistant Ingress is enabled for the add-on web UI.
- The web UI listener only accepts the Supervisor ingress proxy address, and no HTTP port is published to the LAN.
- QR pairing is shown in the add-on web UI and through Home Assistant persistent notifications.

The `/config` mount is read-write so the add-on can preserve compatibility with legacy manual installs. When HACS or a manual install already manages `/config/custom_components/whatsapp`, the add-on leaves those files in place.

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

Install the integration with HACS as a custom repository until it is accepted as a HACS default:

1. Open HACS.
2. Open the three-dot menu and choose custom repositories.
3. Add `https://github.com/moryoav/ha-addons`.
4. Select category `Integration`.
5. Install `WhatsApp`.
6. Restart Home Assistant.

Manual installation is also supported by copying `custom_components/whatsapp` into:

```text
/config/custom_components/whatsapp
```

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

- `clients`: one or more WhatsApp session names. The default is `default`.

Each client gets its own QR-code pairing flow and persisted add-on session data.

The add-on page includes an Open Web UI action through Home Assistant Ingress. The web UI shows each configured session, its connection state, and the current QR code when a session is waiting for pairing.

### Integration

The integration has no user-entered setup parameters. It detects the running add-on through Home Assistant Supervisor discovery.

You can use the integration entry menu to reconfigure later; reconfiguration rediscovers the add-on URL automatically.

## Actions

The integration registers these Home Assistant actions under the `whatsapp` domain:

- `whatsapp.send_message`: send text, media, location, reactions, or any payload supported by the add-on.
- `whatsapp.set_status`: set the WhatsApp account status text.
- `whatsapp.presence_subscribe`: subscribe to presence updates for a contact.
- `whatsapp.send_presence_update`: send a one-shot presence update.
- `whatsapp.send_infinity_presence_update`: send a long-running presence update.
- `whatsapp.read_messages`: mark received messages as read.

`whatsapp.send_message` can return response data when called with `response_variable`; it also fires the compatibility event `whatsapp_send_message_result`.

## Events

The add-on fires these Home Assistant events:

| Event type | Description |
| --- | --- |
| `new_whatsapp_message` | A received WhatsApp message. |
| `whatsapp_presence_update` | A contact presence update. |
| `whatsapp_send_message_result` | Compatibility result event after sending a message. |

`new_whatsapp_message` includes the configured `clientId`, the detected message `type`, the Baileys message `key`, and the message payload.

## Supported identifiers

Message targets can use:

- Phone-number user JID, such as `391234567890@s.whatsapp.net`.
- WhatsApp LID user JID, such as `90855889203418@lid`.
- Group JID, such as `1234567890-123456789@g.us`.
- Broadcast JID, such as `status@broadcast`.

When replying to an incoming event, the safest target is usually:

```jinja2
{{ trigger.event.data.key.remoteJid }}
```

## Examples

### Send a text message

```yaml
service: whatsapp.send_message
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
  body:
    text: Hi from Home Assistant
```

### Capture the sent message id

```yaml
- service: whatsapp.send_message
  response_variable: whatsapp_result
  data:
    clientId: default
    to: 391234567890@s.whatsapp.net
    body:
      text: This call stores the sent WhatsApp message id.
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
    - service: whatsapp.send_message
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
    - service: whatsapp.read_messages
      data:
        clientId: "{{ trigger.event.data.clientId }}"
        body:
          keys:
            id: "{{ trigger.event.data.key.id }}"
            remoteJid: "{{ trigger.event.data.key.remoteJid }}"
            fromMe: "{{ trigger.event.data.key.fromMe }}"
  mode: queued
```

## Data updates

The integration does not poll WhatsApp. The add-on pushes message and presence events into Home Assistant as they arrive, advertises its local API through Supervisor discovery, and actions call the local add-on API on demand.

## Diagnostics

The integration supports Home Assistant diagnostics. Diagnostics include whether the add-on was detected, whether the add-on health endpoint is reachable, and the number of configured add-on clients. The detected URL and message contents are not included.

## Troubleshooting

- If setup cannot connect, confirm the add-on is installed and running, then restart the add-on so it can publish Supervisor discovery.
- If actions fail with a client error, confirm the `clientId` exists in the add-on options and has completed QR-code pairing.
- If messages are not received, check the add-on web UI and logs for QR-code, session, and WhatsApp connection messages.
- If HACS does not show the integration, confirm `hacs.json` exists at the repository root and `custom_components/whatsapp/manifest.json` exists.
- Recoverable libsignal `Bad MAC` and session lifecycle messages are summarized by the add-on instead of logging full stack traces or session data.

## Removal

1. Delete the WhatsApp integration from Home Assistant.
2. Remove the `WhatsappV2` add-on.
3. Remove any legacy `whatsapp:` YAML from `configuration.yaml` if you still have it.
4. Delete `/config/custom_components/whatsapp` if you installed manually.
5. Restart Home Assistant.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development notes, [SECURITY.md](SECURITY.md) for vulnerability reporting, and [CHANGELOG.md](CHANGELOG.md) for release history.

[hacs-badge]: https://img.shields.io/badge/HACS-Custom-41BDF5.svg?style=flat-square
[hacs-url]: https://github.com/hacs/integration
[release-badge]: https://img.shields.io/github/v/release/moryoav/ha-addons?style=flat-square
[release-url]: https://github.com/moryoav/ha-addons/releases
[downloads-badge]: https://img.shields.io/github/downloads/moryoav/ha-addons/total?style=flat-square
[license-badge]: https://img.shields.io/github/license/moryoav/ha-addons?style=flat-square
[license-url]: https://github.com/moryoav/ha-addons/blob/main/LICENSE
