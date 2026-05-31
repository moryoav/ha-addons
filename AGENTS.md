# Agent Instructions

This repository contains a Home Assistant add-on and a HACS-compatible custom integration.

## Change Discipline

- Keep changes focused on the user request.
- Do not overwrite user changes or generated artifacts that are unrelated to the task.
- Prefer existing repository patterns over broad rewrites.
- Use ASCII text unless a file already uses non-ASCII content for a clear reason.

## Changelog Maintenance

- Update `CHANGELOG.md` for every user-visible change, including integration behavior, add-on behavior, installation steps, actions, events, diagnostics, workflows, or documentation changes.
- Keep the newest release section at the top.
- Use concise bullets that describe the user impact.
- If an add-on runtime change is made, also update `whatsapp_addon/CHANGELOG.md`.
- If an add-on change should be released to Home Assistant users, bump `whatsapp_addon/config.yaml` and keep `whatsapp_addon/package.json` aligned.
- If the HACS integration version changes, update `custom_components/whatsapp/manifest.json`.
- If custom integration code changes, update or add tests under `tests/components/whatsapp`.

## Home Assistant and HACS Expectations

- Keep `custom_components/whatsapp` installable by HACS.
- Keep `hacs.json` at the repository root.
- Keep HACS and Hassfest workflows enabled and free of ignored HACS checks.
- Keep `custom_components/whatsapp/quality_scale.yaml` synchronized with actual implementation status.
- When changing setup, actions, diagnostics, or events, update `README.md` and `custom_components/whatsapp/translations/en.json` as needed.

## Privacy and Security

- Do not commit WhatsApp session files, QR codes, tokens, phone numbers, chat ids, message bodies, or private Home Assistant configuration.
- Redact sensitive data from logs, diagnostics, tests, and documentation examples.
- Follow `SECURITY.md` for vulnerability-related work.
