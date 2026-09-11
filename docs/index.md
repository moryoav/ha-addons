# WhatsApp for Home Assistant

Send WhatsApp messages from Home Assistant automations and receive message,
call, and presence events through the companion add-on.

## Examples

| Topic | Examples |
| --- | --- |
| [Messages and media](examples/messages.md) | Text, send responses, images, voice messages, locations, and reactions. |
| [Recipients and number lookup](examples/recipients.md) | Phone JIDs, LIDs, groups, and registration checks. |
| [Presence](examples/presence.md) | Subscribe to a contact and notify when they are available. |
| [Automations](examples/automations.md) | Incoming calls, message logging, replies, read markers, and arrival messages. |

## Reference

- [Actions](reference/actions.md): the Home Assistant actions exposed by the integration.
- [Events](reference/events.md): message, call, presence, send-result, and health events.

The examples use fictional phone numbers and synthetic identifiers. Replace
`clientId`, recipients, and entity IDs with the values from your installation.

## Setup and support

- [Installation and configuration](https://github.com/moryoav/ha-addons#installation)
- [Add-on options and web UI](https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/DOCS.md)
- [Troubleshooting](https://github.com/moryoav/ha-addons#troubleshooting)
- [Support](https://github.com/moryoav/ha-addons/blob/main/SUPPORT.md)
- [Changelog](https://github.com/moryoav/ha-addons/blob/main/CHANGELOG.md)

## Important limitation

This project uses WhatsApp Web through an unofficial client library. WhatsApp does not officially support bots or unofficial clients, so account restrictions or blocking are possible. Use a dedicated account if that risk matters to you.

## Privacy

WhatsApp message and call events and Home Assistant automation traces can
contain phone JIDs, LIDs, call and message keys, quoted-message data, and
message bodies. The add-on does not log raw identifiers or message bodies, but
Home Assistant may retain event and action data. Redact these fields, QR codes,
session data, and `api_token` before sharing diagnostics, logs, screenshots, or
traces.
