# Recover incoming messages after a restart

The persistent inbox keeps messages received by the WhatsApp app while Home
Assistant is unavailable. After Home Assistant finishes starting, the integration
delivers the oldest pending message as `new_whatsapp_message`. It delivers the
next message only after the automation acknowledges completion.

Update the app and integration to **3.1.0 or newer**. Inbox delivery is opt-in for
each account. Accounts outside `inbox_clients` retain their existing event path.

## Migrate the processing automation first

Add a start gate before any action with side effects, and complete the message
only after processing and the WhatsApp reply finish. Preserve the original event
data when calling your existing workflow. This fictional example echoes text;
replace the middle action with your existing processing and reply actions.

```yaml
alias: Process WhatsApp inbox messages
triggers:
  - trigger: event
    event_type: new_whatsapp_message
    event_data:
      clientId: default
actions:
  - variables:
      inbox: "{{ trigger.event.data.get('inbox') }}"
  - if: "{{ inbox is not none }}"
    then:
      - action: whatsapp.start_inbox_message
        data:
          inbox: "{{ inbox }}"
        response_variable: claimed
      - if: "{{ not claimed.started }}"
        then:
          - stop: This delivery is already claimed or completed
  # Put your allowed-chat checks here. A deliberately ignored message must
  # still reach the completion action so it does not block the queue.
  - action: whatsapp.send_message
    data:
      clientId: "{{ trigger.event.data.clientId }}"
      to: "{{ trigger.event.data.key.remoteJid }}"
      body:
        text: "{{ trigger.event.data.message.get('conversation', '') }}"
  - if: "{{ inbox is not none }}"
    then:
      - action: whatsapp.complete_inbox_message
        data:
          inbox: "{{ inbox }}"
mode: queued
max: 10
```

Then add the account IDs to the app configuration and restart the app:

```yaml
inbox_clients:
  - default
download_media: true
```

Reload the WhatsApp integration if it was already loaded before inbox support
became available. No extra startup automation is required. An update hint wakes
the consumer when messages arrive, and a ten-second poll recovers missed hints.

Only one processing automation should claim each message. Other event listeners
may observe redeliveries before the claim succeeds. The atomic start gate permits
only one execution; do not omit it from a workflow with side effects. Reuse the
event's original message ID and sender fields for conversation history and routing.

## Resolve an interrupted message

An automation failure after the start gate leaves the message in `processing`.
Inspect its trace before recovering it. Reloading the integration establishes a
new consumer session and marks unfinished processing as `interrupted`.
An app restart also marks started messages as interrupted. Pending messages that
never passed the start gate resume automatically.

Run `whatsapp.get_inbox` with a response variable in Developer Tools or a script.
It returns counts and the oldest unfinished item. When its status is
`interrupted`, copy its `inbox` object into `whatsapp.resolve_inbox_message`:

- Choose `discard` if the action already happened or should no longer run.
- Choose `retry` only after checking the action did not finish. The next delivery
  receives a new receipt, so stale acknowledgements cannot complete that retry.

The integration also emits `whatsapp_inbox_interrupted` once per interrupted item.
No message is automatically repeated after an uncertain action. For delayed
commands, use the original `messageTimestamp` or `inbox.received_at` in your
automation to decide whether the request is still relevant.

## Storage and limits

The inbox stores only incoming messages for enabled accounts in the app's private
`/data/inbox/messages.json`, with owner-only file permissions. Message IDs, sender
metadata and payloads remain in private storage and authenticated API responses;
they are omitted from logs and diagnostics. Completed payloads are removed
immediately. Duplicate receipts are retained for up to seven days and 10,000
completed messages; this is bounded duplicate protection, not permanent history.

The default limits are 1,000 unfinished messages, 32 MiB of inbox state, and 1 MiB
per message payload. Capacity or storage errors are logged explicitly; unfinished
messages are never evicted to admit new ones. Adequate free storage remains
necessary. The inbox cannot recover events discarded before this feature was
enabled or messages the app never received.

With media downloading enabled, pending attachment files are protected from
normal expiry cleanup and their expiry metadata is renewed before delivery.
Existing file-size and total-media quotas still apply. Completing the message
releases its media protection. Disabling an inbox account returns it to legacy
delivery; resolve its pending work first, because paused accounts are not drained
and media protection ends when inbox support is disabled.

The app owns a single active Home Assistant consumer session. Reloading one
integration supersedes its previous consumer; competing Home Assistant instances
should not drain the same app. Keep completion acknowledgements explicit:
an HTTP response accepting an event does not prove the automation finished.
