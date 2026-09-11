# Recipients and number lookup

## Choose the sending account

For notifications on my personal phone, I link a separate WhatsApp account to
the add-on and send from that account to my personal account or a shared group.
Messages sent by the integration belong to the linked account. Linking my
personal account makes the bot send as me, so those sends are not incoming
messages from a separate contact. This is the account distinction explained in
my [setup tutorial](https://smarthome.yoavmor.com/home-assistant/integrating-whatsapp-into-home-assistant-part-1-setup-and-notifications/).
Follow the [current installation guide](https://github.com/moryoav/ha-addons#installation)
to pair that account with this add-on.

## Supported identifiers

Message targets can use:

- Phone-number user JID, such as the fictional `12025550123@s.whatsapp.net`.
- WhatsApp LID user JID, such as the synthetic `999000111222333@lid`.
- Group JID, such as the synthetic `120363000000000000@g.us`.
- Broadcast JID, such as `status@broadcast`.

**For direct chats, migrate automations to LID (`@lid`) targets whenever
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
the same message twice with different `remoteJid` values during the LID
migration.

## Find a group ID and send a notification

I capture the group ID from an incoming event, as in my
[group messaging tutorial](https://smarthome.yoavmor.com/home-assistant/integrating-whatsapp-into-home-assistant-part-2-messaging-groups/).

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

Use add-on and integration version 1.4.31 or newer together. The registration
lookup is unavailable on older add-ons; the integration reports a clear update
error instead of treating a missing endpoint as an unregistered number.
