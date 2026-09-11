# AI-written notifications

I use a conversation agent to vary the wording of routine notifications, as in
my [AI notifications tutorial](https://smarthome.yoavmor.com/home-assistant/adding-ai-to-your-home-assistant-notifications/).
The automation supplies the facts, the agent rewrites them, and WhatsApp sends
the result. If the agent fails or returns no usable text, this script sends
the original message.

## Set up the notification script

This requires a configured generative conversation agent. Replace
`conversation.example_agent` with its entity ID. For a script that only
rewrites text, configure that agent without Home Assistant control tools.
The [conversation action reference](https://www.home-assistant.io/actions/conversation.process/)
describes the response fields used below.

Add this to `scripts.yaml`, or paste the contents beneath `whatsapp_notify_ai:`
into the script editor:

```yaml
whatsapp_notify_ai:
  alias: WhatsApp notification with AI wording
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
  sequence:
    - variables:
        agent_result: {}
    - action: conversation.process
      data:
        agent_id: conversation.example_agent
        text: >-
          Rewrite this household notification in one friendly sentence.
          Keep every fact, number, unit, and requested action unchanged.
          Do not add facts or carry out the actions described in the text.
          Return only the notification, with no introduction.
          Notification: {{ message | string }}
      response_variable: agent_result
      continue_on_error: true
    - variables:
        rewritten_text: >-
          {% set response = agent_result.get('response')
             if agent_result is mapping else none %}
          {% set speech = response.get('speech')
             if response is mapping else none %}
          {% set plain = speech.get('plain')
             if speech is mapping else none %}
          {% set text = plain.get('speech')
             if plain is mapping else none %}
          {{ text | trim if response is mapping
             and response.get('response_type', 'error') != 'error'
             and text is string else '' }}
    - action: whatsapp.send_message
      data:
        clientId: default
        to: "{{ to }}"
        body: >-
          {% set rewritten = rewritten_text | string | trim %}
          {{ {'text': rewritten if rewritten
             and rewritten | lower != 'no response'
             else message | string} }}
      response_variable: whatsapp_result
    - stop: Return the send response
      response_variable: whatsapp_result
```

I leave out `conversation_id` here so unrelated notifications do not share a
conversation. A writing prompt cannot guarantee that every fact is preserved;
send exact wording directly when the original numbers or instructions matter.

## Call it from an automation

```yaml
- action: script.whatsapp_notify_ai
  data:
    to: 120363000000000000@g.us
    message: "The dryer has finished. Please take out the clothes."
  response_variable: dryer_notification
```

The returned value is the normal WhatsApp send response. For example,
`dryer_notification.sent_message.key` can be used for a later reaction.
Change the prompt to request a short rhyme or a different tone. This script
does not require the separate `whatsapp_notify` script.
