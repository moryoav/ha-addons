# Messages and media

Use `whatsapp.send_message` with the body for the message type you need.
See [recipients and number lookup](recipients.md) for target formats.

For file examples, replace `https://files.example.com/...` with a URL the
add-on can download. The URL must return the file itself. A path on the Home
Assistant host is not automatically a path inside the add-on container.

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
`message_id`. The integration also
fires `whatsapp_send_message_result` after a message is sent. Success means the
linked client accepted the send operation; it does not guarantee delivery,
receipt, or that the recipient read the message.

See [the send-result event example](../reference/events.md#capture-a-send-result-event)
to collect results in a separate event listener.

## Edit a sent text message

I use the original `sent_message.key` to update a notification after a task
finishes.

```yaml
- action: whatsapp.send_message
  data:
    clientId: default
    to: 999000111222333@lid
    body:
      text: "The task is running."
  response_variable: task_message
- delay: "00:00:05"
- action: whatsapp.send_message
  data:
    clientId: default
    to: "{{ task_message.sent_message.key.remoteJid }}"
    body:
      text: "The task has finished."
      edit: "{{ task_message.sent_message.key }}"
```

Replace the delay with your task. Use the same client session and the original
key, including `id`, `remoteJid`, and `fromMe`. Editing is subject to WhatsApp's
editing window and message eligibility; this example edits a text message
sent by the linked account. An accepted action is not proof that the recipient
has received the edit.

## Delete a sent message

This sends a new temporary notification, then requests its deletion for
everyone. Use it only when removal is the intended behavior:

```yaml
- action: whatsapp.send_message
  data:
    clientId: default
    to: 999000111222333@lid
    body:
      text: "Temporary test notification."
  response_variable: temporary_message
- delay: "00:00:10"
- action: whatsapp.send_message
  data:
    clientId: default
    to: "{{ temporary_message.sent_message.key.remoteJid }}"
    body:
      delete: "{{ temporary_message.sent_message.key }}"
```

`body.delete` is a full message key, not just an ID. WhatsApp applies its own
deletion limits, and recipients may already have seen the message. For a later
automation run, use the [saved-key pattern](scripts.md#save-a-message-key-for-another-run).
Keep the original key when chaining edits, reactions, or deletion; a response
to an edit/delete operation identifies that protocol operation.

These payloads are supported by the pinned Baileys 6.7.23 message types and
passed through by `whatsapp.send_message`. They do not use separate edit or
delete Home Assistant actions.

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

## Send a sticker

I use a prepared WebP file for stickers. Image generation and conversion to
WebP happen before the send action.

```yaml
action: whatsapp.send_message
data:
  clientId: default
  to: 120363000000000000@g.us
  body:
    sticker:
      url: "https://files.example.com/ready.webp"
```

When another script prepares the file and returns its URL in response data,
the `url` field can use a template such as `"{{ sticker_result.url }}"`.
That helper script is separate from this integration; `whatsapp.send_message`
does not generate stickers.

## Send a document

```yaml
action: whatsapp.send_message
data:
  clientId: default
  to: 12025550123@s.whatsapp.net
  body:
    document:
      url: "https://files.example.com/report.pdf"
    fileName: report.pdf
    mimetype: application/pdf
    caption: "Here is the report."
```

`fileName`, `mimetype`, and `caption` belong in `body`, alongside `document`.
Use a MIME type that matches the actual file. A document export or download
from another application must finish before this action runs.

## Send a video

```yaml
action: whatsapp.send_message
data:
  clientId: default
  to: 12025550123@s.whatsapp.net
  body:
    video:
      url: "https://files.example.com/clip.mp4"
    caption: "Here is the clip."
```

This sends an already prepared video. Downloading, converting, or splitting a
video into clips requires a separate tool. When that tool returns a list of
URLs, a Home Assistant `repeat.for_each` can send one video per URL.

## Create a poll

I verified this three-option poll with a live send and a returned vote event.
This payload allowed the recipient to select multiple options.

```yaml
action: whatsapp.send_message
data:
  clientId: default
  to: 120363000000000000@g.us
  body:
    poll:
      name: Which report would you like?
      values:
        - Daily report
        - Weekly report
        - Monthly report
```

The existing pattern also builds `values` from JSON stored in a text helper:
`values: "{{ states('input_text.report_choices') | from_json }}"`.
That helper must contain a valid JSON array of strings.

In the live test, `new_whatsapp_message` carried a `message.pollUpdateMessage`
object whose `pollCreationMessageKey.id` matched the sent poll's message ID.
That lets a workflow associate an update with its poll. This example does not
decode the selected options or calculate vote totals.

## React to a message sent earlier

I capture the send response so a later action can react to the original
notification. Use the full `sent_message.key`, including any extra fields.

```yaml
- action: whatsapp.send_message
  data:
    clientId: default
    to: 120363000000000000@g.us
    body:
      text: "The task has started."
  response_variable: start_message
- delay: "00:00:05"
- action: whatsapp.send_message
  data:
    clientId: default
    to: "{{ start_message.sent_message.key.remoteJid }}"
    body:
      react:
        text: "\u2705"
        key: "{{ start_message.sent_message.key }}"
```

The delay stands in for your task. The YAML escape `\u2705` is a check-mark
emoji. Use an empty reaction text to remove it. The same client session must
perform both sends. See [saving a message key](scripts.md#save-a-message-key-for-another-run)
when the completion action belongs to another automation run.

## Reply to a notification with a sticker

I use `options.quoted` to attach a follow-up to a notification sent earlier.
Quoting needs the full `sent_message` object; a reaction uses its `key`.

```yaml
- action: whatsapp.send_message
  data:
    clientId: default
    to: 120363000000000000@g.us
    body:
      text: "The task is complete."
  response_variable: completed_message
- action: whatsapp.send_message
  data:
    clientId: default
    to: "{{ completed_message.sent_message.key.remoteJid }}"
    body:
      sticker:
        url: "https://files.example.com/ready.webp"
    options:
      quoted: "{{ completed_message.sent_message }}"
```

The quoted follow-up can also be a text message: replace the sticker body
with `text: "Here is a follow-up."` and retain `options.quoted`.

## Build the message body with a template

I also use a template that returns a dictionary when message content comes
from another action. Here the source is a simple variable.

```yaml
- variables:
    reply_text: "The task is complete."
- action: whatsapp.send_message
  data:
    clientId: default
    to: 12025550123@s.whatsapp.net
    body: '{{ {"text": reply_text | string | trim} }}'
```

The rendered `body` must be an object. Converting the inner text to a string
also handles content that Home Assistant interpreted as a number.
See [Home Assistant action templates](https://www.home-assistant.io/docs/scripts/perform-actions/#use-templates-to-determine-the-attributes).
