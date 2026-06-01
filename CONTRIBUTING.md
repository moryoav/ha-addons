# Contributing to WhatsApp for Home Assistant

Thanks for your interest in improving WhatsApp for Home Assistant.

This project has two main parts:

- `whatsapp_addon`: the Home Assistant add-on that runs the local WhatsApp Web bridge.
- `custom_components/whatsapp`: the Home Assistant custom integration that exposes setup flow support, actions, diagnostics, and translated errors.

Contributions are welcome, including bug reports, documentation improvements, compatibility fixes, security hardening, HACS improvements, tests, and feature ideas.

## Before You Start

Please open an issue before starting large or risky changes. This helps avoid duplicated work and gives maintainers a chance to discuss the approach first.

Small fixes, documentation updates, and clearly scoped bug fixes can usually go straight to a pull request.

## Reporting Bugs

When reporting a bug, please include:

- The version of WhatsApp for Home Assistant you are using.
- Your Home Assistant version.
- Whether you installed through HACS, manually, or from the add-on bundled compatibility component.
- Your architecture, such as `amd64` or `aarch64`.
- Clear steps to reproduce the issue.
- Relevant logs from Home Assistant or the add-on.
- What you expected to happen.
- What actually happened.

Please remove secrets, QR codes, phone numbers, chat ids, message bodies, tokens, personal paths, and private Home Assistant configuration before sharing logs or screenshots.

## Development Setup

Clone the repository:

```bash
git clone https://github.com/moryoav/ha-addons.git
cd ha-addons
```

The repository layout is:

```text
custom_components/whatsapp/   Home Assistant custom integration
whatsapp_addon/               Home Assistant add-on
.github/workflows/            GitHub Actions validation
```

For local Home Assistant testing, install or copy the integration into:

```text
/config/custom_components/whatsapp
```

For add-on testing, add this repository as a Home Assistant add-on repository and install `WhatsappV2`.

## Pull Request Guidelines

Please keep pull requests focused. A good pull request should:

- Explain what changed and why.
- Mention any related issue.
- Keep unrelated formatting or refactoring out of the change.
- Update documentation when behavior, installation, options, actions, events, diagnostics, or limitations change.
- Update `CHANGELOG.md` for user-facing changes.
- Update `whatsapp_addon/CHANGELOG.md` and bump `whatsapp_addon/config.yaml` for add-on changes.
- Include screenshots when changing Home Assistant notifications or add-on UI behavior.
- Avoid committing secrets, credentials, QR codes, WhatsApp session files, phone numbers, chat ids, message bodies, or private Home Assistant configuration.

## Testing

Before opening a pull request, test the parts you changed as much as practical.

For integration changes, verify that Home Assistant can:

- Load the `whatsapp` integration.
- Complete the config flow.
- Reconfigure the add-on URL.
- Call the relevant actions.
- Produce diagnostics without private message contents.
- Reload or restart without errors.

Run the Python tests when changing the custom integration:

```bash
python -m pip install -r requirements_test.txt
pytest --cov=custom_components.whatsapp --cov-report=term-missing
```

For add-on changes, verify that the add-on can:

- Start successfully.
- Return `GET /health`.
- Pair a client through QR code.
- Send a message.
- Fire `new_whatsapp_message` and `whatsapp_presence_update` events when relevant.
- Preserve HACS-managed `/config/custom_components/whatsapp` files.

For HACS readiness, the HACS and Hassfest GitHub Actions should pass without ignored checks before opening a HACS/default submission.

## Security Notes

This project can send WhatsApp messages and process WhatsApp event payloads. Please be especially careful with changes involving:

- WhatsApp session storage.
- QR-code pairing and logout behavior.
- Home Assistant Supervisor or Core API calls.
- The add-on HTTP API.
- Service action validation.
- Event payloads.
- Diagnostics and logging.
- AppArmor, container permissions, networking, or mounted paths.

If you believe you found a security vulnerability, please do not open a public issue with exploit details. Follow `SECURITY.md`.

## Code of Conduct

Please be respectful, constructive, and patient. This project is intended to help Home Assistant users automate their own systems, and contributions should support that goal.
