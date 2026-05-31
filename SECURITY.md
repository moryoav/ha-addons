# Security Policy

WhatsApp for Home Assistant connects a Home Assistant instance to a local add-on that can send WhatsApp messages and receive WhatsApp events. Please treat security and privacy issues with care.

## Supported Versions

Security fixes are intended for the latest published release and the current `main` branch.

Older releases are not actively supported unless a maintainer says otherwise in a specific issue or release note.

## Reporting a Vulnerability

Please do not open a public issue with exploit details, proof-of-concept code, private logs, tokens, QR codes, session files, phone numbers, chat ids, or personal Home Assistant configuration.

If GitHub private vulnerability reporting is available for this repository, use the **Report a vulnerability** button on the Security tab.

If private vulnerability reporting is not available, open a minimal public issue that says you have a security concern and asks the maintainer to arrange private disclosure. Do not include sensitive details in that issue.

## What to Include

When reporting a vulnerability privately, include as much of the following as you can safely share:

- A clear description of the issue.
- The affected version or commit.
- Whether the issue affects the add-on, the custom integration, or both.
- Steps to reproduce in a safe test environment.
- The expected impact.
- Relevant logs with secrets, QR codes, phone numbers, chat ids, and private configuration removed.
- Suggested mitigations, if you know them.

## Security-Sensitive Areas

Please use extra care when changing or reviewing:

- WhatsApp session storage under the add-on data directory.
- QR-code pairing and session reset behavior.
- Home Assistant Supervisor and Core API calls.
- The add-on HTTP API exposed on port `3000`.
- Service action validation and error handling.
- Event payloads sent into Home Assistant.
- Diagnostics output and logging.
- AppArmor, container permissions, networking, mounted paths, and add-on configuration.

## Responsible Testing

Test security reports and fixes only in an environment you own or have permission to use. Do not attempt to access, modify, or disclose another person's Home Assistant instance, WhatsApp account, configuration, credentials, logs, messages, contacts, or devices.

## Public Disclosure

Please give the maintainer reasonable time to investigate and fix confirmed vulnerabilities before publishing details publicly. Coordinated disclosure helps protect users while a fix is prepared.
