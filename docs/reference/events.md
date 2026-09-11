# Events

The add-on fires these Home Assistant events:

See [incoming message examples](../examples/incoming-messages.md) for chat
filters, text extraction, media types, and conversation replies.

| Event type | Description |
| --- | --- |
| `new_whatsapp_message` | A received WhatsApp message. |
| `whatsapp_message_sent` | An outgoing WhatsApp message reported by the connected session. |
| `whatsapp_call_update` | An incoming WhatsApp call lifecycle update. |
| `whatsapp_presence_update` | A contact presence update. |
| `whatsapp_send_message_result` | Compatibility result event after sending a message. |
| `whatsapp_addon_health_failure` | Sanitized diagnostics after a previous add-on run ends unhealthy. |

## Message events

`new_whatsapp_message` and `whatsapp_message_sent` include the configured
`clientId`, the detected message `type`, the Baileys message `key`, and the
`message` payload. Other fields, such as `messageTimestamp`, are passed through
when present.

Starting with add-on 1.4.39, `whatsapp_message_sent` fires for messages with
`key.fromMe: true`, including messages sent from the phone, other linked
devices, and the add-on itself when reported by WhatsApp. For this event,
`key.remoteJid` identifies the destination chat or group and can be a LID.
The existing dedupe checks apply to both directions. The event reports a sent
message observed by the session; it is not a delivery or read receipt.

Only the add-on needs updating for this event. It sends the event directly to
Home Assistant, so no integration update is required. Existing received-message
automations still use `new_whatsapp_message`. Logging automations can listen to
both events, as in the [logging example](../examples/automations.md#log-received-and-sent-messages). Reply and mark-as-read automations should
keep listening only to the received-message event to avoid acting on own sends.

The dedupe layer runs before either message event is fired and tracks
each direction separately. Media dedupe ignores wrapper-only fields such as
thumbnails, CDN paths, scan sidecars, and media key timestamp representation
because WhatsApp can vary those between phone-number and LID deliveries of the
same message.

## Capture a send-result event

The integration fires `whatsapp_send_message_result` after a successful
`whatsapp.send_message` call. Its fields are `client_id`, `to`, `body`, and
`sent_message`. This event uses **`client_id`**, while incoming and outgoing
message events use **`clientId`**. It is not a delivery receipt and does not
collect messages sent from the phone.

My [advanced automations tutorial](https://smarthome.yoavmor.com/home-assistant/enhancing-the-whatsapp-addon-for-home-assistant-new-features-for-advanced-automations/)
stores the last message ID in a Text helper. Create
`input_text.whatsapp_last_sent_id` with a maximum length of 255, then filter
the collector to one client and destination:

```yaml
- alias: Store the last WhatsApp text notification ID
  triggers:
    - trigger: event
      event_type: whatsapp_send_message_result
      event_data:
        client_id: default
        to: 120363000000000000@g.us
  conditions:
    - condition: template
      value_template: >-
        {% set body = trigger.event.data.get('body', {}) %}
        {{ body is mapping and 'text' in body and 'edit' not in body }}
  actions:
    - action: input_text.set_value
      target:
        entity_id: input_text.whatsapp_last_sent_id
      data:
        value: "{{ trigger.event.data.sent_message.key.id }}"
  mode: queued
```

The `to` filter matches the action's original target exactly. A send to a phone
number will not match a filter containing its LID. The body condition excludes
reaction, edit, and delete results from this text-notification collector.

The helper holds the latest matching ID, so another send can overwrite it.
For a specific task, use the action's [response variable](../examples/messages.md#capture-the-sent-message-id)
and preserve the [full message key](../examples/scripts.md#save-a-message-key-for-another-run).

## Call events

`whatsapp_call_update` fires for every call lifecycle update reported by
Baileys. Its `status` is one of `offer`, `ringing`, `accept`, `reject`,
`timeout`, or `terminate`. Each event has a stable payload containing
`clientId`, `callId`, `status`, `from`, `chatId`, `isVideo`, `isGroup`,
`groupJid`, `date`, and `offline`. Fields that are absent from an upstream
update are `null`. The `from` and `chatId` values can be WhatsApp LIDs rather
than phone-number JIDs. The add-on preserves the observed update order and
retries transient delivery failures across a 33-second backoff window when Home
Assistant Core is unavailable. Baileys lifecycle updates can still be missing
or arrive after a reconnect, so automations should filter the status they need
without assuming that every call produces every status.

## Health events

`whatsapp_addon_health_failure` fires on the next successful startup when the
saved history ends with three consecutive failed native health checks. Its
bounded data includes timestamps, failure classification, HTTP and curl result,
probe timings and streak, plus available process and container metrics. It never
includes message contents, account identifiers, URLs, headers, tokens, or raw
response bodies.

`whatsapp_addon_health_failure` includes its schema and service, a run id,
first and last failure timestamps, failure count and streak, the bounded failure
classification, HTTP and curl result, probe timings, and any available bounded
process or container metrics. It contains no message contents, account
identifiers, URLs, headers, tokens, or raw response bodies.

Isolated libsignal `Bad MAC`, message-counter, and session lifecycle console
logs are filtered and summarized as counts instead of exposing full stack
traces or session data. A confirmed high-volume decryption failure burst
activates the recovery pause described in the [add-on documentation](https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/DOCS.md#encryption-recovery).
