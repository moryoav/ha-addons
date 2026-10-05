# WhatsApp for Home Assistant

**New in 2.0: [decrypt incoming media](examples/incoming-media.md).** Receive
ready-to-use local files and authenticated links for photos, voice notes,
documents, videos, and stickers. Use them in Home Assistant OCR, transcription,
and other processing automations, with automatic retention and unique files
for every attachment.

Send WhatsApp messages from Home Assistant automations and receive message,
receipt, call, and presence events through the companion add-on.

## What it can do

**Actions** (under the `whatsapp` domain):

| Action | What it does | Since |
| --- | --- | --- |
| `send_message` | Send text, images, videos, documents, stickers, voice messages, locations, contacts, polls, reactions, edits, deletions, and quoted replies. | 1.x |
| `read_messages` | Mark a received message as read. | 1.x |
| `presence_subscribe`, `send_presence_update`, `send_infinity_presence_update` | Follow a contact's presence and show online, typing, or recording. | 1.x |
| `set_status` | Set the account's about text. | 1.x |
| `check_number` | Check whether a phone number is on WhatsApp and get its LID. | 1.4.31 |
| `get_group_info` | Get a group's name, description, settings, and members. | 2.1.0 |
| `reject_call` | Decline an incoming call. | 2.3.0 |
| `get_profile` | Get a contact's profile picture, about text, and business profile, or a group's picture. | 2.5.0 |
| `list_groups` | List every group the account belongs to. | 2.5.0 |

**Events:**

| Event | Fires when | Since |
| --- | --- | --- |
| `new_whatsapp_message` | A message is received, optionally with its [decrypted media](examples/incoming-media.md), the chat's archive state, and the choice in a [poll vote](reference/events.md#poll-votes). | 1.x |
| `whatsapp_message_sent` | This account sends a message, from Home Assistant, the phone, or another device. | 1.4.39 |
| `whatsapp_message_status` | A sent message is delivered, read, or played. | 2.5.0 |
| `whatsapp_chat_read` | You read or play received messages on another device, such as the phone. | 2.5.0 |
| `whatsapp_call_update` | An incoming call rings, is answered, declined, or stops ringing. | 1.x |
| `whatsapp_call_log` | A call ends, incoming or made from the phone. | 2.4.0 |
| `whatsapp_presence_update` | A followed contact's presence changes. | 1.x |
| `whatsapp_send_message_result` | `send_message` finishes. | 1.x |
| `whatsapp_addon_health_failure` | The add-on restarts after its health checks failed. | 1.x |

## Examples

| Topic | Examples |
| --- | --- |
| [Messages and media](examples/messages.md) | Text, stickers, documents, videos, polls and poll votes, voice messages, locations, reactions, edits, deletion, and quoted follow-ups. |
| [Recipients and lookups](examples/recipients.md) | Phone JIDs, LIDs, group lists and IDs, registration checks, and contact profiles. |
| [Presence](examples/presence.md) | Subscriptions, online notifications, typing indicators, and a bounded typing loop. |
| [Automations](examples/automations.md) | Declining calls, call logs, unread-alert escalation, logging, replies, read markers, arrival messages, sensor alerts, and webhooks. |
| [Reusable scripts](examples/scripts.md) | Return send responses, quote notifications, save message keys, and send files prepared by helpers. |
| [Incoming messages and agents](examples/incoming-messages.md) | Filter chats, extract text, reply with a conversation agent, and recognize incoming media. |
| [AI-written notifications](examples/ai-notifications.md) | Rephrase routine notifications with a fallback to the original text. |
| [Conversation history](examples/conversation-history.md) | Keep recent exchanges in a file and use them in replies to one chat. |
| [Sensor charts](examples/sensor-charts.md) | Log readings to Google Sheets and send a published chart with a sensor alert. |

## Reference

- [Actions](reference/actions.md): the Home Assistant actions exposed by the integration.
- [Events](reference/events.md): message, receipt, call, presence, send-result, and health events.

The examples use fictional phone numbers and synthetic identifiers. Replace
`clientId`, recipients, and entity IDs with the values from your installation.

Examples that need another integration or a custom helper list that dependency.

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
