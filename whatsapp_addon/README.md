# Home Assistant Add-on: WhatsappV2

Write WhatsApp messages from Home Assistant and receive WhatsApp message, call,
and presence events.

<img src="https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/logo.png?raw=true" width="400"/>

![Supports aarch64 Architecture][aarch64-shield]
![Supports amd64 Architecture][amd64-shield]

[aarch64-shield]: https://img.shields.io/badge/aarch64-yes-green.svg
[amd64-shield]: https://img.shields.io/badge/amd64-yes-green.svg

Supported architectures are `aarch64` and `amd64`. Release 1.4.31 removes
`armhf`, `armv7`, and `i386`, which Home Assistant has not supported since
2025.12.

This add-on runs the local WhatsApp Web bridge used by the `whatsapp` Home Assistant integration in this repository.

## Important limitation

This project uses WhatsApp Web through an unofficial client library. WhatsApp does not officially support bots or unofficial clients, so account restrictions or blocking are possible. Use a dedicated account if that risk matters to you.

## Security notes

- No HTTP port is published to the LAN.
- The local bridge API is used from the Home Assistant add-on network and can
  optionally require a bearer token.
- The bridge API does not enable cross-origin browser access.
- A custom AppArmor profile gives the trusted base-image bootstrap its standard
  startup permissions, then runs the network-facing Node bridge in a restricted
  child profile where packaged code and dependencies are read-only and writes
  are limited to temporary and persistent session data.
- No Docker API access, host network, host PID, host UTS, `full_access`, privileged capabilities, or elevated Supervisor role are used.
- The add-on has no `/config` mount and cannot install, overwrite, or remove
  custom integrations.
- A native container health check uses the public local `/health` endpoint,
  whose response contains only non-sensitive status, version, capability, and
  client count metadata.
- Home Assistant Ingress is enabled for the add-on web UI.
- The web UI listener only accepts the Supervisor ingress proxy address, and no HTTP port is published to the LAN.
- QR pairing is shown in the add-on web UI and through Home Assistant persistent notifications.

## Stable and canary builds

Use the default repository URL for stable releases:

```text
https://github.com/moryoav/ha-addons
```

This repository does not currently publish a separate canary or `next` branch. If a canary channel is introduced later, it will be documented with its `#branch` repository URL and a distinct add-on name.

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

[![Open the WhatsappV2 add-on page](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=ea396823_whatsapp_addon&repository_url=https%3A%2F%2Fgithub.com%2Fmoryoav%2Fha-addons)

Use the button above after adding the repository. It opens the `WhatsappV2` add-on page.

1. Install `WhatsappV2`.
2. Review the add-on options.
3. Start the add-on.

In a few seconds, Home Assistant should show a persistent notification with a QR code. You can also open the add-on web UI from the add-on page to view session status and the current pairing QR code. Scan the QR code with the WhatsApp mobile app.

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

Add-on releases before 1.4.31 could install a bundled legacy component. The
current add-on leaves that existing directory untouched. Install the current
integration through HACS so it is updated independently from the add-on.

### 4. Add the integration

[![Add the WhatsApp integration](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=whatsapp)

Use the button above after Home Assistant restarts. It opens the **WhatsApp** integration setup flow.

In Home Assistant:

1. Go to **Settings** -> **Devices & services**.
2. Add integration **WhatsApp**.

The add-on advertises its local API through Supervisor discovery, so the integration does not ask for a URL. If setup cannot detect the add-on yet, confirm `WhatsappV2` is running, then restart the add-on and submit the setup flow again.

## Add-on options

- `clients`: one or more unique WhatsApp session names. The default is
  `default`. Names must start with a letter or digit, may contain letters,
  digits, `_`, and `-`, and may be at most 64 characters long.
- `log_level`: `info` (the default) for normal operation, or `debug` for
  additional privacy-safe runtime diagnostics while investigating a problem.
- `decryption_diagnostics`: `false` by default. This internal debugging option
  records complete message metadata and decoded message structures, exact JIDs
  and message IDs, retry activity, and encrypted payload fingerprints. Keep it
  disabled during normal operation.
- `api_token`: optional bearer token for the internal API. Set it to a strong
  random value for defense in depth, or leave it unset for compatibility with
  existing internal-network installations. It may contain `A-Z`, `a-z`, `0-9`,
  `-`, `.`, `_`, `~`, `+`, and `/`, followed by optional `=` padding, and may be
  at most 512 characters total. Random hex or URL-safe Base64 is recommended;
  spaces, `:`, and other characters make startup fail validation.

Token-enabled installations require Supervisor discovery; manual or fallback
URL detection cannot provide the token. Restart the add-on and reload the
integration after adding, changing, or removing `api_token`.

Debug logging periodically summarizes event-loop responsiveness, process and
container resource use, API activity, health state, reconnects, and aggregate
message and call handling. It does not enable raw Baileys logs or include
message content, raw account identifiers, QR codes, session data, or API
tokens. Identifier-related entries use run-scoped one-way references for
correlation. Return the option to `info` after collecting the relevant logs.

The separate Decryption Diagnostics toggle is intended for investigating
message decryption failures. When enabled, it records raw message-stanza
attributes, exact message and participant identifiers, sender names,
timestamps, message stub data, retry counters, the complete decoded message
structure when available, and encrypted payload sizes and SHA-256
fingerprints. It remains enabled until the option is switched off and the
add-on is restarted. A failed encrypted message has no decoded body to record.

Failed native health checks are recorded in a small persistent history at both
log levels. If Supervisor replaces an unhealthy container, the new add-on run
replays the retained failure details into its log so the original probe result
and surrounding runtime state are not lost. If the saved history ends with
three consecutive failed probes, that run also fires a silent,
privacy-safe `whatsapp_addon_health_failure` Home Assistant event. In `debug`
mode only, it creates a deduplicated persistent notification containing the
same diagnostic summary. Normal `info` operation never creates this health
notification.

Each client gets its own persisted session and must be referenced by `clientId` in service calls.

The add-on page includes an Open Web UI action through Home Assistant Ingress.
The web UI shows each configured session, its connection state, and the current
QR code when a session is waiting for pairing. If a sustained burst of
libsignal decryption failures is detected, all WhatsApp clients are paused to
protect the host while the add-on and Web UI remain available. Use Retry
connection to keep the saved sessions, or use the confirmation-gated Reset and
re-pair control for one client to delete its local session and display a new QR
code. Remove the old add-on entry from WhatsApp Linked Devices before scanning
the new code.

## Integration compatibility

The add-on and integration are separate installations. Version 1.4.31 retired
the bundled component installer and all read-write `/config` access. Updating or
uninstalling the add-on does not change an existing
`/config/custom_components/whatsapp` directory.

Install or update the WhatsApp integration from the default HACS catalog, then
restart Home Assistant. Keep both parts at version 1.4.31 or newer to use the
number-registration check and optional API authentication. A mismatched older
add-on can produce an endpoint/version error for `whatsapp.check_number`.

The add-on registers a Supervisor discovery message on startup so Home
Assistant can create or update the integration connection. When `api_token` is
set, the token is conveyed through that internal discovery record rather than
entered in the setup flow. A stale token appears as an authorization error on
the first protected action because the health-check `/health` route remains
public.

API tokens, pairing QR codes, session data, phone JIDs, and LIDs are sensitive.
Redact them from logs, issue reports, screenshots, and automation traces.

## Documentation

See [the repository README](https://github.com/moryoav/ha-addons/blob/main/README.md) for HACS integration setup, actions, events, examples, troubleshooting, and removal instructions.

See [the add-on documentation](https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/DOCS.md) for additional action examples and [the add-on changelog](https://github.com/moryoav/ha-addons/blob/main/whatsapp_addon/CHANGELOG.md) for release notes.
