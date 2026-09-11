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
