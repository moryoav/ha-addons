# Recover incoming messages after a restart

The persistent inbox keeps messages received by the WhatsApp app while Home
Assistant is unavailable. After Home Assistant finishes starting, the integration
delivers pending messages as `new_whatsapp_message`. Each account has its own
ordered queue. A disconnected account does not block other accounts.
Offers rotate between eligible accounts so one unclaimed head cannot monopolize
delivery to Home Assistant.

Update the app and integration to **3.1.0 or newer**. Inbox delivery is opt-in for
each account. Accounts outside `inbox_clients` retain their existing event path.

## Migrate the processing automation first

Claim each inbox message before any action with side effects. Complete it after
successful processing and the WhatsApp reply. Deliberately ignored messages also
need completion. Put chat and message-type checks inside the actions, after the
claim, so a trigger filter cannot silently strand the message.

This fictional example accepts text from one private chat. Replace the chat ID
and the processing script with your own workflow. Keep the start gate, ignored
branch, success response and failure handling.

First, add this example to `scripts.yaml`. A failed action aborts the script
before it can return `success: true`. Keep your processing actions inside this
script and give long operations a timeout below the inbox's 30-minute watchdog.

```yaml
process_whatsapp_inbox_message:
  alias: Process a WhatsApp inbox message
  mode: parallel
  fields:
    incoming:
      required: true
      selector:
        object:
  sequence:
    - action: whatsapp.send_message
      data:
        clientId: "{{ incoming.clientId }}"
        to: "{{ incoming.key.remoteJid }}"
        body:
          text: "{{ incoming.message.conversation }}"
    - variables:
        outcome:
          success: true
    - stop: Processing and reply completed
      response_variable: outcome
```

Then use this automation. `continue_on_error` lets it record a failed workflow
for review; it does not acknowledge a failed workflow as completed.
Keep `mode: parallel` on both the automation and processing script when they
handle several accounts. The inbox permits one active message per account, so
one account's long workflow must leave room for another account to claim its
message within 60 seconds. Alternatively, use a separate processing automation
and script for each account. A shared `single` or `queued` workflow can leave
other accounts' messages unclaimed.

```yaml
alias: Process WhatsApp inbox messages
triggers:
  - trigger: event
    event_type: new_whatsapp_message
actions:
  - variables:
      incoming: "{{ trigger.event.data }}"
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
  - if: >-
      {{ incoming.clientId != 'default'
         or incoming.key.remoteJid != '12025550123@s.whatsapp.net'
         or not incoming.message.get('conversation') }}
    then:
      - if: "{{ inbox is not none }}"
        then:
          - action: whatsapp.complete_inbox_message
            data:
              inbox: "{{ inbox }}"
      - stop: Deliberately ignored chat or message type
  - action: script.process_whatsapp_inbox_message
    continue_on_error: true
    data:
      incoming: "{{ incoming }}"
    response_variable: processed
  - if: "{{ inbox is not none }}"
    then:
      - if: >-
          {{ processed is defined and processed is mapping
             and processed.get('success', false) }}
        then:
          - action: whatsapp.complete_inbox_message
            continue_on_error: true
            data:
              inbox: "{{ inbox }}"
        else:
          - action: whatsapp.resolve_inbox_message
            continue_on_error: true
            data:
              inbox: "{{ inbox }}"
              resolution: hold
mode: parallel
max: 20
```

If the completion or hold request fails, the message remains started. The
watchdog retains it for review after 30 minutes. Inspect its automation trace
before retrying, because some actions may already have happened. Use the event's
original message ID and sender fields for conversation history and routing.

After migrating, enable the selected account in the app configuration:

```yaml
inbox_clients:
  - default
download_media: true
```

Reload the WhatsApp integration if it was already loaded before inbox support
became available. No extra startup automation is required. Update hints wake the
consumer, and a ten-second poll recovers missed hints. Only one automation should
claim a message. Other listeners can observe repeated events before the claim;
the atomic start gate permits only one execution.

## Messages that need review

The integration delivers an unclaimed message at most three times per delivery
receipt, at least 20 seconds apart. If it is still unclaimed 60 seconds after its
first offer, the app holds it as `blocked` with reason `unclaimed`. Later messages
continue. A new HA consumer session, app restart, or observed account disconnect
gives pending messages a fresh claim window. App restarts and disconnects rotate
offered receipts so the running integration can offer them again.
The app holds preparation stalled for 15 minutes at a connected account's
eligible queue head, and marks
processing stalled for 30 minutes as `interrupted`. Held messages stay in private
storage. Queue waiting time and account disconnection do not count as failed
preparation. Ready messages wait for reconnection. Held messages are never
automatically retried or discarded.

Home Assistant creates a persistent notification and emits
`whatsapp_inbox_attention` for held messages. Started messages interrupted by an
app restart or a new HA session are also held, with
`whatsapp_inbox_interrupted` retained for compatibility. The notification clears
when all held messages are resolved. These limits are safeguards; workflows that
may still be running must be checked before retrying.

Run `whatsapp.get_inbox` in Developer Tools > Actions. Its response contains
queue counts, the next eligible item, and an `attention` list of held items with
opaque `inbox` references and reasons. Inspection does not start an unclaimed
message's offer timer. Copy a current reference into
`whatsapp.resolve_inbox_message`:

- Choose `discard` for a message that should not run, including pending or
  unprepared messages. An actively processing message must first finish or be
  held for review.
- Choose `retry` after checking that its actions did not finish. This rotates the
  receipt so stale acknowledgements cannot complete the retry. A retry waits for
  any active workflow on the same account.
- Use `hold` from a failing workflow to retain a started message for immediate
  review. Holding does not cancel actions that are already running.

For a backlog, use `whatsapp.resolve_inbox_messages` with `resolution: retry` or
`discard` and at least one filter: `reason` or `client_id`. If both are supplied,
both must match. It changes all matching held messages in one atomic operation
and returns the number resolved. It leaves ordinary pending and actively
processing messages alone. Inspect `get_inbox` and the automation traces first:
bulk retry can repeat actions that already happened. This example discards only
unclaimed messages from the selected account:

```yaml
action: whatsapp.resolve_inbox_messages
data:
  client_id: default
  reason: unclaimed
  resolution: discard
response_variable: resolved
```

Held messages count toward the 1,000-message limit and keep their attachments
pinned. They do not expire automatically. Use filtered bulk discard for obsolete
work to release its payloads, media protection, and queue capacity. Messages from
disabled inbox accounts appear with reason `account_disabled`; discard them or
reenable the account before retrying. The recovery actions remain available when
all inbox accounts are disabled if private inbox storage already exists.

A late completion from the same consumer can still finish an interrupted item.
No uncertain action is automatically repeated. For delayed commands, use the
original `messageTimestamp` or `inbox.received_at` to decide whether the request
is still relevant. Explicit retries preserve the original receipt time.

## Storage and failures

The app keeps `/data/inbox/messages.json` with owner-only permissions. Private
message data is omitted from logs and diagnostics. Completed payloads are
removed immediately. Compact duplicate receipts are retained for up to seven
days and 1,000 completed messages. This is bounded protection, not permanent
history. Unchanged polls do not clone or rewrite the stored inbox; mutations use
an atomic, synced snapshot.

Limits are 1,000 unfinished messages, 32 MiB of state, and 1 MiB per payload.
Admission reserves space for media metadata and later state transitions.
Unfinished messages are never evicted to admit new ones. If admission fails
because of capacity, payload size or storage, the app attempts the original live
event path with an `inbox_error` code and no `inbox` reference. It also emits
`whatsapp_inbox_error`, logs a safe error and attempts a persistent notification.
Live fallback cannot recover a message while Home Assistant is unavailable.

Unreadable inbox state is preserved. The rest of the app starts, and inbox
accounts use live fallback until recovery succeeds. An uncertain disk flush
stops further inbox writes to protect the published state. After a normal app
restart, pending messages resume, including unfinished downloads. Only an
unready admission with a surviving crash guard is held as
`preparation_interrupted`: that specific message may already have used live
fallback. Started messages remain held.

On Home Assistant OS, use Developer Tools > Actions > **WhatsApp: Recover
message inbox** (`whatsapp.recover_inbox`) without editing private app files.
Choose `mode: reload` after resolving free-space or temporary storage failures.
Recovery reloads the preserved snapshot and resumes delivery without restarting
the app. Running it on healthy storage does not interrupt active work.

If the snapshot is invalid and reload fails, back up the app, then choose
`mode: reset`. Reset is permitted only for a snapshot proven invalid, not for
a transient read error. It archives the original as
`/data/inbox/messages.invalid-<UUID>.json` with private permissions, then starts a
fresh inbox. The response contains the archive basename. Archived messages are
preserved in the app data and backups but are **not automatically imported or
replayed**. Review the archive separately before deciding how to recover that
work. A reset cannot repair a full or failing disk.

While state is unreadable, only media IDs identifiable in known state or the
bounded raw snapshot remain protected. Unrelated media still expires normally.
Recovery releases these temporary pins; resolve held messages promptly to avoid
exhausting the media quota.

With media downloading enabled, unfinished attachments are protected from expiry
cleanup. Temporary download failures receive up to three attempts with backoff.
Temporary renewal failures keep the original reference pinned and retry; a
missing or corrupt attachment is delivered with `media.status: error` and
`media.error: inbox_media_missing`. One damaged folder does not disable downloads
for other messages. Existing media quotas still apply. Completion or discard
releases protection. Resolve pending work before disabling an inbox account;
disabled accounts are not drained or prepared but their retained messages remain
visible for explicit discard.

Only one Home Assistant consumer is supported. The integration reopens its
session automatically if an app restore supplies an older session. Competing HA
instances must not drain the same app. The inbox cannot recover messages the
app never received or events discarded before this feature was enabled.
