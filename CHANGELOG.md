# Changelog

All notable changes to this repository are documented here.

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
