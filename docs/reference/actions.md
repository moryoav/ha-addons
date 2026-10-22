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
- `whatsapp.make_call`: start an AI voice call from the configured calling
  account. Supply `clientId`, `to`, and optionally `message` (up to 300 characters)
  for the greeting after pickup. Optional response: `status: calling`.
- `whatsapp.hang_up`: end that account's active AI call using `clientId`.
  Optional response: `status: ended`.
- `whatsapp.get_profile`: look up a contact's profile picture URL, about text,
  and business profile, or a group's picture.
- `whatsapp.list_groups`: list every group the linked account belongs to, with
  its JID, name, description, and settings.
- `whatsapp.get_contacts`: fetch a fresh saved-contact snapshot with original
  contact fields, including saved names and LIDs when supplied.

The lookup actions `check_number`, `get_group_info`, `get_profile`,
`list_groups`, and `get_contacts` require `response_variable` and share a
per-client rate limit.

`whatsapp.send_message` can return response data when called with
`response_variable`; it also fires the event
`whatsapp_send_message_result`. A successful response means the linked client
accepted the send operation. It does not guarantee delivery, receipt, or that
the recipient read the message.

## Message inbox

Enable selected `inbox_clients` in the app only after updating the integration
and adding the start and completion gates to the processing automation.

- `whatsapp.get_inbox`: inspect the next eligible message, queue counts and held
  items in `attention`; requires `response_variable`.
- `whatsapp.start_inbox_message`: submit the event's complete `inbox` object;
  requires `response_variable`. Continue only if `started` is true.
- `whatsapp.complete_inbox_message`: submit the same `inbox` object after the
  workflow and reply finish. Optional response: `status: completed`.
- `whatsapp.resolve_inbox_message`: submit a current `inbox` reference with
  `resolution: retry` or `resolution: discard` after inspecting the action.
  Pending and unprepared messages can also be resolved. A failing workflow can
  use `resolution: hold` to retain a started message for immediate review.
- `whatsapp.resolve_inbox_messages`: atomically retry or discard held messages
  filtered by `reason`, `client_id`, or both. Requires `response_variable` and at
  least one filter. Returns `status`, `resolution`, and the number `resolved`.
  Leaves active processing and ordinary pending messages alone. Disabled-account
  work is visible as `account_disabled` and can be discarded.
- `whatsapp.recover_inbox`: reload failed private storage with `mode: reload`
  (the default). Use `mode: reset` only to archive a proven invalid snapshot and
  start a fresh inbox. Archived work is preserved but not replayed. Requires
  `response_variable`; returns `status: ready`, enabled `clients`, and an
  optional archive basename. Healthy storage is left running.

See [Recover incoming messages](../examples/reliable-incoming-messages.md) for
the migration example, restart behavior, storage limits, and media retention.

## Examples

- [Messages and media](../examples/messages.md)
- [Recipients, profiles, and group lists](../examples/recipients.md)
- [Presence](../examples/presence.md)
- [Automations, calls, and read markers](../examples/automations.md)
- [AI voice calls, setup, and call alerts](../examples/voice-calls.md)
- [Reusable notification scripts](../examples/scripts.md)
- [Incoming messages and conversation agents](../examples/incoming-messages.md)
