[![Buy Me a Coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/zkfpkdwyhyq)

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

## What changed in this fork

This add-on is maintained in the `moryoav/ha-addons` fork. The current fork keeps the original add-on shape and Home Assistant service/event schema, while adding maintenance fixes needed for current WhatsApp/Baileys behavior.

- The add-on metadata and installation URL now point at `https://github.com/moryoav/ha-addons`.
- Baileys is updated to `@whiskeysockets/baileys@6.7.18` and built into the add-on image during Docker build.
- Direct WhatsApp IDs can be phone-based JIDs, group/broadcast JIDs, or new LID JIDs such as `90855889203418@lid`.
- Inbound duplicate phone/LID events are dropped before `new_whatsapp_message` is fired into Home Assistant. The duplicate check ignores `remoteJid`, hashes the normalized message payload, and uses a 5 minute in-memory TTL.
- If the same WhatsApp message id and type arrives with different content, the message is allowed and a collision warning is logged.
- `whatsapp.send_message` returns Home Assistant response data when called with `response_variable`; the existing `whatsapp_send_message_result` event is still fired.
- `whatsapp.read_messages` marks received messages as read by passing the received Baileys message key back to the add-on.
- Recoverable libsignal `Bad MAC` and session lifecycle console output is filtered into compact count summaries so logs do not include stack traces or session objects for known noisy cases.

See [DOCS.md](DOCS.md) for service examples and [CHANGELOG.md](CHANGELOG.md) for release notes.

# Installation guide

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

## Release note

Every add-on change should bump `whatsapp_addon/config.yaml` so Home Assistant can detect the update.
