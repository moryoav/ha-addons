# WhatsApp for Home Assistant

Send WhatsApp messages from Home Assistant automations and receive message,
receipt, call, contact, and presence events.

This project has two parts: the **WhatsappV2 add-on** runs the local WhatsApp
Web bridge, and the **WhatsApp integration** connects it to Home Assistant.
Install both parts before using the examples in this knowledge base.

## Getting started

- [Install and configure the add-on and integration](https://github.com/moryoav/ha-addons#installation).
- [Review add-on options and the web UI](https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/DOCS.md).

The examples use fictional phone numbers and synthetic identifiers. Replace
`clientId`, recipients, and entity IDs with the values from your installation.
Each example lists any additional integration or custom helper it needs.

## What it can do

**Devices and sensors:** One shared WhatsApp app device shows App connection.
Each configured account gets its own device with WhatsApp connection and
Session state. All status entities refresh together every 30 seconds. See
[Devices and sensors](reference/entities.md) for setup, states, and examples.

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
| `get_contacts` | Fetch saved contact names and identifiers from WhatsApp. |

**Events:**

| Event | Fires when |
| --- | --- |
| `new_whatsapp_message` | A message is received, optionally with its [decrypted media](examples/incoming-media.md), the chat's archive state, and the choice in a [poll vote](reference/events.md#poll-votes). |
| `whatsapp_message_sent` | This account sends a message, from Home Assistant, the phone, or another device. |
| `whatsapp_message_status` | A sent message is delivered, read, or played. |
| `whatsapp_chat_read` | You read or play received messages on another device, such as the phone. |
| `whatsapp_call_update` | An incoming call rings, is answered, declined, or stops ringing. |
| `whatsapp_call_log` | A call ends, incoming or made from the phone. |
| `whatsapp_presence_update` | A followed contact's presence changes. |
| `whatsapp_contacts_sync` | WhatsApp supplies contact names and identifiers through synchronization or contact updates. |
| `whatsapp_send_message_result` | `send_message` finishes. |
| `whatsapp_addon_health_failure` | The add-on restarts after its health checks failed. |

## Important limitation

This project uses WhatsApp Web through an unofficial client library. WhatsApp
may restrict or block accounts that use unofficial clients. Use a dedicated
account if that risk matters to you.

## Decrypted incoming media

Receive ready-to-use local files and authenticated links for images, voice
notes, audio, documents, videos, and stickers. Enable **Download incoming media**
in the add-on configuration to use attachments in OCR, transcription, document
processing, and other automations. Each file is unique and expires automatically.

See [Decrypt incoming media](examples/incoming-media.md) for setup, retention,
event fields, and a processing example.

## Examples

| Topic | Examples |
| --- | --- |
| [Messages and media](examples/messages.md) | Text, stickers, documents, videos, polls and poll votes, voice messages, locations, reactions, edits, deletion, and quoted follow-ups. |
| [Recipients and lookups](examples/recipients.md) | Phone JIDs, LIDs, group lists and IDs, registration checks, saved contacts, and contact profiles. |
| [Presence](examples/presence.md) | Subscriptions, online notifications, typing indicators, and a bounded typing loop. |
| [Automations](examples/automations.md) | Declining calls, call logs, unread-alert escalation, logging, replies, read markers, arrival messages, sensor alerts, and webhooks. |
| [Reusable scripts](examples/scripts.md) | Return send responses, quote notifications, save message keys, and send files prepared by helpers. |
| [Decrypt incoming media](examples/incoming-media.md) | Enable downloads, process decrypted files, and manage retention and storage limits. |
| [Incoming messages and agents](examples/incoming-messages.md) | Filter chats, extract text, reply with a conversation agent, and recognize incoming media. |
| [AI-written notifications](examples/ai-notifications.md) | Rephrase routine notifications with a fallback to the original text. |
| [Conversation history](examples/conversation-history.md) | Keep recent exchanges in a file and use them in replies to one chat. |
| [Sensor charts](examples/sensor-charts.md) | Log readings to Google Sheets and send a published chart with a sensor alert. |

## Reference

- [Devices and sensors](reference/entities.md): app connection and account status.
- [Actions](reference/actions.md): the Home Assistant actions exposed by the integration.
- [Events](reference/events.md): message, receipt, call, contact, presence, send-result, and health events.

## Support

- [Troubleshooting](https://github.com/moryoav/ha-addons#troubleshooting)
- [Support](https://github.com/moryoav/ha-addons/blob/main/SUPPORT.md)
- [Changelog](https://github.com/moryoav/ha-addons/blob/main/CHANGELOG.md)

## Privacy

WhatsApp events and Home Assistant automation traces can contain phone JIDs,
LIDs, call and message keys, quoted-message data, contact names, and message
bodies. Saved media files and Decryption Diagnostics captures can also contain
private information. Redact these fields, QR codes, session data, and
`api_token` before sharing diagnostics, logs, screenshots, or traces.
