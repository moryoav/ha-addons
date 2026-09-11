# Home Assistant Add-on: WhatsappV2

## How to use

## Configuration

The add-on options are:

- `clients`: one or more unique WhatsApp session names. The default is
  `default`. A name must match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`.
- `log_level`: `info` (the default) for normal operation, or `debug` for
  additional privacy-safe runtime diagnostics while investigating a problem.
- `decryption_diagnostics`: `false` by default. This internal debugging option
  records complete message metadata and decoded message structures, exact JIDs
  and message IDs, retry activity, and encrypted payload fingerprints. Keep it
  disabled during normal operation.
- `api_token`: an optional bearer token for the internal add-on API. Use a
  strong random value for defense in depth. Leave it unset to preserve
  compatibility with existing internal-network installations. The value may
  contain `A-Z`, `a-z`, `0-9`, `-`, `.`, `_`, `~`, `+`, and `/`, followed by
  optional `=` padding, and may be at most 512 characters total. Random hex or
  URL-safe Base64 is recommended. Spaces, `:`, and other characters cause a
  startup validation error.

Each session name becomes the `clientId` used by Home Assistant actions. Every client has its own persisted WhatsApp pairing state under the add-on data folder.

### **How to add other WhatsApp sessions**

Open the add-on configuration page and add another value under `clients`. Use
that value as the `clientId` in Home Assistant actions. Empty lists, duplicates,
invalid characters, and names longer than 64 characters are rejected before
any session directory is created.

## Stable and canary builds

Use the default repository URL for stable releases:

```text
https://github.com/moryoav/ha-addons
```

This repository does not currently publish a separate canary or `next` branch. If a canary channel is introduced later, it will be documented with its `#branch` repository URL and a distinct add-on name.

## Security and network access

The add-on exposes no Home Assistant LAN port. Home Assistant Ingress is enabled
for the add-on web UI, and the web UI listener only accepts the Supervisor
ingress proxy address. QR pairing is shown in the add-on web UI and through Home
Assistant persistent notifications.

The add-on includes a custom AppArmor profile. Its trusted base-image bootstrap
uses the standard Home Assistant startup permissions, then the network-facing
Node bridge runs in a restricted child profile where packaged files are
read-only and writes are limited to temporary and persistent session data. The
add-on runs without host networking, Docker API access, privileged capabilities,
`full_access`, host PID, or host UTS, and uses the default Supervisor API role.
A native container health check calls the local `/health` endpoint after
startup.

The add-on has no `/config` mount. It cannot install, overwrite, or remove a
custom integration. Version 1.4.31 retired the bundled legacy component; an
existing `/config/custom_components/whatsapp` directory is left untouched when
the add-on is updated or removed. Install the current integration through HACS.

When `api_token` is set, action API requests require
`Authorization: Bearer <token>`. The token is advertised to the integration
through the internal Supervisor discovery record. Keep the add-on and
integration at version 1.4.31 or newer, and never paste the token into logs or
issue reports.

Token-enabled installations require Supervisor discovery; manual or fallback
URL detection cannot provide the credential. After adding, changing, or
removing `api_token`, restart the add-on and reload the integration so discovery
refreshes or removes the stored token. Because `/health` is public, a stale or
wrong token is reported as an authorization error on the first protected action
rather than during setup.

The `/health` route remains unauthenticated so container monitoring can use it.
Its response is deliberately limited to a non-sensitive status, the service
identifier `ha-whatsapp-addon`, API version, supported capabilities, and
configured-client count. It contains no token, add-on URL, recipient id,
session data, or message content.

### Debug and health diagnostics

Set `log_level` to `debug` and restart the add-on when investigating an
intermittent failure. Debug mode periodically summarizes event-loop
responsiveness, process and container resource use, API activity, health state,
reconnects, and aggregate message and call handling. It does not enable raw
Baileys logs or include message content, raw account identifiers, QR codes,
session data, or API tokens. Identifier-related entries use run-scoped one-way
references for correlation. Return the option to `info` after collecting the
relevant logs.

The separate Decryption Diagnostics toggle is intended for investigating
message decryption failures. When enabled, it records raw message-stanza
attributes, exact message and participant identifiers, sender names,
timestamps, message stub data, retry counters, the complete decoded message
structure when available, and encrypted payload sizes and SHA-256
fingerprints. It remains enabled until the option is switched off and the
add-on is restarted. A failed encrypted message has no decoded body to record.

Failed native health checks are recorded in a small persistent history even at
the default `info` level. If Supervisor replaces an unhealthy container, the
next run replays the retained probe result and surrounding runtime state into
the add-on log. Include those replayed lines, with any surrounding private Home
Assistant data redacted, when reporting an unhealthy-container problem.

When that history ends with three consecutive failed probes, the next
successful run fires a silent `whatsapp_addon_health_failure` Home Assistant
event at either log level. In `debug` mode only, it also creates a persistent
notification with the same sanitized summary. The notification uses a fixed id
so later incidents update it instead of creating a stack of alerts. Normal
`info` operation never creates this health notification. Recovered and
shorter-lived probe failures do not trigger either report.

## Web UI

Open the add-on page and select Open Web UI. The Ingress UI shows each configured WhatsApp session, its connection state, and the current pairing QR code when a session is waiting for pairing.

### Encryption recovery

If the add-on detects a sustained burst of repeated libsignal decryption
failures, it pauses every WhatsApp client to protect the host from a
resource-consuming loop. The health endpoint and Ingress UI remain available,
and Home Assistant creates one persistent notification directing you to the
Web UI. The privacy-safe pause marker survives an add-on or host restart.

The recovery panel offers two choices:

- Retry connection clears the pause and reconnects once with all saved
  sessions unchanged. If the decryption storm returns, the clients pause again.
- Reset and re-pair deletes only the selected client's local pairing session.
  You must type its client ID to confirm. Remove the old add-on entry from
  WhatsApp Linked Devices, then scan the new QR code shown by the add-on.

Because the upstream error does not identify the responsible configured
client, detection pauses all clients. Normal action requests for a paused
client return the `client_recovery_paused` error until Retry or Reset and
re-pair is started. This recovery mode contains the failure but does not fix
the underlying upstream encryption problem.

## Action examples

I keep the examples in the [WhatsApp knowledge base](https://moryoav.github.io/ha-addons/).

- [Messages and media](https://moryoav.github.io/ha-addons/examples/messages/): text, stickers, documents, videos, polls, voice messages, locations, and reactions.
- [Recipients and number lookup](https://moryoav.github.io/ha-addons/examples/recipients/): identifiers and WhatsApp registration checks.
- [Presence](https://moryoav.github.io/ha-addons/examples/presence/): subscriptions, online notifications, and typing indicators.
- [Automations](https://moryoav.github.io/ha-addons/examples/automations/): calls, logging, replies, read markers, sensor alerts, and local webhooks.
- [Reusable scripts](https://moryoav.github.io/ha-addons/examples/scripts/): send responses, quoted follow-ups, and saved message keys.
- [Incoming messages and agents](https://moryoav.github.io/ha-addons/examples/incoming-messages/): chat filters, text extraction, and conversation replies.
- [AI-written notifications](https://moryoav.github.io/ha-addons/examples/ai-notifications/), [conversation history](https://moryoav.github.io/ha-addons/examples/conversation-history/), and [sensor charts](https://moryoav.github.io/ha-addons/examples/sensor-charts/): complete recipes adapted from the blog tutorials.

## Events

| Event type                      | Description                                             |
| ------------------------------- | ------------------------------------------------------- |
| new_whatsapp_message            | The message that was received                           |
| whatsapp_message_sent           | An outgoing message reported by the connected session   |
| whatsapp_call_update            | An incoming call lifecycle update                       |
| whatsapp_presence_update        | Presence of contact in a chat updated                   |
| whatsapp_send_message_result    | Result event fired after sending a message              |
| whatsapp_addon_health_failure   | Sanitized details after the prior run ended unhealthy   |

`new_whatsapp_message` and `whatsapp_message_sent` event data includes the
configured `clientId`, the detected message `type`, the Baileys `key`, and the
`message` payload. Other fields, such as `messageTimestamp`, are passed through
when present. The dedupe layer runs before either event is fired and tracks
each direction separately. Media dedupe ignores wrapper-only fields such as
thumbnails, CDN paths, scan sidecars, and media key timestamp representation
because WhatsApp can vary those between phone-number and LID deliveries of the
same message.

Starting with add-on 1.4.39, `whatsapp_message_sent` fires for messages with
`key.fromMe: true` reported by the connected session. This includes messages
sent from the phone, other linked devices, and the add-on itself. The
`key.remoteJid` is the destination chat or group and can be a LID. This event
does not confirm delivery or that the recipient has read the message.

The add-on sends this event directly to Home Assistant, so only the add-on
needs updating. Logging automations can listen to both message events; see the
[logging example](https://moryoav.github.io/ha-addons/examples/automations/#log-received-and-sent-messages).
Keep reply and mark-as-read automations on `new_whatsapp_message` so they do not
act on outgoing messages.

`whatsapp_call_update` fires for each lifecycle update reported by Baileys. Its
`status` is one of `offer`, `ringing`, `accept`, `reject`, `timeout`, or
`terminate`. The stable event data contains `clientId`, `callId`, `status`,
`from`, `chatId`, `isVideo`, `isGroup`, `groupJid`, `date`, and `offline`;
fields omitted by Baileys are represented as `null`. Caller and chat identifiers
may use `@lid` and are not guaranteed to contain a phone number. The add-on
preserves the observed update order and retries transient delivery failures for
a 33-second backoff window when Home Assistant Core is unavailable. Baileys
updates can still be missing or arrive after a reconnect, so automations should
filter the desired status without assuming a complete lifecycle.

`whatsapp_addon_health_failure` includes its schema and service, a run id,
first and last failure timestamps, failure count and streak, the bounded failure
classification, HTTP and curl result, probe timings, and any available bounded
process or container metrics. It contains no message contents, account
identifiers, URLs, headers, tokens, or raw response bodies.

Isolated libsignal `Bad MAC`, message-counter, and session lifecycle console
logs are filtered and summarized as counts instead of exposing full stack
traces or session data. A confirmed high-volume decryption failure burst
activates the recovery pause described above.

---

## Sample automations

I keep the [automation examples](https://moryoav.github.io/ha-addons/examples/automations/) in the knowledge base,
including incoming calls, message logging, replies, read markers, arrival messages,
and quoted replies. See also [reactions](https://moryoav.github.io/ha-addons/examples/messages/#react-to-an-incoming-message)
and [presence notifications](https://moryoav.github.io/ha-addons/examples/presence/#notify-when-a-contact-is-online).

## Privacy and compatibility

The add-on supports `aarch64` and `amd64`. Version 1.4.31 removes `armhf`,
`armv7`, and `i386`, which Home Assistant has not supported since 2025.12.

WhatsApp message and call events and Home Assistant automation traces can
contain phone JIDs, LIDs, call and message keys, quoted-message data, and
message bodies. The add-on does not log raw identifiers or message bodies, but
Home Assistant may retain event and action data. Redact these fields, QR codes,
session data, and `api_token` before sharing diagnostics, logs, screenshots, or
traces.

Use add-on and integration version 1.4.31 or newer together. The registration
lookup is unavailable on older add-ons; the integration reports a clear update
error instead of treating a missing endpoint as an unregistered number.

### Migrating from the bundled legacy component

The add-on no longer writes to `/config`. Existing legacy component files are
not deleted during update or uninstall.

1. Create a Home Assistant backup.
2. Install or update **WhatsApp** from the default HACS integration catalog.
3. Restart Home Assistant and verify the integration under
   **Settings > Devices & services**.
4. Remove an old `whatsapp:` YAML block, if present, and restart again.

After HACS takes ownership, do not manually delete
`/config/custom_components/whatsapp`. Manual-install users should replace the
whole directory with the current repository copy.

## Support and issues

For help, start with the root [README](../README.md), [SUPPORT](../SUPPORT.md), and [CHANGELOG](../CHANGELOG.md). If you find a bug, open an issue on GitHub and include the add-on version, Home Assistant version, add-on logs with secrets redacted, and the relevant automation or action payload.

## License

This add-on is published under the Apache License 2.0. See the repository [LICENSE](../LICENSE) file for the full license text.
