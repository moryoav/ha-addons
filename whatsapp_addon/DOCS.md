# Home Assistant Add-on: WhatsappV2

## How to use

### **How to add other Whatsapp sessions**

Go to configuration page in clients input box digit the desired clientId. This one represents an identifier for the session.

### **How to get a User ID**

A WhatsApp target id can use one of these formats:

- Phone-number user JID: `391234567890@s.whatsapp.net`
- New WhatsApp LID user JID: `90855889203418@lid`
- Group JID: `1234567890-123456789@g.us`
- Broadcast JID: `status@broadcast`

If you only pass a phone number, the add-on appends `@s.whatsapp.net`. If Home Assistant receives or stores an `@lid` id, pass it back exactly as received. Do not convert it to a phone-number JID.

When replying to an incoming event, the safest target is usually:

```jinja2
{{ trigger.event.data.key.remoteJid }}
```

The add-on suppresses duplicate inbound phone/LID deliveries when WhatsApp sends the same message twice with different `remoteJid` values during the LID migration.

### **Send a simple text message**

```yaml
service: whatsapp.send_message
data:
  clientId: default
  to: 391234567890@s.whatsapp.net # User ID
  body:
    text: Hi it's a simple text message
```

### **Send a message and capture the response**

```yaml
- service: whatsapp.send_message
  response_variable: whatsapp_result
  data:
    clientId: default
    to: 391234567890@s.whatsapp.net
    body:
      text: Hi, this response contains the sent WhatsApp message id
```

The response includes `client_id`, `to`, `body`, `sent_message`, and `message_id`. For compatibility with older automations, the integration also fires `whatsapp_send_message_result` after a message is sent.

### **How to send an image**

```yaml
service: whatsapp.send_message
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
  body:
    image:
      url: "https://dummyimage.com/600x400/000/fff.png"
    caption: Simple text
```

### **How to send audio message**

```yaml
service: whatsapp.send_message
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
  body:
    audio:
      url: "https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/examples/hello_world.mp3?raw=true"
    ptt: true # Send audio as a voice
```

### **How to send a location**

```yaml
service: whatsapp.send_message
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
  body:
    location:
      degreesLatitude: 24.121231
      degreesLongitude: 55.1121221
```

### **How to subscribe to presence update**

```yaml
service: whatsapp.presence_subscribe
data:
  clientId: default
  userId: 391234567890@s.whatsapp.net
```

### **How to mark a received message as read**

```yaml
service: whatsapp.read_messages
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
    - service: whatsapp.send_message
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
    - service: whatsapp.read_messages
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
      entity_id: device_tracker.iphone_13_pro
      type: enter
      zone: zone.home
  condition: []
  action:
    - service: whatsapp.send_message
      data:
        clientId: default
        to: 391234567890@s.whatsapp.net
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
    - service: whatsapp.send_message
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
    - service: whatsapp.send_message
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
        "{{ trigger.event.data.presences['391234567890@s.whatsapp.net'].lastKnownPresence
        == 'available' }}"
  action:
    - service: persistent_notification.create
      data:
        message: Contact is online!
  mode: single
```
