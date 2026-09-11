# Automations

These examples use Home Assistant automation YAML. Replace the sample
recipients and entity IDs with your own values.

## Notify when an incoming WhatsApp call is offered

```yaml
- alias: Incoming WhatsApp call
  trigger:
    - platform: event
      event_type: whatsapp_call_update
      event_data:
        status: offer
  action:
    - action: persistent_notification.create
      data:
        title: Incoming WhatsApp call
        message: >-
          {{ "Video" if trigger.event.data.isVideo else "Voice" }} call from
          {{ trigger.event.data.from or "an unknown caller" }}.
  mode: queued
```

## Log received and sent messages

```yaml
- alias: Log WhatsApp messages
  trigger:
    - platform: event
      event_type: new_whatsapp_message
    - platform: event
      event_type: whatsapp_message_sent
  action:
    - action: logbook.log
      data:
        name: "WhatsApp ({{ trigger.event.data.clientId }})"
        message: >-
          {% set data = trigger.event.data %}
          {{ "Sent" if data.key.fromMe else "Received" }}:
          {{ data.message.get("conversation") or
             data.message.get("extendedTextMessage", {}).get("text") or
             "[" ~ data.type ~ "]" }}
  mode: queued
```

This example logs text messages and uses the message type for other content.
To check outgoing events after updating the add-on, listen for
`whatsapp_message_sent` in **Developer tools** -> **Events**, then send a
message from the linked phone.

## Reply to `!ping`

```yaml
- alias: WhatsApp ping pong
  trigger:
    - platform: event
      event_type: new_whatsapp_message
  condition:
    - condition: template
      value_template: "{{ trigger.event.data.message.conversation == '!ping' }}"
  action:
    - action: whatsapp.send_message
      data:
        clientId: "{{ trigger.event.data.clientId }}"
        to: "{{ trigger.event.data.key.remoteJid }}"
        body:
          text: pong
  mode: single
```

## Mark incoming messages as read

```yaml
- alias: Mark WhatsApp messages as read
  trigger:
    - platform: event
      event_type: new_whatsapp_message
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

`read_messages` expects the key from the received `new_whatsapp_message` event.

## Mark a received message as read in an action

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

## Driving mode reply with a quote

This example replies to every incoming message while the automation is enabled.

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

For more event-based examples, see [message reactions](messages.md#react-to-an-incoming-message)
and [presence notifications](presence.md#notify-when-a-contact-is-online).

## Send a sensor alert with a templated message

I use the same send action for water, temperature, appliance, and availability
alerts. The trigger supplies the value included in the message. Replace the
sample entity and threshold with your own.

```yaml
- alias: WhatsApp temperature alert
  triggers:
    - trigger: numeric_state
      entity_id: sensor.example_temperature
      above: 30
      for: "00:05:00"
  actions:
    - action: whatsapp.send_message
      data:
        clientId: default
        to: 120363000000000000@g.us
        body:
          text: >-
            The temperature is {{ trigger.to_state.state }}
            {{ trigger.to_state.attributes.get('unit_of_measurement', '') }}.
  mode: single
```

This numeric-state trigger fires when the value crosses the threshold and
stays above it for five minutes. To add a completion reaction or a threaded
follow-up later, keep the send response as shown in
[reusable notification scripts](scripts.md).

## Forward a local webhook to WhatsApp

I use a Home Assistant webhook to accept text from another local application.
The recipient and client remain fixed in the automation. Replace the webhook
ID with your own long, random value before using the example.

```yaml
- alias: Forward a local webhook to WhatsApp
  triggers:
    - trigger: webhook
      webhook_id: REPLACE_WITH_LONG_RANDOM_ID
      allowed_methods:
        - POST
      local_only: true
  conditions:
    - condition: template
      value_template: >-
        {{ trigger.json is defined and trigger.json is mapping
           and trigger.json.get('msg') is string
           and trigger.json.msg | trim != '' }}
  actions:
    - action: whatsapp.send_message
      data:
        clientId: default
        to: 120363000000000000@g.us
        body:
          text: "{{ trigger.json.msg | trim }}"
  mode: queued
  max: 10
```

The sending application posts JSON with `Content-Type: application/json`:

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"msg":"The backup is complete."}' \
  "http://homeassistant.local:8123/api/webhook/REPLACE_WITH_LONG_RANDOM_ID"
```

Keep the webhook ID private. This is a
[Home Assistant webhook](https://www.home-assistant.io/docs/automation/trigger/#webhook-trigger)
that calls the integration; it does not expose the add-on API.

An external monitor on the local network can use this webhook while Home
Assistant is reachable. To report a Home Assistant outage, the monitor needs a
notification route that works independently of Home Assistant.
