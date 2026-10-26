# Recover incoming messages after a restart

The WhatsApp app can keep an inbox while Home Assistant is unavailable. When
Home Assistant and the integration finish starting, the app delivers the queued
messages through the existing `new_whatsapp_message` event. **Existing
automations need no changes.** There are no additional actions or events.

Update both the app and integration to **3.1.1 or newer**, then add the account
IDs to **Persistent inbox accounts** in the app configuration:

```yaml
inbox_clients:
  - default
```

Leave the list empty to keep live delivery. Queued messages for an account
removed from this list stay stored until that account is enabled again.

New messages wake delivery immediately. Queued messages then arrive one by one
without an artificial delay. An unavailable receiver or storage retries after
ten seconds. Arrival order is preserved within each account. Text can arrive
while WhatsApp is disconnected; attachments wait for their account to reconnect
without blocking other accounts. Original message IDs, timestamps, sender
details, group metadata and message bodies remain unchanged.

With media downloading enabled, attachments use the existing downloader once
Home Assistant is ready. Successful downloads are cached in memory for retries;
expired or missing files are downloaded again. App restarts clear that cache.
The receiver requires administrator access, like Home Assistant's event API;
the app already uses the Supervisor's administrator credential.

The app removes a message after the integration accepts it and fires the event.
This confirms event delivery; automation conditions, execution modes and errors
keep their normal Home Assistant behavior. A crash between firing the event and
saving its receipt can cause a duplicate after a restart. HTTP retries within
the same integration instance are deduplicated for the latest 1,000 messages.

The private inbox is stored under `/data/inbox` and survives app restarts. Limits
are 1,000 pending messages, 32 MiB of state and 1 MiB per message. Accepted payloads
are erased; compact receipts suppress duplicates for the latest 1,000 deliveries
within seven days.
Temporary storage failures reload the saved state and retry automatically.
Damaged snapshots are archived privately before valid rows are restored; the
original bytes are retained. If a message still cannot be stored because of
capacity or storage failure, the app logs an error and attempts live delivery.
Live fallback cannot recover messages received while HA is offline.

Recovery covers messages received by the running app while the inbox is enabled.
It cannot recover messages the app never received. Very old media may no longer
be available from WhatsApp; such messages retain the usual media error metadata.
