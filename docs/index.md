# WhatsApp for Home Assistant

Send WhatsApp messages from Home Assistant automations and receive message,
call, and presence events through the companion add-on.

## Examples

| Topic | Examples |
| --- | --- |
| [Messages and media](examples/messages.md) | Text, stickers, documents, videos, polls, voice messages, locations, reactions, and quoted follow-ups. |
| [Recipients and number lookup](examples/recipients.md) | Phone JIDs, LIDs, groups, and registration checks. |
| [Presence](examples/presence.md) | Subscriptions, online notifications, typing indicators, and a bounded typing loop. |
| [Automations](examples/automations.md) | Calls, logging, replies, read markers, arrival messages, sensor alerts, and webhooks. |
| [Reusable scripts](examples/scripts.md) | Return send responses, quote notifications, save message keys, and send files prepared by helpers. |
| [Incoming messages and agents](examples/incoming-messages.md) | Filter chats, extract text, reply with a conversation agent, and recognize incoming media. |

## Reference

- [Actions](reference/actions.md): the Home Assistant actions exposed by the integration.
- [Events](reference/events.md): message, call, presence, send-result, and health events.

The examples use fictional phone numbers and synthetic identifiers. Replace
`clientId`, recipients, and entity IDs with the values from your installation.

I adapted the additional recipes from existing Home Assistant automations and
scripts. I also verified poll creation with a live send and a returned vote
event. Examples that need another integration or a custom helper list that
dependency.

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
