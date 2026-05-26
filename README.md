[![Buy Me a Coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/zkfpkdwyhyq)
[![Open your Home Assistant instance and show the add add-on repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fmoryoav%2Fha-addons)

# Home Assistant Add-on: WhatsappV2

_Write your Whatsapp message from Home Assistant_

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

A WhatsApp API client that connects through the WhatsApp Web browser app

**NOTE:** I can't guarantee you will not be blocked by using this method, although it has worked for me. WhatsApp does not allow bots or unofficial clients on their platform, so this shouldn't be considered totally safe.

## This fork

This repository is the active fork at:

```text
https://github.com/moryoav/ha-addons
```

Notable changes since the original add-on include:

- Add-on metadata now points at this fork and the add-on is published as `WhatsappV2`.
- Baileys is built from `@whiskeysockets/baileys@6.7.18` during the add-on build.
- WhatsApp LID identifiers such as `90855889203418@lid` are accepted alongside phone-number JIDs such as `972522241857@s.whatsapp.net`.
- Duplicate inbound phone/LID events are deduplicated before Home Assistant receives `new_whatsapp_message`.
- `whatsapp.send_message` can return response data to Home Assistant automations and also fires `whatsapp_send_message_result` for compatibility.
- `whatsapp.read_messages` is available for marking received messages as read.
- Recoverable libsignal `Bad MAC` and session lifecycle console noise is summarized instead of dumping stack traces and session objects to the add-on log.

See [whatsapp_addon/DOCS.md](whatsapp_addon/DOCS.md) for usage examples and [whatsapp_addon/CHANGELOG.md](whatsapp_addon/CHANGELOG.md) for release notes.

## Installation guide
Install add-on from this repository:

```text
https://github.com/moryoav/ha-addons
```

Start the add-on and in a few seconds you will see a persistent notification with QRCode, please scan this one with Whatsapp Mobile app.

After add-on installation restart Home Assistant and then copy the following code in _configuration.yaml_

```yaml
whatsapp:
```

Then restart Home Assistant. If all went well you will see a _whatsapp.send_message_ service.
