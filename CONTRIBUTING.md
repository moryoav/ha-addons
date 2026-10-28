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
- Whether you installed the integration through HACS or manually.
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

For add-on testing, add this repository as a Home Assistant add-on repository and install `WhatsApp`.

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

```powershell
pytest
```

Run the add-on tests when changing its JavaScript runtime or HTTP API:

```bash
cd whatsapp_addon
npm ci
npm test
```

For add-on changes, verify that the add-on can:

- Start successfully.
- Return `GET /health`.
- Pair a client through QR code.
- Send a message.
- Fire `new_whatsapp_message`, `whatsapp_call_update`, and
  `whatsapp_presence_update` events when relevant.
- Authenticate API calls with the managed credential supplied through discovery.
- Keep voice tests offline and synthetic; never commit recordings or session data.
- Leave Home Assistant's `/config` directory untouched.

For HACS readiness, the HACS and Hassfest GitHub Actions should pass without ignored checks before opening a HACS/default submission.

### Release build cache

I keep the full app caches in the `amd64` and `aarch64` scopes. After building
the app, CI explicitly exports the Dockerfile's native `builder` target to
`amd64-rust` and `aarch64-rust` with `mode=max`. This uses the same Buildx
builder and exports cache only, without publishing another image. CI also
imports the older `voice-*` scopes during the transition.

The release builder's `cache-gha-scope: rust` selects those architecture-prefixed
Rust caches. Its signed registry-image cache remains available as a fallback.
After publishing each architecture, I also export the native target on the same
builder to keep the tag's cache rooted at Rust for release reruns.
I keep the Rust export separate because a cached Rust stage in CI did not give
the release usable Rust records through the full app's cache export. Matching
scope names alone did not fix that handoff. Exporting the native target directly
avoids relying on its transitive export through the app's different base image.

Before publishing a release tag, I wait for both add-on image jobs on `main`
to finish successfully. Release tags can reuse those default-branch caches;
caches written only by a pull request or feature branch do not warm `main`.

For the next feature release, I check that unchanged Rust steps report `CACHED`
and compare architecture build-and-push times with
[v3.3.0](https://github.com/moryoav/ha-addons/actions/runs/40643306333)
(29 minutes 15 seconds overall, with about 25 minutes of Rust work per
architecture). I do not claim a speedup until that release measures it. A native
source, toolchain, lockfile, or patch change can still require compilation.

## Documentation

I keep the knowledge base source in `docs/` and its navigation in `mkdocs.yml`.
To preview documentation changes locally:

```bash
python -m pip install -r requirements_docs.txt
python -m mkdocs serve
```

Check the site before submitting changes:

```bash
python -m mkdocs build --strict
```

The Documentation workflow checks pull requests and publishes documentation
changes from `main` to [GitHub Pages](https://moryoav.github.io/ha-addons/).
The generated `site/` directory is ignored by Git. Edit the Markdown source
in `docs/` to update examples, and keep the README and add-on documentation links
pointing to the relevant knowledge base pages.

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
