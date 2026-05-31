# Home Assistant Add-on: WhatsappV2

Write WhatsApp messages from Home Assistant and receive WhatsApp message events.

<img src="https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/logo.png?raw=true" width="400"/>

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

This add-on runs the local WhatsApp Web bridge used by the `whatsapp` Home Assistant integration in this repository.

## Important limitation

This project uses WhatsApp Web through an unofficial client library. WhatsApp does not officially support bots or unofficial clients, so account restrictions or blocking are possible. Use a dedicated account if that risk matters to you.

## Installation

Add this repository as a Home Assistant add-on repository:

```text
https://github.com/moryoav/ha-addons
```

Install and start `WhatsappV2`. In a few seconds, Home Assistant should show a persistent notification with a QR code. Scan it with the WhatsApp mobile app.

For the modern integration setup, install `custom_components/whatsapp` through HACS or manually, then add the WhatsApp integration from Home Assistant's Devices & services page.

## Add-on options

- `clients`: one or more WhatsApp session names. The default is `default`.

Each client gets its own persisted session and must be referenced by `clientId` in service calls.

## Compatibility behavior

If `/config/custom_components/whatsapp/manifest.json` already exists, the add-on leaves it in place so HACS can manage the integration. If no custom component exists, the add-on installs its bundled compatibility component.

## Documentation

See [../README.md](../README.md) for HACS integration setup, actions, events, examples, troubleshooting, and removal instructions.

See [DOCS.md](DOCS.md) for additional action examples and [CHANGELOG.md](CHANGELOG.md) for add-on release notes.

## Release note

Every add-on change should bump `whatsapp_addon/config.yaml` so Home Assistant can detect the update.
