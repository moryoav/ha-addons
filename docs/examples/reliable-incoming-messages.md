# Recover incoming messages after a restart

The WhatsApp app can keep an inbox while Home Assistant is unavailable. When
Home Assistant and the integration finish starting, the app delivers the queued
messages through the existing `new_whatsapp_message` event. **Existing
automations need no changes.** There are no additional actions or events.

Update both the app and integration to **3.1.0 or newer**, then add the account
IDs to **Persistent inbox accounts** in the app configuration:

```yaml
inbox_clients:
  - default
```

Leave the list empty to keep live delivery. Queued messages for an account
removed from this list stay stored until that account is enabled again.

The app delivers one message per ten-second attempt, preserving arrival order
within each account. Disconnected accounts wait without blocking connected
accounts. Original message IDs, timestamps, sender details, group metadata and
message bodies remain unchanged. With media downloading enabled, attachments
are downloaded when Home Assistant is ready, using the usual media settings.

The app removes a message after the integration accepts it and fires the event.
This confirms event delivery; automation conditions, execution modes and errors
keep their normal Home Assistant behavior. A crash between firing the event and
saving its receipt can cause a duplicate after a restart. HTTP retries within
the same integration instance are deduplicated for the latest 1,000 messages.

The private inbox is stored under `/data/inbox` and survives app restarts. Limits
are 1,000 pending messages, 32 MiB of state and 1 MiB per message. Accepted payloads
are erased; up to 1,000 compact duplicate receipts are kept for seven days.
Unreadable files are preserved. Storage or capacity failures are logged, and
new messages fall back to live delivery until storage is fixed and the app is
restarted. Live fallback cannot recover messages received while HA is offline.

Recovery covers messages received by the running app while the inbox is enabled.
It cannot recover messages the app never received. Very old media may no longer
be available from WhatsApp; such messages retain the usual media error metadata.
