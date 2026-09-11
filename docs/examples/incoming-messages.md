# Incoming messages and conversation agents

I filter incoming events by both the client session and destination chat
before running a reply workflow. These examples use a synthetic group JID;
replace it with the chat that should activate your automation.

## Extract text and filter one chat

Text can appear in `message.conversation` or
`message.extendedTextMessage.text`. This example handles both and ignores
events that do not contain text:

```yaml
- alias: WhatsApp group ping
  triggers:
    - trigger: event
      event_type: new_whatsapp_message
      event_data:
        clientId: default
        key:
          remoteJid: 120363000000000000@g.us
  actions:
    - variables:
        message_text: >-
          {% set message = trigger.event.data.get('message', {}) %}
          {{ message.get('conversation') or
             message.get('extendedTextMessage', {}).get('text', '') }}
    - condition: template
      value_template: "{{ message_text | string | trim == '!ping' }}"
    - action: whatsapp.send_message
      data:
        clientId: "{{ trigger.event.data.clientId }}"
        to: "{{ trigger.event.data.key.remoteJid }}"
        body:
          text: pong
  mode: queued
```

Use the event's `key.remoteJid` as the reply target. In a group, the sender can
also appear in `key.participant`; preserve the entire key for reactions and
read markers. Keep reply triggers on `new_whatsapp_message` so outgoing
`whatsapp_message_sent` events do not trigger another reply.

## Reply with a conversation agent

This requires a configured [Home Assistant conversation agent](https://www.home-assistant.io/integrations/conversation/).
Replace `conversation.example_agent` with that agent's entity ID. I check its
response before sending any reply and stop typing even when the agent or send
action reports an error.

```yaml
- alias: WhatsApp conversation reply
  triggers:
    - trigger: event
      event_type: new_whatsapp_message
      event_data:
        clientId: default
        key:
          remoteJid: 120363000000000000@g.us
  actions:
    - variables:
        agent_result: {}
        incoming_text: >-
          {% set message = trigger.event.data.get('message', {}) %}
          {{ message.get('conversation') or
             message.get('extendedTextMessage', {}).get('text', '') }}
    - condition: template
      value_template: "{{ incoming_text | string | trim != '' }}"
    - action: whatsapp.send_presence_update
      data:
        clientId: "{{ trigger.event.data.clientId }}"
        to: "{{ trigger.event.data.key.remoteJid }}"
        type: composing
      continue_on_error: true
    - action: conversation.process
      data:
        agent_id: conversation.example_agent
        text: "{{ incoming_text | string }}"
      response_variable: agent_result
      continue_on_error: true
    - variables:
        reply_text: >-
          {% set response = agent_result.get('response', {})
             if agent_result is mapping else {} %}
          {% if response is mapping
             and response.get('response_type', 'error') != 'error' %}
            {{ response.get('speech', {}).get('plain', {}).get('speech', '')
               | string | trim }}
          {% else %}
            {{ '' }}
          {% endif %}
    - if:
        - condition: template
          value_template: >-
            {{ reply_text | string | trim != ''
               and reply_text | string | trim | lower != 'no response' }}
      then:
        - action: whatsapp.send_message
          data:
            clientId: "{{ trigger.event.data.clientId }}"
            to: "{{ trigger.event.data.key.remoteJid }}"
            body: '{{ {"text": reply_text | string | trim} }}'
          continue_on_error: true
    - action: whatsapp.send_presence_update
      data:
        clientId: "{{ trigger.event.data.clientId }}"
        to: "{{ trigger.event.data.key.remoteJid }}"
        type: paused
      continue_on_error: true
  mode: queued
  max: 10
```

`no response` is an optional convention for an agent instructed to remain
silent; it is not a special WhatsApp response. This example sends one incoming
text to the agent. It does not add chat history or configure the agent's tools.
For a longer request, use the [bounded typing helper](presence.md#keep-typing-while-another-action-runs).
For context across messages, see the complete [conversation history recipe](conversation-history.md).
For outgoing alerts, see [AI-written notifications](ai-notifications.md).

## Recognize incoming media

I branch on the event's detected `type` and inspect the matching message object:

| Event `type` | Message field | Use in a workflow |
| --- | --- | --- |
| `conversation` | `message.conversation` | Plain text. |
| `extendedTextMessage` | `message.extendedTextMessage.text` | Text with additional metadata. |
| `imageMessage` | `message.imageMessage` | Image processing; the object may include a caption. |
| `audioMessage` | `message.audioMessage` | Audio or voice-message processing. |
| `documentMessage` | `message.documentMessage` | Document processing. |
| `videoMessage` | `message.videoMessage` | Video processing. |

For example, this automation acknowledges an image with a reaction:

```yaml
- alias: Acknowledge a WhatsApp image
  triggers:
    - trigger: event
      event_type: new_whatsapp_message
      event_data:
        clientId: default
        type: imageMessage
        key:
          remoteJid: 120363000000000000@g.us
  actions:
    - action: whatsapp.send_message
      data:
        clientId: "{{ trigger.event.data.clientId }}"
        to: "{{ trigger.event.data.key.remoteJid }}"
        body:
          react:
            text: "\u2705"
            key: "{{ trigger.event.data.key }}"
  mode: queued
```

Message payloads can also contain wrappers or protocol fields. These examples
cover the listed shapes and do not implement a general Baileys message decoder.

## Workflows that need separate helpers

These workflows require another integration or a custom helper:

| Workflow | Additional requirement |
| --- | --- |
| Voice message to text, then an agent reply | A separate audio downloader/decrypter and transcription integration. |
| Image or document analysis | A separate media processor that accepts the incoming message data. |
| Agent reply as a voice message | A text-to-speech service that produces a downloadable audio file, followed by `body.audio` with `ptt: true`. |
| Download or transform a video, then send clips | A separate video service returning ready-to-send URLs. |
| Generate a sticker, then send it | A custom generator returning a prepared WebP URL. |
| Keep per-chat history for an agent | Agent-managed conversation IDs or separate storage, such as the [File and Shell Command recipe](conversation-history.md). |

These processors and storage helpers are not bundled with WhatsApp for Home
Assistant. An incoming media URL can refer to encrypted WhatsApp data; it is
not automatically a ready-to-send image, document, or audio URL. Keep the full
message object for a processor that knows how to handle it. See
[sending helper results](scripts.md#send-media-returned-by-a-helper) for the
outgoing side of the workflow.
