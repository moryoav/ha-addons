# Presence

## Subscribe to presence updates

```yaml
action: whatsapp.presence_subscribe
data:
  clientId: default
  userId: 12025550123@s.whatsapp.net
```

## Notify when a contact is online

Subscribe to the contact first using the action above.

```yaml
- alias: Notify when a WhatsApp contact is online
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

See the [action reference](../reference/actions.md) for the presence actions
exposed by the integration.

## Show typing before sending a message

I send `composing` to the destination chat before a reply, then `paused` when
the reply attempt ends. Presence is a separate action from sending a message.

```yaml
- action: whatsapp.send_presence_update
  data:
    clientId: default
    to: 120363000000000000@g.us
    type: composing
  continue_on_error: true
- delay: "00:00:02"
- action: whatsapp.send_message
  data:
    clientId: default
    to: 120363000000000000@g.us
    body:
      text: "Here is the result."
  continue_on_error: true
- action: whatsapp.send_presence_update
  data:
    clientId: default
    to: 120363000000000000@g.us
    type: paused
  continue_on_error: true
```

The send step continues on an action error so the final presence cleanup can
still run. This does not guarantee that the message was delivered.

## Keep typing while another action runs

I use a bounded background script for longer work, such as a conversation
agent request. Add this definition to `scripts.yaml`; in the script editor,
use the contents beneath `whatsapp_keep_typing:`.

```yaml
whatsapp_keep_typing:
  alias: WhatsApp keep typing
  mode: restart
  fields:
    client_id:
      required: true
      selector:
        text:
    to:
      required: true
      selector:
        text:
  sequence:
    - repeat:
        count: 15
        sequence:
          - action: whatsapp.send_presence_update
            data:
              clientId: "{{ client_id }}"
              to: "{{ to }}"
              type: composing
          - delay: "00:00:04"
```

Start it with `script.turn_on`, which lets the calling sequence continue.
Stop it after the work, then send `paused`:

```yaml
- action: script.turn_on
  target:
    entity_id: script.whatsapp_keep_typing
  data:
    variables:
      client_id: default
      to: 120363000000000000@g.us
  continue_on_error: true
- delay: "00:00:08"
- action: whatsapp.send_message
  data:
    clientId: default
    to: 120363000000000000@g.us
    body:
      text: "The work is complete."
  continue_on_error: true
- action: script.turn_off
  target:
    entity_id: script.whatsapp_keep_typing
  continue_on_error: true
- action: whatsapp.send_presence_update
  data:
    clientId: default
    to: 120363000000000000@g.us
    type: paused
  continue_on_error: true
```

Replace the delay with your work. Give actions that may fail
`continue_on_error: true` if cleanup must follow them. The helper repeats for
about a minute at most if the caller stops unexpectedly. It handles one chat
at a time: a new call restarts it, so avoid sharing it between concurrent
conversations. This example uses repeated `send_presence_update` calls.

See [Home Assistant script execution](https://www.home-assistant.io/integrations/script/#waiting-for-script-to-complete).
