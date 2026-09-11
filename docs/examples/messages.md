# Messages and media

Use `whatsapp.send_message` with the body for the message type you need.
See [recipients and number lookup](recipients.md) for target formats.

## Send a text message

```yaml
action: whatsapp.send_message
data:
  clientId: default
  to: 12025550123@s.whatsapp.net
  body:
    text: Hi from Home Assistant
```

## Capture the sent message id

```yaml
- action: whatsapp.send_message
  response_variable: whatsapp_result
  data:
    clientId: default
    to: 12025550123@s.whatsapp.net
    body:
      text: This call stores the sent WhatsApp message id.
```

The response includes `client_id`, `to`, `body`, `sent_message`, and
`message_id`. For compatibility with older automations, the integration also
fires `whatsapp_send_message_result` after a message is sent. Success means the
linked client accepted the send operation; it does not guarantee delivery,
receipt, or that the recipient read the message.

## Send an image

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

## Send a voice message

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

## Send a location

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

## React to an incoming message

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
