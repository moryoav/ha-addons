# Recipients and number lookup

## Choose the sending account

For notifications on my personal phone, I link a separate WhatsApp account to
the add-on and send from that account to my personal account or a shared group.
Messages sent by the integration belong to the linked account. Linking my
personal account makes the bot send as me, so those sends are not incoming
messages from a separate contact.
Follow the [current installation guide](https://github.com/moryoav/ha-addons#installation)
to pair that account with this add-on.

## Supported identifiers

Message targets can use:

- Phone-number user JID, such as the fictional `12025550123@s.whatsapp.net`.
- WhatsApp LID user JID, such as the synthetic `999000111222333@lid`.
- Group JID, such as the synthetic `120363000000000000@g.us`.
- Broadcast JID, such as `status@broadcast`.

**For direct chats, use LID (`@lid`) targets whenever
available.**
Phone-number JIDs (`@s.whatsapp.net`) are less reliable with Baileys. Run
`whatsapp.check_number` with the phone number, then use the returned `lid` as
the `to` target; fall back to the returned phone-number `jid` only when `lid`
is unavailable.

When replying to an incoming event, the safest target is usually:

```jinja2
{{ trigger.event.data.key.remoteJid }}
```

If Home Assistant receives or stores an `@lid` id, pass it back exactly as
received. Do not convert it to a phone-number JID.

The add-on suppresses duplicate inbound phone/LID deliveries when WhatsApp sends
the same message twice with different `remoteJid` values.

## Find a group ID and send a notification

I capture the group ID from an incoming event:

1. Add the WhatsApp account linked to the add-on to the group. Complete any
   invitation or approval in WhatsApp first.
2. In Home Assistant, open **Developer Tools > Events** and listen to
   `new_whatsapp_message`.
3. Send a message to that group from a different WhatsApp account.
4. Find the event for your `clientId` and copy **the entire** `key.remoteJid`,
   including `@g.us`. Stop listening when finished.

For example, this shortened event identifies a group and its sender:

```yaml
clientId: default
key:
  remoteJid: 120363000000000000@g.us
  fromMe: false
  id: EXAMPLE_MESSAGE_ID
  participant: 999000111222333@lid
```

Send to `remoteJid`; `participant` identifies the member who sent the message,
not the group:

```yaml
action: whatsapp.send_message
data:
  clientId: default
  to: 120363000000000000@g.us
  body:
    text: "The dryer has finished."
```

Group IDs do not all have the same length. Keep the exact value from the event
instead of constructing it from a phone number. If the test message comes from
the linked account itself, look for `whatsapp_message_sent` instead; ordinary
incoming-message automations deliberately ignore own sends.

## Check whether a phone number is registered

```yaml
- action: whatsapp.check_number
  data:
    clientId: default
    to: "+12025550123"
  response_variable: number_check
```

`whatsapp.check_number` requires `response_variable`. It accepts an
international phone number as bare digits with an optional leading `+`, or a
phone-number `@s.whatsapp.net` JID. It does not accept groups, LIDs, broadcasts,
or device-qualified JIDs.

The response has this shape:

```yaml
jid: 12025550123@s.whatsapp.net
exists: true
lid: 999000111222333@lid
```

`exists: false` is a successful lookup and normally has `lid: null`. The lookup
checks WhatsApp registration at that moment; it does not guarantee that a
subsequent message will be delivered. Avoid bulk or repeated enumeration, and
treat the returned JID and LID as private account identifiers.

Invalid input, an unknown or disconnected client, rate limiting, authentication
failure, and an upstream WhatsApp failure are reported as action errors. They
are never collapsed into `exists: false`.

`whatsapp.send_message` sends direct phone JIDs without a registration lookup;
bare phone numbers retain the existing lookup before sending. Call
`whatsapp.check_number` when an automation needs an explicit preflight and a
structured registration response.

`whatsapp.check_number` requires add-on and integration version 1.4.31 or newer.

## Look up a group name

Incoming group messages identify the chat only by its `key.remoteJid`.
`whatsapp.get_group_info` returns the group name and metadata for that JID:

```yaml
- action: whatsapp.get_group_info
  data:
    clientId: default
    to: 120363000000000000@g.us
  response_variable: group
```

`whatsapp.get_group_info` requires `response_variable`. It accepts only a
group `@g.us` JID; phone numbers, LIDs, and broadcasts are rejected before the
add-on is called. The linked account must be a member of the group.

The response has this shape:

```yaml
jid: 120363000000000000@g.us
subject: Family
description: Weekend plans and grocery lists
owner: 12025550123@s.whatsapp.net
created_at: "2023-04-18T09:12:44.000Z"
size: 3
announce_only: false
admins_only_settings: false
is_community: false
parent_community: null
participants:
  - jid: 12025550123@s.whatsapp.net
    lid: 123456789012345@lid
    admin: superadmin
  - jid: 12025550199@s.whatsapp.net
    lid: 987654321098765@lid
    admin: admin
  - jid: 12025550177@s.whatsapp.net
    lid: 555566667777888@lid
    admin: null
```

`subject` is the group name shown in WhatsApp. `description`, `owner`,
`created_at`, and `parent_community` are `null` when WhatsApp does not report
them. `owner` can be a LID or `null`. Each participant `jid` is a phone JID or
`null` in groups that use LID addressing, so keep the `lid` field as the
fallback identifier.
`announce_only` means only admins can send; `admins_only_settings` means only
admins can change the group settings. `admin` is `superadmin`, `admin`, or
`null` for ordinary members.

Participants are identifiers only; WhatsApp does not include member names in
group metadata. For the sender name of a received message, read `pushName` from
the `new_whatsapp_message` event as shown in
[incoming messages](incoming-messages.md#show-the-sender-and-group-name).

Each call queries WhatsApp and shares the per-client lookup rate limit with
`whatsapp.check_number`, so cache the result when an automation handles a busy
group. An unknown or disconnected client, a group the account has left, rate
limiting, and an upstream WhatsApp failure are reported as action errors.

`whatsapp.get_group_info` requires add-on and integration version 2.1.0 or newer.
