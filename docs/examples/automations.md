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

## Decline calls at night and reply with a message

This automation declines direct WhatsApp calls between 23:00 and 07:00 and
tells the caller you are not available. It needs add-on and integration version
2.3.0 or newer.

```yaml
- alias: Decline WhatsApp calls at night
  trigger:
    - platform: event
      event_type: whatsapp_call_update
      event_data:
        status: offer
  condition:
    - condition: time
      after: "23:00:00"
      before: "07:00:00"
    - condition: template
      value_template: >-
        {{ not trigger.event.data.isGroup
           and trigger.event.data.callId is not none
           and trigger.event.data.from is not none }}
  action:
    - action: whatsapp.reject_call
      data:
        clientId: "{{ trigger.event.data.clientId }}"
        callId: "{{ trigger.event.data.callId }}"
        from: "{{ trigger.event.data.from }}"
    - action: whatsapp.send_message
      data:
        clientId: "{{ trigger.event.data.clientId }}"
        to: "{{ trigger.event.data.from | regex_replace(':[0-9]+@', '@') }}"
        body:
          text: >-
            I'm not available right now. I'll get back to you in the morning.
  mode: queued
```

To decline calls only while you sleep, replace the time condition with your
sleep helper, for example
`condition: state`, `entity_id: input_boolean.sleeping`, `state: "on"`.
The template condition skips group calls, so a group call still rings.
The caller's `from` value can be a LID; `whatsapp.send_message` accepts it
directly. The `regex_replace` removes a device suffix such as `:12` if WhatsApp
reports one.

## Notify about missed calls

`whatsapp_call_log` fires once per finished call. This automation notifies you
about incoming calls nobody answered. It needs add-on version 2.4.0 or newer.

```yaml
- alias: Missed WhatsApp call
  trigger:
    - platform: event
      event_type: whatsapp_call_log
      event_data:
        direction: incoming
        result: missed
  action:
    - action: persistent_notification.create
      data:
        title: Missed WhatsApp call
        message: >-
          {{ "Video" if trigger.event.data.isVideo else "Voice" }} call from
          {{ trigger.event.data.peer or "an unknown caller" }} at
          {{ (as_timestamp(trigger.event.data.startedAt) | timestamp_custom("%H:%M"))
             if trigger.event.data.startedAt else "an unknown time" }}.
  mode: queued
```

## Log calls made from the phone

```yaml
- alias: Log outgoing WhatsApp calls
  trigger:
    - platform: event
      event_type: whatsapp_call_log
      event_data:
        direction: outgoing
  action:
    - action: logbook.log
      data:
        name: "WhatsApp ({{ trigger.event.data.clientId }})"
        message: >-
          Called {{ trigger.event.data.peer or "someone" }}:
          {{ trigger.event.data.result }},
          {{ trigger.event.data.durationSeconds or 0 }} seconds.
  mode: queued
```

`startedAt` is `null` when WhatsApp does not report a start time, so check it
before formatting it, as the missed-call example does.

## Escalate when an alert is not read

This sends a leak alert and waits up to 10 minutes for WhatsApp to report that
it was read. If it was not, it notifies a phone instead. It needs add-on and
integration version 2.5.0 or newer.

```yaml
- alias: Escalate unread leak alert
  trigger:
    - platform: state
      entity_id: binary_sensor.kitchen_leak
      to: "on"
  action:
    - action: whatsapp.send_message
      data:
        clientId: default
        to: 12025550123@s.whatsapp.net
        body:
          text: Water leak detected in the kitchen.
      response_variable: alert
    - wait_for_trigger:
        - platform: event
          event_type: whatsapp_message_status
          event_data:
            messageId: "{{ alert.message_id }}"
            status: read
      timeout: "00:10:00"
      continue_on_timeout: true
    - if:
        - condition: template
          value_template: "{{ wait.trigger is none }}"
      then:
        - action: notify.mobile_app_my_phone
          data:
            message: The WhatsApp leak alert was not read within 10 minutes.
  mode: single
```

A recipient who turned off read receipts never reports `read`, so this example
always escalates for them.

## Dismiss a notification after reading the chat on the phone

The first automation shows a notification for messages in a group and stores
the ID of the newest one in an `input_text` helper,
`input_text.family_group_last_message`, that you create first. The second
removes the notification once that message is read on your phone.

```yaml
- alias: Notify about family group messages
  trigger:
    - platform: event
      event_type: new_whatsapp_message
      event_data:
        key:
          remoteJid: 120363000000000000@g.us
  action:
    - action: input_text.set_value
      target:
        entity_id: input_text.family_group_last_message
      data:
        value: "{{ trigger.event.data.key.id }}"
    - action: persistent_notification.create
      data:
        notification_id: whatsapp_family_group
        title: Family group
        message: New WhatsApp messages.
  mode: queued

- alias: Dismiss family group notification
  trigger:
    - platform: event
      event_type: whatsapp_chat_read
      event_data:
        chatId: 120363000000000000@g.us
  condition:
    - condition: template
      value_template: >-
        {{ states("input_text.family_group_last_message")
           in trigger.event.data.messageIds }}
  action:
    - action: persistent_notification.dismiss
      data:
        notification_id: whatsapp_family_group
  mode: queued
```

`whatsapp_chat_read` lists the messages that were read, not the whole chat, so
the condition keeps an older message from dismissing a newer notification.

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
