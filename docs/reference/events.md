# Events

The add-on fires these Home Assistant events:

See [incoming message examples](../examples/incoming-messages.md) for chat
filters, text extraction, media types, and conversation replies.

| Event type | Description |
| --- | --- |
| `new_whatsapp_message` | A received WhatsApp message. |
| `whatsapp_message_sent` | An outgoing WhatsApp message reported by the connected session. |
| `whatsapp_message_status` | A sent message was delivered, read, or played. |
| `whatsapp_chat_read` | Received messages were read or played on another device. |
| `whatsapp_call_update` | An incoming WhatsApp call lifecycle update. |
| `whatsapp_call_log` | One record per finished call, incoming or outgoing. |
| `whatsapp_presence_update` | A contact presence update. |
| `whatsapp_contacts_sync` | Available contact records from WhatsApp synchronization or contact updates. |
| `whatsapp_send_message_result` | Result event after a successful send action. |
| `whatsapp_addon_health_failure` | Sanitized diagnostics after a previous add-on run ends unhealthy. |

## Message events

`new_whatsapp_message` and `whatsapp_message_sent` include the configured
`clientId`, the detected message `type`, the Baileys message `key`, and the
`message` payload. Other fields, such as `messageTimestamp`, are passed through
when present.

With incoming media downloads enabled in add-on 2.0.0 or newer,
`new_whatsapp_message` also includes a `media` object with `status: ready`,
a decrypted `local_path`, an authenticated `url`, MIME type, size, and expiry.
The event waits until its file is ready. Failures still deliver the message
with `media.status: error` and a safe error code. Ordinary text and outgoing
events are unchanged. The download endpoint requires integration 2.0.0 or newer.
See [Decrypt incoming media](../examples/incoming-media.md) for setup,
the full event contract, retention, and processing examples.

Starting with add-on 2.8.0, the event for a poll vote also includes a
`poll_vote` object with the voter's selected options. See
[Poll votes](#poll-votes).

`whatsapp_message_sent` requires add-on 1.4.39 or newer. It fires for messages with
`key.fromMe: true`, including messages sent from the phone, other linked
devices, and the add-on itself when reported by WhatsApp. For this event,
`key.remoteJid` identifies the destination chat or group and can be a LID.
The dedupe checks apply to both directions. The event reports a sent
message observed by the session; it is not a delivery or read receipt.

The add-on sends the event directly to Home Assistant. Received-message
automations use `new_whatsapp_message`. Logging automations can listen to
both events, as in the [logging example](../examples/automations.md#log-received-and-sent-messages). Reply and mark-as-read automations should
keep listening only to the received-message event to avoid acting on own sends.

The dedupe layer runs before either message event is fired and tracks
each direction separately. Media dedupe ignores wrapper-only fields such as
thumbnails, CDN paths, scan sidecars, and media key timestamp representation
because WhatsApp can vary those between phone-number and LID deliveries of the
same message.

## Contact metadata

Starting with app 2.9.0, `whatsapp_contacts_sync` forwards each non-empty contact
batch supplied by Baileys. The app sends it directly to Home Assistant, so no
HACS integration update is needed.

| Field | Meaning |
| --- | --- |
| `clientId` | The configured WhatsApp account ID. |
| `source` | `messaging-history.set`, `contacts.upsert`, or `contacts.update`. |
| `contacts` | The decoded contact records from that Baileys event. |

For `messaging-history.set`, only its `contacts` array is forwarded. For the
other sources, the complete contact array is forwarded. Contact fields are
preserved as supplied, including:

| Contact field | Meaning |
| --- | --- |
| `id` | The record's identifier, which can be a phone JID, LID, or group JID. |
| `jid` | The phone JID, when available. |
| `lid` | The LID, when available. |
| `name` | The saved contact name; history contacts use the chat's name. |
| `notify` | The person's own WhatsApp profile name. |
| `verifiedName`, `imgUrl`, `status` | Additional name, picture, or status fields when supplied. |

`contacts.update` records can contain only an ID and the changed fields. Merge
updates by identifier and preserve existing values when a field is absent. A
single record may not contain both a name and a LID. Group records in the
history contact array can include the group ID and name; the event does not
fetch group participants or query the address book.

This is a stream of available batches, not a complete address-book snapshot.
Startup synchronization and later contact updates can supply different records.
The app does not resolve missing identifiers, cache contacts, replay prior
batches, or wait for contact metadata before delivering messages. Delivery uses
the existing Home Assistant event path with a 10-second HTTP timeout. A failed
delivery is logged without contact values and is not retried. Historical messages, authentication data,
and unrelated synchronization fields are not included.

Listen for `whatsapp_contacts_sync` in Home Assistant Developer Tools > Events
to inspect the batches supplied by your account.

## Chat archive state

Starting with add-on 2.2.0, every `new_whatsapp_message` event includes
`chat_archived`. Starting with add-on 2.2.1, `whatsapp_message_sent` includes
the same field for the destination chat:

| Value | Meaning |
| --- | --- |
| `true` | The latest known chat state is archived. |
| `false` | The latest known chat state is unarchived. |
| `null` | The add-on does not know this chat's archive state yet. |

The add-on listens to WhatsApp chat history and archive updates and looks up
the message's `key.remoteJid` in a local cache. There is no additional network
request or wait for chat synchronization when a message arrives. Changes on
the phone or another linked device take effect after WhatsApp synchronizes
them. If WhatsApp automatically unarchives a chat on a new message, the flag
follows that update; it does not describe the chat before the message arrived.

The cache stores only chat identifiers and archive flags alongside the account's
session data. Known flags survive restarts, remain separate between accounts,
and are cleared when the session is reset or logged out. Deleted chats are
removed. Up to 50,000 chat flags are retained; an evicted chat becomes unknown
until its state is received again.

After upgrading an existing session, unchanged chats can remain `null` until
WhatsApp supplies their state. The add-on does not force a full resync.
An absent archive flag is never treated as `false`. Chat identifiers are matched
exactly, so a phone-number JID does not imply a matching LID. A later state update
does not change an event that was already delivered. For media, the flag is
captured when the message is received, before the download finishes.

I use this condition to act only when the chat is known to be unarchived:

```yaml
conditions:
  - condition: template
    value_template: "{{ trigger.event.data.get('chat_archived') is sameas false }}"
```

This condition also skips unknown states and works with either message event.
Only the add-on needs updating; no HACS integration update is required.

## Poll votes

WhatsApp encrypts a poll vote with a secret that only the poll's own message
carries, so a vote by itself shows which poll it belongs to but not the choice.
Starting with add-on 2.8.0, the add-on remembers the polls it sees and adds a
`poll_vote` object to each vote's message event (`type: pollUpdateMessage`):

| Field | Meaning |
| --- | --- |
| `status` | `ready` when the vote was decoded, `error` when it was not. |
| `poll_id` | Message ID of the poll. For a poll sent from Home Assistant, this is the `message_id` returned by `whatsapp.send_message`. |
| `poll_name` | The poll's question. Present with `ready`. |
| `selected_options` | Names of the options the voter has selected now, in the poll's own order. Present with `ready`. |
| `error` | Why the vote was not decoded. Present with `error`. |

Each vote event carries the voter's complete current selection, not a change.
A multiple-choice vote lists every selected option, and an empty list means the
voter withdrew the vote. The add-on does not keep totals. The voter is
`key.participant` in a group and `key.remoteJid` in a direct chat. Votes this
account casts on the phone arrive in `whatsapp_message_sent` with the same
object. Other message types have no `poll_vote` field.

This works for polls sent from Home Assistant, from the phone, and by other
people, in direct chats and groups, once the add-on has received the poll on
version 2.8.0 or newer.

For each account, the add-on keeps the secret, question, and option names of
the newest 100 polls, each for 30 days, alongside the account's session data.
Remembered polls survive restarts, remain separate between accounts, and are
cleared when the session is reset or logged out. The secret is never sent to
Home Assistant, including in wrapped message events and send results. Wrapped
votes use the same `pollUpdateMessage` event type as unwrapped votes.

| `error` | Meaning |
| --- | --- |
| `unknown_poll` | The add-on does not have this poll: it was sent before the update to 2.8.0, more than 30 days ago, or is no longer among the newest 100. Also reported for a vote that arrives in a different chat than its poll. |
| `decrypt_failed` | The poll is known, but the vote could not be decrypted with it. |
| `unknown_option` | The vote selects an option that is not in the remembered poll. |

Only the add-on needs updating; no HACS integration update is required. See
[React to a poll vote](../examples/messages.md#react-to-a-poll-vote) for an
automation.

## Capture a send-result event

The integration fires `whatsapp_send_message_result` after a successful
`whatsapp.send_message` call. Its fields are `client_id`, `to`, `body`, and
`sent_message`. This event uses **`client_id`**, while incoming and outgoing
message events use **`clientId`**. It is not a delivery receipt and does not
collect messages sent from the phone.

I store the last message ID in a Text helper. Create
`input_text.whatsapp_last_sent_id` with a maximum length of 255, then filter
the collector to one client and destination:

```yaml
- alias: Store the last WhatsApp text notification ID
  triggers:
    - trigger: event
      event_type: whatsapp_send_message_result
      event_data:
        client_id: default
        to: 120363000000000000@g.us
  conditions:
    - condition: template
      value_template: >-
        {% set body = trigger.event.data.get('body', {}) %}
        {{ body is mapping and 'text' in body and 'edit' not in body }}
  actions:
    - action: input_text.set_value
      target:
        entity_id: input_text.whatsapp_last_sent_id
      data:
        value: "{{ trigger.event.data.sent_message.key.id }}"
  mode: queued
```

The `to` filter matches the action's original target exactly. A send to a phone
number will not match a filter containing its LID. The body condition excludes
reaction, edit, and delete results from this text-notification collector.

The helper holds the latest matching ID, so another send can overwrite it.
For a specific task, use the action's [response variable](../examples/messages.md#capture-the-sent-message-id)
and preserve the [full message key](../examples/scripts.md#save-a-message-key-for-another-run).

## Receipt events

`whatsapp_message_status` fires when a message this account sent, from Home
Assistant or the phone, is delivered, read, or played. Its data contains
`clientId`, `messageId`, `chatId`, `status` (`delivered`, `read`, `played`, or
`error`), `participant`, and `timestamp`. `messageId` matches the `message_id`
returned by `whatsapp.send_message`. In a direct chat, `participant` and
`timestamp` are `null`. In a group, every member's receipt is a separate event,
with `participant` set to that member and `timestamp` to the receipt time;
WhatsApp reports a voice message played in a group as `read`. Recipients who
turned off read receipts only produce `delivered`. Receipts for status updates
(stories) are not reported.

`whatsapp_chat_read` fires when this account reads or plays received messages on
another device, such as the phone. Its data contains `clientId`, `chatId`,
`status` (`read`, or `played` for voice messages), and `messageIds`, the IDs of
the received messages that were read. A large batch is split across several
events of at most 100 IDs. Check `messageIds` for the message you care about,
for example to dismiss its Home Assistant notification once you have read it on
the phone.

Both events need add-on version 2.5.0 or newer. See the
[unread-alert escalation](../examples/automations.md#escalate-when-an-alert-is-not-read) and
[notification dismissal](../examples/automations.md#dismiss-a-notification-after-reading-the-chat-on-the-phone)
examples.

## Call events

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

For a call answered on the phone or another device, `accept` is followed almost
immediately by `terminate`: the call stopped ringing on the add-on's linked
device, not the end of the call. WhatsApp sends a linked device nothing more
about an answered call, so there is no update when it ends. `ringing` can fire
once for each of your devices; trigger on `offer` to act once per call.

Starting with version 2.3.0, `whatsapp.reject_call` declines an incoming call.
Pass the `callId` and `from` values of its `offer` event, as in the
[night-time example](../examples/automations.md#decline-calls-at-night-and-reply-with-a-message).
WhatsApp does not let a linked device start calls, and it does not report calls
made from the phone as call events; `whatsapp_call_log` reports them after they
end.

## Call log events

`whatsapp_call_log` fires once for each finished call, in either direction.
Its data contains `clientId`, `callId`, `direction` (`incoming` or `outgoing`),
`result`, `isVideo`, `durationSeconds`, `startedAt`, `peer`, `participants`,
and `groupJid`. `peer` is the other person's phone JID or LID.

- **Outgoing calls** made from the phone come from the call history the phone
  shares with the add-on, usually about 15 seconds after the call ends.
  `result` is WhatsApp's own outcome: `connected`, `missed`, `rejected`,
  `cancelled`, `unavailable`, `failed`, `abandoned`, `accepted_elsewhere`,
  `invalid`, or `unknown`. `durationSeconds` is the call length, and
  `participants` lists each called person as `{jid, result}`.
- **Incoming calls** are followed through their `whatsapp_call_update` events
  and reported when they stop ringing. `result` is `answered`, `declined`
  (rejected on a device or with `whatsapp.reject_call`), or `missed`.
  `durationSeconds` is always `null` and `participants` is empty, because
  WhatsApp does not tell a linked device when an answered call ends or who
  else joined it.

Calls are reported only while the add-on is connected, and only once per
`callId`. An incoming call whose `offer` the add-on did not see, or whose ending
does not arrive within 10 minutes, is not reported. See the
[missed-call example](../examples/automations.md#notify-about-missed-calls).

## Health events

`whatsapp_addon_health_failure` fires on the next successful startup when the
saved history ends with three consecutive failed native health checks. Its
bounded data includes timestamps, failure classification, HTTP and curl result,
probe timings and streak, plus available process and container metrics. It never
includes message contents, account identifiers, URLs, headers, tokens, or raw
response bodies.

`whatsapp_addon_health_failure` includes its schema and service, a run id,
first and last failure timestamps, failure count and streak, the bounded failure
classification, HTTP and curl result, probe timings, and any available bounded
process or container metrics. It contains no message contents, account
identifiers, URLs, headers, tokens, or raw response bodies.

Isolated libsignal `Bad MAC`, message-counter, and session lifecycle console
logs are filtered and summarized as counts instead of exposing full stack
traces or session data. A confirmed high-volume decryption failure burst
activates the recovery pause described in the [add-on documentation](https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/DOCS.md#encryption-recovery).
