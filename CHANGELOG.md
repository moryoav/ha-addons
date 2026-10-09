# Changelog

All notable changes to this repository are documented here.

## Unreleased

### Documentation

- Updated the main and add-on READMEs to describe current features and setup
  without release history or version-specific upgrade instructions.

## 2.10.0

### Saved contact snapshots

- Added `whatsapp.get_contacts` to fetch saved contact names and identifiers
  for an explicitly selected connected account without waiting for messages.
- Returned original contact fields, including LIDs when supplied, through an
  authenticated, rate-limited API and Home Assistant action response.
- Verified contact snapshots and pending updates without resetting normal
  sync state or replaying events. Bounded requests and rejected incomplete data.
- Added action documentation, docstrings, and encrypted Baileys regression tests.

## 2.9.0

### Contact metadata events

- Added `whatsapp_contacts_sync` with available contact names, LIDs, and phone
  identifiers from WhatsApp history and contact updates, scoped by account.
- Forwarded contact batches and partial updates without extra lookups or a
  contact cache. Each request has a bounded HTTP timeout, and the event requires
  only the app update.
- Updated the HACS package version to 2.9.0 for the shared release.

## 2.8.0

### Decoded poll votes

- Added the voter's decoded choices to a WhatsApp poll vote. The vote's
  `new_whatsapp_message` event (`type: pollUpdateMessage`) includes a
  `poll_vote` object with `status`, `poll_id`, `poll_name`, and
  `selected_options`, the names of the options the voter has selected now. An
  empty list means the vote was withdrawn.
- Supported polls sent from Home Assistant, from the phone, and by other
  people, in direct chats and groups, once the add-on has received the poll on
  version 2.8.0 or newer.
- Stored the secret, question, and option names of the newest 100
  polls per account for 30 days alongside the session data, so votes are still
  decoded after a restart. Remembered polls are cleared when the session is
  reset or logged out, and the secret is never sent to Home Assistant.
- Kept events for votes on unavailable polls, with
  `poll_vote.status: error` and `poll_vote.error: unknown_poll`.
- Removed poll secrets from wrapped message events and send results while
  preserving local vote decoding and message retries.
- Reported wrapped votes as `pollUpdateMessage` for the same automation filters.
- Added a poll vote automation example and the `poll_vote` field reference.
- Updated the HACS integration version to 2.8.0. Poll-vote decoding only
  requires the add-on update.

## 2.7.0

### App and account status sensors

- Added one WhatsApp app device with an App connection binary sensor.
- Added a separate device for each configured WhatsApp account, with a
  WhatsApp connection binary sensor and a Session state sensor.
- Added automatic account discovery, stable device identities across restarts
  and re-pairing, and connection monitoring every 30 seconds.
- Added account states for connecting, connected, disconnected, logged out,
  pairing required, reconnecting, restarting, and paused for recovery.
- Account entities become unavailable when status cannot be read. App
  connection stays visible and shows disconnected when the app is unreachable.
- Added a protected local status API without pairing codes or message content.
- Updated integration setup text to use Home Assistant's app terminology.
- Update both the WhatsApp app and the HACS integration to 2.7.0 for account
  devices. Older apps still support App connection and existing actions.

## 2.5.0

### Receipts, profiles, and group lists

- Added the `whatsapp_message_status` event. It fires when a message this
  account sent is delivered, read, or played, with the message ID returned by
  `whatsapp.send_message`. In groups, each member's receipt is its own event.
- Added the `whatsapp_chat_read` event. It fires when you read or play received
  messages on another device, such as the phone, so automations can dismiss
  notifications you have already seen.
- Added the `whatsapp.get_profile` action: a contact's profile picture URL,
  about text, and business profile, or a group's picture.
- Added the `whatsapp.list_groups` action: every group the account belongs to,
  with its JID, name, description, and settings.
- Added an overview of every action and event to the README and knowledge base,
  and examples for unread-alert escalation, notification dismissal, profile
  lookups, and group lists.
- Update both the add-on and the HACS integration to 2.5.0 for the new
  actions. The new events need only the add-on.

## 2.4.0

### Call log event

- Added the `whatsapp_call_log` event. It fires once for each finished call,
  in either direction, with `direction`, `result`, `isVideo`,
  `durationSeconds`, `startedAt`, `peer`, `participants`, and `groupJid`.
- Outgoing calls made from the phone come from the call history the phone
  shares after the call, usually within about 15 seconds, and include
  WhatsApp's result (`connected`, `missed`, `rejected`, `cancelled`, ...) and
  the duration.
- Incoming calls are reported when they stop ringing, as `answered`,
  `declined`, or `missed`. Their duration is `null`: WhatsApp does not tell a
  linked device when an answered call ends.
- Added missed-call and outgoing-call automation examples.
- Documented that `terminate` right after `accept` means the call stopped
  ringing on the linked device, not that it ended, and that `ringing` can fire
  once per device.
- Debug runtime summaries count delivered and failed call log events.
- The HACS integration is unchanged; only its version number moves to
  2.4.0.

## 2.3.0

### Decline incoming calls

- Added the `whatsapp.reject_call` action. It declines an incoming WhatsApp call
  using the `callId` and `from` values of its `whatsapp_call_update` event.
  Both the add-on and the HACS integration must be updated to 2.3.0.
- Added an example automation that declines direct calls at night and replies
  to the caller that you are not available:

  ```yaml
  - alias: Decline WhatsApp calls at night
    trigger:
      - platform: event
        event_type: whatsapp_call_update
        event_data:
          status: offer
    condition:
      - condition: time
        after: "23:00:00"
        before: "07:00:00"
      - condition: template
        value_template: >-
          {{ not trigger.event.data.isGroup
             and trigger.event.data.callId is not none
             and trigger.event.data.from is not none }}
    action:
      - action: whatsapp.reject_call
        data:
          clientId: "{{ trigger.event.data.clientId }}"
          callId: "{{ trigger.event.data.callId }}"
          from: "{{ trigger.event.data.from }}"
      - action: whatsapp.send_message
        data:
          clientId: "{{ trigger.event.data.clientId }}"
          to: "{{ trigger.event.data.from | regex_replace(':[0-9]+@', '@') }}"
          body:
            text: >-
              I'm not available right now. I'll get back to you in the morning.
    mode: queued
  ```

  Swap the time condition for a sleep helper, such as
  `input_boolean.sleeping`, to decline calls only while you sleep.

### Call history diagnostics

- With `log_level: debug`, the add-on now logs WhatsApp app-state sync: the
  collection names in each `server_sync` notification, resync progress, the
  kind of each synced change, and a summary of any call-history entry shared by
  the phone. Identifiers appear only as one-way references.
- This shows how calls made from the phone reach the add-on, which WhatsApp
  does not report as call events. Nothing new is sent to Home Assistant yet.
- Debug runtime summaries now count app-state sync notifications and
  call-history entries.

## 2.2.2

- Added an automatically packaged `whatsapp.zip` to GitHub releases for HACS
  installs and updates.
- Kept the add-on image build in the release sequence and aligned the add-on,
  package, and integration versions with the release tag.
- Standardized HACS and Hassfest validation triggers and README badges and
  support buttons.
- Add-on and integration runtime behavior is unchanged.

## 2.2.1

- Added `chat_archived` to `whatsapp_message_sent` using the destination
  chat's cached archive state: `true`, `false`, or `null` when unknown.
  No extra network requests are made per message.
- The HACS integration is unchanged and needs no update.

## 2.2.0

- Added `chat_archived` to `new_whatsapp_message`: `true`, `false`, or `null`
  when the chat's archive state is unknown. Uses synchronized local state
  without extra network requests per message.
- Preserved known archive flags across add-on restarts, with separate caches
  per account and cleanup on chat deletion, logout, or session reset.
- Added archive-state documentation and an automation condition that skips
  archived and unknown chats.
- The HACS integration is unchanged and needs no update.

## 2.1.2

### Fix for replayed messages after a restart (issue #7)

- Fixed messages received while the add-on was offline not reaching Home
  Assistant. Baileys 6.7.23 held them until WhatsApp finished sending the whole
  backlog, and sometimes that never happened. The add-on now releases held
  events after about one second.
- This also lets `experimental_lid_sender_receipts` confirm those messages, so
  WhatsApp no longer sends them again after the next reconnect, where they
  failed and could pause the add-on.
- With `experimental_lid_sender_receipts` on, a message the add-on already
  decrypted is now answered directly if WhatsApp sends it again. It no longer
  fails, asks the phone to resend it, or counts toward the recovery pause.
- The add-on now logs how many offline messages WhatsApp announced and sent
  after each connection, and warns if WhatsApp does not finish within a minute.
- The HACS integration is unchanged and needs no update.

## 2.1.1

### Prebuilt add-on image

- The `WhatsappV2` add-on is now published as a prebuilt multi-arch container
  image at `ghcr.io/moryoav/whatsapp-addon`. Home Assistant pulls the image
  instead of building it on the host, so installs and updates are faster.
- Added the `Build add-on image` workflow, which builds and pushes the image
  for `amd64` and `aarch64` when a GitHub release is published.
- Add-on runtime behavior, options, actions, and events are unchanged. The
  HACS integration stays at 2.1.0 and needs no update.

## 2.1.0

### Group name lookup

- Added the `whatsapp.get_group_info` action. It takes a group `@g.us` JID,
  such as the `key.remoteJid` of a received group message, and returns the
  group name (`subject`), description, owner, creation time, size, admin-only
  settings, community links, and the participant list with admin roles.
- Added the add-on `groupMetadata` endpoint and the `get_group_info`
  capability. The integration reports an upgrade error when the add-on is
  older than 2.1.0. Group and number lookups share the per-client rate limit.
- Documented that `new_whatsapp_message` already carries the sender's
  `pushName`, with an automation example that combines it with the group name.
- Generalized the add-on-too-old and rate-limit action error messages, which
  previously mentioned only number checks.

**Update both the add-on and HACS integration to 2.1.0** to use the new action.
Existing actions, events, and payloads are unchanged.

## 2.0.0

### Decrypted incoming media for Home Assistant automations

Major feature release: incoming WhatsApp attachments can now become usable
local files directly in Home Assistant. Photos, voice notes, audio, videos,
documents, and stickers open up OCR, speech-to-text, document extraction,
image analysis, and other user-defined automation workflows.

- Added automatic incoming-media downloading and decryption using the existing
  WhatsApp session. Only complete decrypted files that match the message's
  SHA-256 checksum are published to automations.
- Enriched `new_whatsapp_message` with a `media` object containing the local
  file path, authenticated download link, MIME type, size, original filename
  when available, and expiry. The event arrives after its attachment is ready.
- Added a unique directory for every attachment, so simultaneous messages and
  repeated filenames cannot overwrite an earlier file.
- Added configurable temporary storage with a default 24-hour retention,
  64 MiB per-file limit, and 1 GiB attachment-content budget. Expiry survives
  restarts; cleanup runs automatically, including when downloading is disabled.
- Preserved unexpired files when storage fills. New downloads fail explicitly
  instead of removing files that automations may still need.
- Added authenticated Home Assistant downloads for documents and audiovisual
  files, with expiry enforced on every request. Files remain outside `www`
  and are never published through an anonymous download endpoint.
- Added bounded concurrent downloads, a queue and deadline, recovery requests
  for expired WhatsApp media, and cleanup of failed or interrupted downloads.
  Download failures still deliver the original message with a safe media error.
- Preserved existing message fields, actions, pairing, and outgoing events.
  Incoming media downloads are opt-in and do not block unrelated messages.
- Added setup guidance, the complete media event contract,
  processing examples, retention behavior, and troubleshooting documentation.
- Added regression coverage for real media decryption, integrity checks,
  concurrency, retention, authentication, stream failures, and container access.

**Upgrade both the add-on and HACS integration to 2.0.0, restart Home Assistant,
then enable Download incoming media in the add-on configuration.** Existing
automations remain compatible; downloading is disabled until enabled explicitly.

## 1.4.44

Add-on-only fix for the experimental option. The Home Assistant integration is
unchanged.

- Fixed `experimental_lid_sender_receipts` doing nothing on the first connection
  after a new pairing (#7). WhatsApp reports the account LID only at login, and
  the workaround read a copy of the account details taken before that, so it
  only started working after the first reconnect. It now reads the live
  credentials and is active from the first message. Installations that were not
  re-paired were unaffected.
- Added a regression test that reproduces a just-paired connection on the
  installed Baileys receive path.

## 1.4.43

Add-on-only experimental release. The Home Assistant integration is unchanged.

- Added the default-off `experimental_lid_sender_receipts` configuration switch
  for investigating own-device LID message replay and decryption storms (#7).
- When enabled, send supplemental sender receipts only after successful,
  unambiguous direct own-device LID decryption. Keep normal message delivery,
  authentication, the protective recovery pause and Baileys 6.7.23 unchanged.
- Cover every decrypted payload, including edits, deletions and other control
  messages, and the fresh copy a device sends after a retry request, so neither
  stays pending for replay.
- Bound per-socket tracking and receipt queues, contain write failures, and
  exclude groups, peer synchronization traffic and failed decryptions. Added
  regression tests, including one against the installed Baileys receive path,
  plus opt-in validation and rollback instructions.
- This is a fix candidate requiring live validation, not a confirmed cure.

## 1.4.42

Documentation release. Add-on runtime and integration behavior are unchanged.

- Clarified static sticker requirements: WebP format, exactly 512 x 512 pixels,
  a transparent background, and a file size under 100 KB.
- Removed blog references and historical guidance from the knowledge base to
  keep the documentation focused on current usage.
- Added examples for group ID discovery, message edits
  and deletion, send-result event handling, AI-written notifications with a
  fallback, conversation history, and sensor chart alerts.
- Expanded the knowledge base with sanitized examples from existing Home
  Assistant automations and scripts: stickers, documents, videos, polls, typing,
  quoted follow-ups, saved message keys, reusable scripts, agent replies, sensor
  alerts, and local webhooks. Documented custom-helper requirements and verified
  poll creation and a returned vote event with a live test.
- Added a searchable GitHub Pages knowledge base with the existing message,
  presence, recipient, and automation examples, plus action and event references.
- Replaced the README and add-on documentation example sections with links to
  the knowledge base, and added automatic MkDocs validation and publication.
- Added GitHub Sponsors alongside Ko-fi in the README's general support section.

## 1.4.41

- Fixed missing link previews on outgoing URL messages by including the required
  preview dependency. Previews still depend on the linked page and Baileys;
  missing or inaccessible preview images can prevent a preview from appearing.
  Only the add-on needs updating; the integration is unchanged.

## 1.4.40

- Added a bounded, in-memory cache so Baileys can retrieve original outgoing
  messages for requested retries, including messages synced from linked devices.
  Messages remain available across ordinary reconnects for up to four hours,
  subject to count and size limits. Stopping or resetting a client clears its cache.
- Expanded Decryption Diagnostics with incoming receipts, acknowledgements,
  outgoing receipt routing, and retry-cache hits and misses.
- Kept Baileys at 6.7.23 and retained the existing protective recovery pause.
  This improves retry handling but is not a confirmed fix for decryption storms.
  Only the add-on needs updating; the integration is unchanged.

## 1.4.39

- Added `whatsapp_message_sent` for outgoing messages reported by WhatsApp,
  including messages sent from the phone, other linked devices, and the add-on.
  It uses the existing message payload and dedupe checks. Only the add-on
  needs updating; the integration is unchanged.
- Documented the new event and added an automation example for logging both
  received and sent messages.

## 1.4.38

- Added an opt-in Decryption Diagnostics toggle for capturing exact WhatsApp
  message identifiers, sender and chat JIDs, timestamps, retry activity,
  decoded message structures, and raw encrypted-stanza fingerprints.
- Kept decryption diagnostics disabled by default and independent from the
  existing privacy-safe debug log level.

## 1.4.37

- Paused all WhatsApp clients after a confirmed burst of repeated libsignal
  decryption failures, while keeping the add-on healthy and its Ingress UI
  available so the container cannot enter a resource-consuming restart loop.
- Added Retry and confirmation-gated Reset and re-pair controls to the add-on
  Web UI. Retry keeps saved sessions; reset deletes only the selected client's
  local session and starts a new QR pairing flow.
- Persisted the privacy-safe recovery latch across restarts and added a Home
  Assistant notification directing the user to the recovery controls.

## 1.4.36

- Kept WhatsApp call updates in arrival order and retried transient Home
  Assistant Core delivery failures, preventing updates observed during a Core
  startup from being discarded immediately.
- Added privacy-safe call delivery logs with the lifecycle status, HTTP status,
  attempt number, and retry delay, without exposing caller or call identifiers.

## 1.4.35

- Added `whatsapp_call_update` events for incoming call lifecycle statuses:
  `offer`, `ringing`, `accept`, `reject`, `timeout`, and `terminate`.
- Added a stable, filterable call payload and privacy-safe aggregate call
  diagnostics without exposing raw caller or call identifiers in add-on logs.

## 1.4.34

- Added a privacy-safe `whatsapp_addon_health_failure` event after a previous
  add-on run ends with three consecutive failed native health checks, allowing
  explicit automations or webhooks to capture the retained diagnostic summary.
- Added a deduplicated Home Assistant persistent notification for the same
  failure summary when the add-on `log_level` is set to `debug`. Normal `info`
  operation does not create this notification.

## 1.4.33

- Added an add-on `log_level` option with privacy-safe periodic diagnostics in
  debug mode for runtime responsiveness, resource use, API activity, health,
  reconnects, and aggregate message handling.
- Moved high-volume message receipt and ignore details from info logs to
  bounded debug logs while retaining aggregate counters.
- Added persistent health-check failure records that are replayed into the
  add-on log after a restart, retaining the evidence needed to investigate an
  unhealthy container after Supervisor replaces it.
- Documented that direct-message automations should prefer LID targets and how
  to obtain them with `whatsapp.check_number`.

## 1.4.32

- Fixed add-on startup under AppArmor by giving the trusted Home Assistant
  base-image bootstrap its standard file access, then transitioning the
  network-facing Node bridge into a restricted read-only child profile with
  writes limited to temporary and persistent session data.
- Added static and real-entrypoint container smoke tests for the required
  startup permissions.

## 1.4.31

- Added `whatsapp.check_number`, a response-only action that checks a phone
  number's WhatsApp registration and returns its normalized JID and available
  LID without pretending to validate groups or arbitrary LIDs.
- Added optional bearer-token protection for the internal add-on API, carried
  to the integration through Supervisor discovery, and removed permissive CORS
  headers from the non-browser bridge API.
- Added strict client-name and phone-target validation, stable structured API
  errors, lookup rate limiting, privacy-safe logging, and a minimal versioned
  health/capability contract.
- Retired the bundled legacy custom-component installer and removed the
  add-on's read-write `/config` mount and cleanup behavior. Existing legacy
  files are left untouched for safe migration to HACS.
- Replaced broad AppArmor file access with explicit read-only runtime rules and
  writable add-on data/runtime paths.
- Made the runtime dependency install reproducible and ensured the packaged
  Baileys 6.7.23 tree cannot be mixed with the older vendored source tree.
- Moved add-on builds to the pinned base image directly so current Supervisor
  releases no longer need the retired `BUILD_FROM` input, and removed the
  `armhf`, `armv7`, and `i386` platforms unsupported by Home Assistant since
  2025.12.
- Replaced obsolete Supervisor watchdog and duplicate web-UI metadata with a
  native container health check and Ingress-native UI configuration.
- Updated CI to test the declared minimum and current stable Home Assistant
  releases, run add-on Node tests, lint add-on assets, and build the add-on
  image on every push and pull request.
- Expanded installation, migration, compatibility, response-semantics,
  security, and privacy documentation with clearly synthetic identifiers.

## 1.4.30

- Simplified the HACS installation instructions now that WhatsApp is available in the default HACS catalog.

## 1.4.29

- Fixed inbound deduplication for quoted WhatsApp replies during LID migration.
- Corrected the HACS integration version metadata to match the repository release tag.
- Fixed the scheduled lock workflow for GitHub's longer workflow tokens.

## 1.4.28

- Expanded the add-on installation guide with numbered add-on, HACS, manual integration, and setup-flow steps.
- Added a Home Assistant HACS repository button to the add-on README.
- Replaced add-on README relative documentation links with GitHub links that work from the Home Assistant add-on page.

## 1.4.27

- Fixed the add-on Ingress web UI when Home Assistant opens it through the `/app/<slug>` route and forwards the root path as `//`.
- Used the Home Assistant `X-Ingress-Path` header for web UI asset and status API links.
- Removed an internal release-process note from the add-on README.

## 1.4.26

- Added a Home Assistant Ingress web UI for the WhatsApp add-on with session status and QR pairing display.
- Kept the existing integration API on the internal add-on port while serving the web UI on an ingress-only listener.
- Documented the new Ingress entry point and QR pairing options.

## 1.4.25

- Removed the unsupported custom `services` metadata entry so Home Assistant Supervisor accepts the add-on repository again while keeping the required `discovery` declaration.

## 1.4.24

- Declared the WhatsApp Supervisor discovery service in add-on metadata so `/discovery` registration is allowed and no longer logs a 403 warning.
- Registered HTTP routes before starting the add-on server and publishing Supervisor discovery.

## 1.4.23

- Added a custom AppArmor profile, Supervisor watchdog metadata, stable stage metadata, and current Home Assistant app map syntax for the add-on.
- Rebuilt app and integration icon assets as square PNG files to meet Home Assistant presentation requirements.
- Documented stable/no-canary availability, no-Ingress behavior, support paths, license, and add-on security posture in the add-on docs.
- Clarified the add-on configuration translation for WhatsApp session names.

## 1.4.22

- Added a HACS-compatible `custom_components/whatsapp` integration with config flow setup, reconfiguration, diagnostics, translated service errors, and service schemas.
- Added Home Assistant test scaffolding for config flow, setup, service error, and diagnostics behavior.
- Added `hacs.json`, HACS validation, and Hassfest validation workflows for HACS publishing readiness.
- Added local brand assets for the HACS integration.
- Added Home Assistant quality scale tracking for the WhatsApp integration.
- Added root project documentation for installation, actions, events, diagnostics, troubleshooting, limitations, and removal.
- Added `SECURITY.md`, `SUPPORT.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `AGENTS.md`.
- Added an add-on `/health` endpoint so setup and diagnostics can verify add-on availability.
- Added Supervisor discovery registration from the add-on and automatic add-on detection in the integration, removing the need to enter a URL.
- Added Home Assistant My links for the add-on repository, add-on page, HACS repository, and integration setup flow.
- Documented the add-on security posture against the Home Assistant app presentation guidance.
- Changed the add-on startup behavior so it does not overwrite an existing HACS-managed `/config/custom_components/whatsapp` integration.
- Improved the add-on store description and explicitly enabled AppArmor in add-on metadata.
- Moved the bundled legacy add-on component manifest to a runtime template so Hassfest validates only the HACS integration.
- Aligned the add-on package license metadata with the repository Apache-2.0 license.
- Removed the donation badge from the root and add-on README files.

## Earlier releases

Earlier add-on-specific release notes are maintained in `whatsapp_addon/CHANGELOG.md`.
