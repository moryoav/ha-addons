# Changelog

All notable changes to this repository are documented here.

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
