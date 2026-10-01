# Actions

The integration registers these Home Assistant actions under the `whatsapp` domain:

- `whatsapp.send_message`: send text, media, location, reactions, or any payload supported by the add-on.
- `whatsapp.set_status`: set the WhatsApp account status text.
- `whatsapp.presence_subscribe`: subscribe to presence updates for a contact.
- `whatsapp.send_presence_update`: send a one-shot presence update.
- `whatsapp.send_infinity_presence_update`: send a long-running presence update.
- `whatsapp.read_messages`: mark received messages as read.
- `whatsapp.check_number`: check whether a phone number is registered with
  WhatsApp and return its normalized phone JID and LID when available.
- `whatsapp.get_group_info`: look up a group by its `@g.us` JID and return its
  name, description, owner, settings, and participants.
- `whatsapp.reject_call`: decline an incoming call using the `callId` and
  `from` values of its `whatsapp_call_update` event.
- `whatsapp.get_profile`: look up a contact's profile picture URL, about text,
  and business profile, or a group's picture.
- `whatsapp.list_groups`: list every group the linked account belongs to, with
  its JID, name, description, and settings.

The lookup actions `check_number`, `get_group_info`, `get_profile`, and
`list_groups` require `response_variable` and share a per-client rate limit.

| Action | Add-on and integration version |
| --- | --- |
| `check_number` | 1.4.31 |
| `get_group_info` | 2.1.0 |
| `reject_call` | 2.3.0 |
| `get_profile`, `list_groups` | 2.5.0 |

`whatsapp.send_message` can return response data when called with
`response_variable`; it also fires the compatibility event
`whatsapp_send_message_result`. A successful response means the linked client
accepted the send operation. It does not guarantee delivery, receipt, or that
the recipient read the message.

## Examples

- [Messages and media](../examples/messages.md)
- [Recipients, profiles, and group lists](../examples/recipients.md)
- [Presence](../examples/presence.md)
- [Automations, calls, and read markers](../examples/automations.md)
- [Reusable notification scripts](../examples/scripts.md)
- [Incoming messages and conversation agents](../examples/incoming-messages.md)
