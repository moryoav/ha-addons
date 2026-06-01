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

## Security notes

- No HTTP port is published to the LAN.
- The local bridge API is used from the Home Assistant add-on network.
- A custom AppArmor profile is included and AppArmor is enabled.
- No Docker API access, host network, host PID, host UTS, `full_access`, privileged capabilities, or elevated Supervisor role are used.
- `/config` is mounted read-write only to preserve compatibility with legacy custom component installs.
- A Supervisor watchdog uses the local `/health` endpoint.
- Home Assistant Ingress is enabled for the add-on web UI.
- The web UI listener only accepts the Supervisor ingress proxy address, and no HTTP port is published to the LAN.
- QR pairing is shown in the add-on web UI and through Home Assistant persistent notifications.

## Stable and canary builds

Use the default repository URL for stable releases:

```text
https://github.com/moryoav/ha-addons
```

This repository does not currently publish a separate canary or `next` branch. If a canary channel is introduced later, it will be documented with its `#branch` repository URL and a distinct add-on name.

## Installation

### 1. Add the add-on repository

[![Add the WhatsApp add-on repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fmoryoav%2Fha-addons)

Use the button above to add this repository to Home Assistant's Apps store.

If you prefer to do it manually:

1. Go to **Settings** -> **Apps**.
2. Open the menu in the top right.
3. Choose **Repositories**.
4. Add this repository URL:

```text
https://github.com/moryoav/ha-addons
```

### 2. Install and start the add-on

[![Open the WhatsappV2 add-on page](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=ea396823_whatsapp_addon&repository_url=https%3A%2F%2Fgithub.com%2Fmoryoav%2Fha-addons)

Use the button above after adding the repository. It opens the `WhatsappV2` add-on page.

1. Install `WhatsappV2`.
2. Review the add-on options.
3. Start the add-on.

In a few seconds, Home Assistant should show a persistent notification with a QR code. You can also open the add-on web UI from the add-on page to view session status and the current pairing QR code. Scan the QR code with the WhatsApp mobile app.

### 3. Install the custom integration

The add-on runs the local WhatsApp bridge. The `whatsapp` custom integration exposes the Home Assistant actions, events, diagnostics, and setup flow that use that bridge. Install the integration with HACS or manually.

#### HACS

[![Open the WhatsApp HACS repository](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=moryoav&repository=ha-addons&category=integration)

Use the button above to add and open the WhatsApp custom repository in HACS.

If you prefer to do it manually:

1. Open HACS.
2. Add a custom repository.
3. Use this URL:

```text
https://github.com/moryoav/ha-addons
```

4. Select category **Integration**.
5. Install **WhatsApp**.
6. Restart Home Assistant.

#### Manual

Copy:

```text
custom_components/whatsapp
```

to:

```text
/config/custom_components/whatsapp
```

Then restart Home Assistant.

### 4. Add the integration

[![Add the WhatsApp integration](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=whatsapp)

Use the button above after Home Assistant restarts. It opens the **WhatsApp** integration setup flow.

In Home Assistant:

1. Go to **Settings** -> **Devices & services**.
2. Add integration **WhatsApp**.

The add-on advertises its local API through Supervisor discovery, so the integration does not ask for a URL. If setup cannot detect the add-on yet, confirm `WhatsappV2` is running, then restart the add-on and submit the setup flow again.

## Add-on options

- `clients`: one or more WhatsApp session names. The default is `default`.

Each client gets its own persisted session and must be referenced by `clientId` in service calls.

The add-on page includes an Open Web UI action through Home Assistant Ingress. The web UI shows each configured session, its connection state, and the current QR code when a session is waiting for pairing.

## Compatibility behavior

If `/config/custom_components/whatsapp/manifest.json` already exists, the add-on leaves it in place so HACS can manage the integration. If no custom component exists, the add-on installs its bundled compatibility component.

The add-on also registers a Supervisor discovery message on startup so Home Assistant can create or update the WhatsApp integration automatically.

## Documentation

See [the repository README](https://github.com/moryoav/ha-addons/blob/main/README.md) for HACS integration setup, actions, events, examples, troubleshooting, and removal instructions.

See [the add-on documentation](https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/DOCS.md) for additional action examples and [the add-on changelog](https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/CHANGELOG.md) for release notes.
