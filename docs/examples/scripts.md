# Reusable notification scripts

I use scripts to share notification behavior between automations and to return
the WhatsApp send response to the caller. The examples below are simplified
versions of those patterns, with fictional recipients.

## Send a notification and return its response

Add this definition to `scripts.yaml`. In the script editor, use the contents
beneath `whatsapp_notify:`.

```yaml
whatsapp_notify:
  alias: WhatsApp notify
  mode: queued
  max: 10
  fields:
    message:
      required: true
      selector:
        text:
          multiline: true
    to:
      required: true
      selector:
        text:
    client_id:
      default: default
      selector:
        text:
    quoted_message:
      required: false
      selector:
        object:
  sequence:
    - action: whatsapp.send_message
      data:
        clientId: "{{ client_id | default('default') }}"
        to: "{{ to }}"
        body: '{{ {"text": message | string} }}'
        options: >-
          {{ {'quoted': quoted_message}
             if quoted_message is defined and quoted_message is mapping
             else {} }}
      response_variable: whatsapp_result
    - stop: Return the send response
      response_variable: whatsapp_result
```

Call the script directly to receive its response. I can then send a later
notification as a reply to the first:

```yaml
- action: script.whatsapp_notify
  data:
    to: 120363000000000000@g.us
    message: "The task has started."
  response_variable: task_start
- delay: "00:00:05"
- action: script.whatsapp_notify
  data:
    to: "{{ task_start.sent_message.key.remoteJid }}"
    message: "The task is complete."
    quoted_message: "{{ task_start.sent_message }}"
  response_variable: task_end
```

Replace the delay with the actual work or a wait for completion. `task_start`
and `task_end` have the same response shape as `whatsapp.send_message`.
Calling `script.turn_on` starts a script in the background and does not return
this response to the caller. See [Home Assistant script responses](https://www.home-assistant.io/integrations/script/).

## Save a message key for another run

I store only the message key when a later automation needs to add a completion
reaction. A quoted reply needs the full message object and should keep that
object in a variable or suitable storage instead.

Create a Text helper named `input_text.whatsapp_task_key` with a maximum length
of 255. The equivalent `configuration.yaml` entry is:

```yaml
input_text:
  whatsapp_task_key:
    name: WhatsApp task key
    max: 255
```

These actions clear any previous key, send a new notification, and save its
key as JSON only if it fits:

```yaml
- action: input_text.set_value
  target:
    entity_id: input_text.whatsapp_task_key
  data:
    value: ""
- action: whatsapp.send_message
  data:
    clientId: default
    to: 120363000000000000@g.us
    body:
      text: "The task has started."
  response_variable: task_start
- variables:
    key_json: "{{ task_start.sent_message.key | to_json }}"
- if:
    - condition: template
      value_template: "{{ key_json | length <= 255 }}"
  then:
    - action: input_text.set_value
      target:
        entity_id: input_text.whatsapp_task_key
      data:
        value: "{{ key_json }}"
  else:
    - stop: The message key is too long for the text helper
      error: true
```

In the completion automation, read the JSON and reuse the full key:

```yaml
- variables:
    message_key: >-
      {{ states('input_text.whatsapp_task_key') | from_json(default={}) }}
- condition: template
  value_template: >-
    {{ message_key is mapping and message_key.get('id')
       and message_key.get('remoteJid')
       and message_key.get('fromMe') == true }}
- action: whatsapp.send_message
  data:
    clientId: default
    to: "{{ message_key.remoteJid }}"
    body:
      react:
        text: "\u2705"
        key: "{{ message_key }}"
- action: input_text.set_value
  target:
    entity_id: input_text.whatsapp_task_key
  data:
    value: ""
```

Use the same client session for both runs and a separate helper for each
independent task. Do not let overlapping runs overwrite each other's key.
Home Assistant [text helpers have a 255-character limit](https://www.home-assistant.io/integrations/input_text/#configuration-variables);
never truncate JSON to fit. Keys contain private chat and message identifiers.

## Send media returned by a helper

I also use scripts that prepare a file and return a URL, then pass that URL to
WhatsApp. For example, the following sequence assumes **your own**
`script.prepare_sticker` already exists and returns a mapping containing `url`:

```yaml
- action: script.prepare_sticker
  data:
    description: "A small green check mark"
  response_variable: sticker_result
- action: whatsapp.send_message
  data:
    clientId: default
    to: 120363000000000000@g.us
    body:
      sticker:
        url: "{{ sticker_result.url }}"
```

The helper is a prerequisite, not an action provided by this integration.
The same pattern applies to exported PDFs, generated images, and converted
videos: wait for the helper to finish and return a downloadable URL before
sending the file.
