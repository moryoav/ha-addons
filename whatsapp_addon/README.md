<img src="https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/logo.png?raw=true" alt="WhatsApp" width="400"/>

![Supports aarch64 Architecture][aarch64-shield]
![Supports amd64 Architecture][amd64-shield]

# Home Assistant Add-on: WhatsApp

Send WhatsApp messages, talk to your Home Assistant over a WhatsApp call, and
let automations call you when something needs attention.

This add-on runs the local WhatsApp Web bridge. Install the companion
**WhatsApp** integration through HACS to use account devices, status sensors,
actions, and diagnostics in Home Assistant.

## What it can do

- Make and receive AI voice calls with GPT-Live and your Home Assistant OpenAI
  conversation agent, using the same linked WhatsApp device as messaging.
- Send text, images, videos, documents, stickers, voice messages, locations,
  contacts, polls, reactions, edits, deletions, and quoted replies.
- Receive incoming and outgoing messages, delivery and read receipts, calls,
  presence changes, contact updates, and decoded poll votes.
- Download and decrypt received attachments for Home Assistant automations.
- Retain incoming messages across Home Assistant restarts with the opt-in
  [persistent inbox](https://moryoav.github.io/ha-addons/examples/reliable-incoming-messages/).
  Existing `new_whatsapp_message` automations work without changes.
- Look up saved contacts, phone numbers, profiles, and groups.
- Monitor the app and each account with connection and session sensors.
- Pair and manage multiple WhatsApp accounts through the web UI.

## Important limitation

This project uses WhatsApp Web through an unofficial client library. WhatsApp
may restrict or block accounts that use unofficial clients. Use a dedicated
account if that risk matters to you.

## Installation

### 1. Add the add-on repository

[![Add the WhatsApp add-on repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fmoryoav%2Fha-addons)

Use the button above to add this repository to Home Assistant's Apps store.

If you prefer to do it manually:

1. Go to **Settings** -> **Apps**.
2. Select **Install app**.
3. Open the menu in the top right.
4. Choose **Repositories**.
5. Add this repository URL:

```text
https://github.com/moryoav/ha-addons
```

### 2. Install and start the add-on

[![Open the WhatsApp add-on page](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=ea396823_whatsapp_addon&repository_url=https%3A%2F%2Fgithub.com%2Fmoryoav%2Fha-addons)

Use the button above after adding the repository. It opens the `WhatsApp` add-on page.

1. Install `WhatsApp`.
2. Review the add-on options.
3. Start the add-on.

Home Assistant should show a persistent notification with a QR code and an
**Open pairing page** link. Open the link or select **Open Web UI** on the
add-on page.

Choose an account in **Connection**, then scan its QR code with WhatsApp or
select **Link with code** to pair using the account's phone number.

### 3. Install the integration

The add-on runs the local WhatsApp bridge. The `whatsapp` custom integration exposes the Home Assistant actions, events, diagnostics, and setup flow that use that bridge. Install the integration with HACS or manually.

#### HACS

[![Open the WhatsApp HACS repository](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=moryoav&repository=ha-addons&category=integration)

WhatsApp is available in the default HACS catalog, so no custom repository setup is required.

1. Select the button above, or open HACS and search for **WhatsApp** under **Integrations**.
2. Select **WhatsApp** and choose **Download**.
3. Restart Home Assistant.

#### Manual

Copy:

```text
custom_components/whatsapp
```

to:

```text
/config/custom_components/whatsapp
```

Then restart Home Assistant.

### 4. Add the integration

[![Add the WhatsApp integration](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=whatsapp)

Use the button above after Home Assistant restarts. It opens the **WhatsApp** integration setup flow.

In Home Assistant:

1. Go to **Settings** -> **Devices & services**.
2. Add integration **WhatsApp**.

The add-on advertises its local API through Supervisor discovery, so the integration does not ask for a URL. If setup cannot detect the add-on yet, confirm `WhatsApp` is running, then restart the add-on and submit the setup flow again.

## Add-on options

See the [complete option reference](https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/DOCS.md#configuration)
for voice calls, media downloads, retention, and logging options.

- `clients`: one or more unique WhatsApp session names. The default is
  `default`. Names must start with a letter or digit, may contain letters,
  digits, `_`, and `-`, and may be at most 64 characters long.
- `log_level`: `info` (the default) for normal operation, or `debug` for
  additional privacy-safe runtime diagnostics while investigating a problem.

The app creates its internal API credential automatically on first startup,
saves it privately, and keeps it across restarts. Supervisor discovery shares
it with the integration, which applies credential changes automatically.
There is no token to enter or manage in the app configuration.

Each client gets its own persisted session and must be referenced by `clientId` in service calls.

Supplemental delivery receipts for decrypted own-device LID messages are always
enabled for every account. They do not mark chats as read. Detailed decryption
tracing is disabled; neither behavior has a configuration switch.

## Voice calls

Choose one of your existing account IDs as **Calling account**, enter your
OpenAI conversation entity ID, and set **Allowed incoming callers**. The app
uses that agent's existing API key and Assist permissions. Other accounts keep
their normal messaging behavior, and there is no second WhatsApp pairing.

You can call your home, ask about exposed entities, control devices, and run
scripts through the selected agent. Use `whatsapp.make_call` in an automation
to have your home call you, with an optional opening message after pickup.
`whatsapp.hang_up` ends the active AI call.

Choose a voice and greeting, adjust call limits and audio settings, or enable
recordings with 30-day retention by default. Recording is off until enabled.
Leave the calling account and agent empty to continue using messaging only.

See the [voice call guide](https://moryoav.github.io/ha-addons/examples/voice-calls/)
for setup, automation examples, recording, and upgrading from 2.x.

## Web UI and pairing

Select **Open Web UI** on the add-on page to open the shared account workspace
through Home Assistant Ingress. Account connection states stay visible beside
the **Connection**, **Calls**, and **Recordings** views on desktop and phone.

Choose an account and open **Connection** to see its current QR code while
pairing. Codes update as WhatsApp provides them. To pair without scanning,
select **Link with code**, enter that WhatsApp account's phone number with its
country code, and request a code. Enter the displayed code in WhatsApp under
**Linked devices > Link a device > Link with phone number instead**.
Select **Scan QR code** to return to QR pairing. Existing linked accounts keep
their saved sessions.

The selected calling account has controls for calling a phone number or
WhatsApp user ID, an optional opening message, and **Hang up**. Active-call
controls stay visible as you change views, select another account, or scroll.
The recording library supports date search, playback, downloads, and expiry
details. It also contains older saved recordings if the calling account has
changed; those files do not identify which account or contact was involved.
Messages continue through Home Assistant actions and automations.

If a sustained burst of libsignal decryption failures is detected, all WhatsApp
clients are paused to protect the host while the add-on and Web UI remain
available. Use **Retry connection** to keep the saved sessions, or **Reset and
re-pair** for one client to delete its local session and display a new QR code.
Reset requires typing that client's exact ID. Remove the old add-on entry from
WhatsApp Linked Devices before scanning the new code.

## App and account status sensors

The integration creates one shared WhatsApp app device and a separate device
for every configured account. The app device has an **App connection**
binary sensor; each account has a **WhatsApp connection** binary sensor and a
**Session state** sensor. The integration reads existing local connection state
every 30 seconds without extra WhatsApp requests. See
[Devices and sensors](https://moryoav.github.io/ha-addons/reference/entities/).

## Decrypted incoming media

Automatically download and decrypt incoming images, voice notes, audio, videos,
documents, and stickers. Each attachment gets a unique temporary file and an
authenticated link in `new_whatsapp_message`, ready for OCR, transcription, or
other processing in Home Assistant.

Enable **Download incoming media** in the add-on configuration. Downloads are
off by default. Files are kept for 24 hours by default, with configurable
retention and storage limits.
See the [incoming media guide](https://moryoav.github.io/ha-addons/examples/incoming-media/).

## Actions and events

`whatsapp_message_sent` reports outgoing messages, including messages sent from
the linked phone. The add-on sends this event directly to Home Assistant. See the
[event details and logging example](https://github.com/moryoav/ha-addons#events).

`whatsapp_contacts_sync` forwards the contact records WhatsApp supplies, with
available names, LIDs, and phone identifiers. Each batch includes its account ID
and original Baileys event source. See the
[contact event reference](https://moryoav.github.io/ha-addons/reference/events/#contact-metadata).

`whatsapp.get_contacts` fetches a fresh saved-contact snapshot for the selected
connected account. It returns the original contact fields, including saved
names and LIDs when supplied, without waiting for messages. See the
[saved contact action](https://moryoav.github.io/ha-addons/examples/recipients/#get-saved-contacts).

## Security notes

The bridge API runs on Home Assistant's internal app network and uses a
privately generated credential. Supervisor discovery provides the address and
credential to the integration automatically. It is preserved across restarts.

The web UI uses Home Assistant Ingress. AppArmor restricts the Node bridge's
writes to temporary files, persistent session data, and attachments under
`/media/whatsapp`. Container health checks use the local `/health` endpoint.

Redact API tokens, pairing QR codes, session data, phone JIDs, LIDs, and message
content before sharing logs, diagnostics, screenshots, or automation traces.

## Diagnostics

Debug logging periodically summarizes event-loop responsiveness, process and
container resource use, API activity, health state, reconnects, and aggregate
message and call handling. It does not enable raw Baileys logs or include
message content, raw account identifiers, QR codes, session data, or API
tokens. Identifier-related entries use run-scoped one-way references for
correlation. Return the option to `info` after collecting the relevant logs.

Detailed decryption tracing remains disabled in debug mode.

Failed native health checks are recorded in a small persistent history at both
log levels. If Supervisor replaces an unhealthy container, the new add-on run
replays the retained failure details into its log so the original probe result
and surrounding runtime state are not lost. If the saved history ends with
three consecutive failed probes, that run also fires a silent,
privacy-safe `whatsapp_addon_health_failure` Home Assistant event. In `debug`
mode only, it creates a deduplicated persistent notification containing the
same diagnostic summary. Normal `info` operation never creates this health
notification.

## Documentation

See [the repository README](https://github.com/moryoav/ha-addons/blob/main/README.md) for HACS integration setup, actions, events, troubleshooting, and removal instructions.

Find action and automation examples in the
[WhatsApp knowledge base](https://moryoav.github.io/ha-addons/).

See [the add-on documentation](https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/DOCS.md) for add-on options and the web UI, and [the add-on changelog](https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/CHANGELOG.md) for release notes.

[aarch64-shield]: https://img.shields.io/badge/aarch64-yes-green.svg
[amd64-shield]: https://img.shields.io/badge/amd64-yes-green.svg
