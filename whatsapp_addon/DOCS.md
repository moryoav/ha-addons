# Home Assistant Add-on: WhatsappV2

## How to use

## Configuration

The add-on options are:

- `clients`: one or more unique WhatsApp session names. The default is
  `default`. A name must match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`.
- `api_token`: an optional bearer token for the internal add-on API. Use a
  strong random value for defense in depth. Leave it unset to preserve
  compatibility with existing internal-network installations. The value may
  contain `A-Z`, `a-z`, `0-9`, `-`, `.`, `_`, `~`, `+`, and `/`, followed by
  optional `=` padding, and may be at most 512 characters total. Random hex or
  URL-safe Base64 is recommended. Spaces, `:`, and other characters cause a
  startup validation error.

Each session name becomes the `clientId` used by Home Assistant actions. Every client has its own persisted WhatsApp pairing state under the add-on data folder.

### **How to add other WhatsApp sessions**

Open the add-on configuration page and add another value under `clients`. Use
that value as the `clientId` in Home Assistant actions. Empty lists, duplicates,
invalid characters, and names longer than 64 characters are rejected before
any session directory is created.

## Stable and canary builds

Use the default repository URL for stable releases:

```text
https://github.com/moryoav/ha-addons
```

This repository does not currently publish a separate canary or `next` branch. If a canary channel is introduced later, it will be documented with its `#branch` repository URL and a distinct add-on name.

## Security and network access

The add-on exposes no Home Assistant LAN port. Home Assistant Ingress is enabled
for the add-on web UI, and the web UI listener only accepts the Supervisor
ingress proxy address. QR pairing is shown in the add-on web UI and through Home
Assistant persistent notifications.

The add-on includes a custom AppArmor profile. Its trusted base-image bootstrap
uses the standard Home Assistant startup permissions, then the network-facing
Node bridge runs in a restricted child profile where packaged files are
read-only and writes are limited to temporary and persistent session data. The
add-on runs without host networking, Docker API access, privileged capabilities,
`full_access`, host PID, or host UTS, and uses the default Supervisor API role.
A native container health check calls the local `/health` endpoint after
startup.

The add-on has no `/config` mount. It cannot install, overwrite, or remove a
custom integration. Version 1.4.31 retired the bundled legacy component; an
existing `/config/custom_components/whatsapp` directory is left untouched when
the add-on is updated or removed. Install the current integration through HACS.

When `api_token` is set, action API requests require
`Authorization: Bearer <token>`. The token is advertised to the integration
through the internal Supervisor discovery record. Keep the add-on and
integration at version 1.4.31 or newer, and never paste the token into logs or
issue reports.

Token-enabled installations require Supervisor discovery; manual or fallback
URL detection cannot provide the credential. After adding, changing, or
removing `api_token`, restart the add-on and reload the integration so discovery
refreshes or removes the stored token. Because `/health` is public, a stale or
wrong token is reported as an authorization error on the first protected action
rather than during setup.

The `/health` route remains unauthenticated so container monitoring can use it.
Its response is deliberately limited to a non-sensitive status, the service
identifier `ha-whatsapp-addon`, API version, supported capabilities, and
configured-client count. It contains no token, add-on URL, recipient id,
session data, or message content.

## Web UI

Open the add-on page and select Open Web UI. The Ingress UI shows each configured WhatsApp session, its connection state, and the current pairing QR code when a session is waiting for pairing.

### **How to get a User ID**

A WhatsApp target id can use one of these formats:

- Phone-number user JID: fictional `12025550123@s.whatsapp.net`
- New WhatsApp LID user JID: synthetic `999000111222333@lid`
- Group JID: synthetic `120363000000000000@g.us`
- Broadcast JID: `status@broadcast`

If you only pass a phone number, the add-on appends `@s.whatsapp.net`. If Home Assistant receives or stores an `@lid` id, pass it back exactly as received. Do not convert it to a phone-number JID.

When replying to an incoming event, the safest target is usually:

```jinja2
{{ trigger.event.data.key.remoteJid }}
```

The add-on suppresses duplicate inbound phone/LID deliveries when WhatsApp sends
the same message twice with different `remoteJid` values during the LID
migration.

### **Check whether a phone number is registered**

```yaml
- action: whatsapp.check_number
  data:
    clientId: default
    to: "+12025550123"
  response_variable: number_check
```

This action requires `response_variable`. `to` may be an international phone
number containing bare digits with an optional leading `+`, or a phone-number
`@s.whatsapp.net` JID. Groups, LIDs, broadcasts, and device-qualified JIDs are
rejected because Baileys does not provide the same authoritative lookup for
those identifiers.

The response has this shape:

```yaml
jid: 12025550123@s.whatsapp.net
exists: true
lid: 999000111222333@lid
```

An unregistered number returns `exists: false` and normally `lid: null`; it is
not an action failure. A lookup confirms registration at that moment only. It
does not guarantee a later message will be delivered or read. Avoid bulk or
repeated enumeration and treat `to`, `jid`, and `lid` as private identifiers.

Invalid input, an unknown or disconnected `clientId`, a stale API token, rate
limiting, and an upstream WhatsApp failure are distinct action errors. They are
not returned as `exists: false`, so automations can distinguish an unregistered
number from an operational failure.

`whatsapp.send_message` sends direct phone JIDs without a registration lookup;
bare phone numbers retain the existing lookup before sending. Use
`whatsapp.check_number` when a workflow needs an explicit preflight and a
structured registration response.

### **Send a simple text message**

```yaml
action: whatsapp.send_message
data:
  clientId: default
  to: 12025550123@s.whatsapp.net # Fictional User ID
  body:
    text: Hi it's a simple text message
```

### **Send a message and capture the response**

```yaml
- action: whatsapp.send_message
  response_variable: whatsapp_result
  data:
    clientId: default
    to: 12025550123@s.whatsapp.net
    body:
      text: Hi, this response contains the sent WhatsApp message id
```

The response includes `client_id`, `to`, `body`, `sent_message`, and
`message_id`. For compatibility with older automations, the integration also
fires `whatsapp_send_message_result` after a message is sent. Success means the
linked client accepted the send operation; it does not guarantee delivery,
receipt, or that the recipient read the message.

### **How to send an image**

```yaml
action: whatsapp.send_message
data:
  clientId: default
  to: 12025550123@s.whatsapp.net
  body:
    image:
      url: "https://dummyimage.com/600x400/000/fff.png"
    caption: Simple text
```

### **How to send audio message**

```yaml
action: whatsapp.send_message
data:
  clientId: default
  to: 12025550123@s.whatsapp.net
  body:
    audio:
      url: "https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/examples/hello_world.mp3?raw=true"
    ptt: true # Send audio as a voice
```

### **How to send a location**

```yaml
action: whatsapp.send_message
data:
  clientId: default
  to: 12025550123@s.whatsapp.net
  body:
    location:
      degreesLatitude: 24.121231
      degreesLongitude: 55.1121221
```

### **How to subscribe to presence update**

```yaml
action: whatsapp.presence_subscribe
data:
  clientId: default
  userId: 12025550123@s.whatsapp.net
```

### **How to mark a received message as read**

```yaml
action: whatsapp.read_messages
data:
  clientId: "{{ trigger.event.data.clientId }}"
  body:
    keys:
      id: "{{ trigger.event.data.key.id }}"
      remoteJid: "{{ trigger.event.data.key.remoteJid }}"
      fromMe: "{{ trigger.event.data.key.fromMe }}"
```

`read_messages` expects the key from the received `new_whatsapp_message` event.

---

## Events

| Event type                   | Description                                  |
| ---------------------------- | -------------------------------------------- |
| new_whatsapp_message         | The message that was received                |
| whatsapp_presence_update     | Presence of contact in a chat updated        |
| whatsapp_send_message_result | Result event fired after sending a message   |

`new_whatsapp_message` event data includes the configured `clientId`, the detected message `type`, the Baileys `key`, and the message payload. The dedupe layer runs before this event is fired, so automations should only see one event for the same WhatsApp message id/content pair. Media dedupe ignores wrapper-only fields such as thumbnails, CDN paths, scan sidecars, and media key timestamp representation because WhatsApp can vary those between phone-number and LID deliveries of the same message.

Known recoverable libsignal `Bad MAC` and session lifecycle console logs are filtered by the add-on. They are summarized as counts in the add-on log and do not change authentication, session state, or message handling.

---

## **Sample automations**

## Ping Pong

```yaml
- alias: Ping Pong
  description: ""
  trigger:
    - platform: event
      event_type: new_whatsapp_message
  condition:
    - condition: template
      value_template: "{{ trigger.event.data.message.conversation == '!ping' }}"
  action:
    - action: whatsapp.send_message
      data:
        clientId: default
        to: "{{ trigger.event.data.key.remoteJid }}"
        body:
          text: pong
  mode: single
```

## Mark incoming messages as read

```yaml
- alias: Mark WhatsApp messages as read
  description: ""
  trigger:
    - platform: event
      event_type: new_whatsapp_message
  condition: []
  action:
    - action: whatsapp.read_messages
      data:
        clientId: "{{ trigger.event.data.clientId }}"
        body:
          keys:
            id: "{{ trigger.event.data.key.id }}"
            remoteJid: "{{ trigger.event.data.key.remoteJid }}"
            fromMe: "{{ trigger.event.data.key.fromMe }}"
  mode: queued
```

## Arrive at home

```yaml
- alias: Arrive at home
  description: ""
  trigger:
    - platform: device
      domain: device_tracker
      entity_id: device_tracker.example_phone
      type: enter
      zone: zone.home
  condition: []
  action:
    - action: whatsapp.send_message
      data:
        clientId: default
        to: 12025550123@s.whatsapp.net
        body:
          text: Hi, I'm at home
  mode: single
```

## Driving mode

```yaml
- alias: Driving mode
  description: ""
  trigger:
    - platform: event
      event_type: new_whatsapp_message
  condition: []
  action:
    - action: whatsapp.send_message
      data:
        clientId: "{{ trigger.event.data.clientId }}" # Which instance of whatsapp should the message come from
        to: "{{ trigger.event.data.key.remoteJid }}"
        body:
          text: Sorry, I'm driving, I will contact you soon
        options:
          quoted: "{{ trigger.event.data }}" # Quote message
  mode: single
```

## Message reaction

```yaml
- alias: React to message
  description: ""
  trigger:
    - platform: event
      event_type: new_whatsapp_message
  condition: []
  action:
    - action: whatsapp.send_message
      data:
        clientId: "{{ trigger.event.data.clientId }}"
        to: "{{ trigger.event.data.key.remoteJid }}"
        body:
          react:
            text: "👍🏻" # Use an empty string to remove the reaction
            key: "{{ trigger.event.data.key }}"
  mode: single
```

## Presence notify (SUBSCRIBE FIRST!)

```yaml
- alias: Nuova automazione
  description: ""
  trigger:
    - platform: event
      event_type: whatsapp_presence_update
      event_data: {}
  condition:
    - condition: template
      value_template:
        "{{ trigger.event.data.presences['12025550123@s.whatsapp.net'].lastKnownPresence
        == 'available' }}"
  action:
    - action: persistent_notification.create
      data:
        message: Contact is online!
  mode: single
```

## Privacy and compatibility

The add-on supports `aarch64` and `amd64`. Version 1.4.31 removes `armhf`,
`armv7`, and `i386`, which Home Assistant has not supported since 2025.12.

WhatsApp message events and Home Assistant automation traces can contain phone
JIDs, LIDs, message keys, quoted-message data, and message bodies. The add-on
does not log lookup identifiers or message bodies, but Home Assistant may retain
event and action data. Redact these fields, QR codes, session data, and
`api_token` before sharing diagnostics, logs, screenshots, or traces.

Use add-on and integration version 1.4.31 or newer together. The registration
lookup is unavailable on older add-ons; the integration reports a clear update
error instead of treating a missing endpoint as an unregistered number.

### Migrating from the bundled legacy component

The add-on no longer writes to `/config`. Existing legacy component files are
not deleted during update or uninstall.

1. Create a Home Assistant backup.
2. Install or update **WhatsApp** from the default HACS integration catalog.
3. Restart Home Assistant and verify the integration under
   **Settings > Devices & services**.
4. Remove an old `whatsapp:` YAML block, if present, and restart again.

After HACS takes ownership, do not manually delete
`/config/custom_components/whatsapp`. Manual-install users should replace the
whole directory with the current repository copy.

## Support and issues

For help, start with the root [README](../README.md), [SUPPORT](../SUPPORT.md), and [CHANGELOG](../CHANGELOG.md). If you find a bug, open an issue on GitHub and include the add-on version, Home Assistant version, add-on logs with secrets redacted, and the relevant automation or action payload.

## License

This add-on is published under the Apache License 2.0. See the repository [LICENSE](../LICENSE) file for the full license text.
