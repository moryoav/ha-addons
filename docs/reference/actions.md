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

`whatsapp.send_message` can return response data when called with
`response_variable`; it also fires the compatibility event
`whatsapp_send_message_result`. A successful response means the linked client
accepted the send operation. It does not guarantee delivery, receipt, or that
the recipient read the message.

## Examples

- [Messages and media](../examples/messages.md)
- [Recipients and number lookup](../examples/recipients.md)
- [Presence](../examples/presence.md)
- [Automations and read markers](../examples/automations.md)
