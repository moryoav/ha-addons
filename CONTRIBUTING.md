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
I introduced the separate Rust export while investigating the release cache
miss. The v3.3.1 measurement showed that it did not solve reuse: both release
architectures compiled Rust again despite reading populated cache indexes.
I do not treat an index being present or a local cache hit as proof of reuse
on another runner.

Before publishing a release tag, I wait for both add-on image jobs on `main`
to finish successfully. Release tags can reuse those default-branch caches;
caches written only by a pull request or feature branch do not warm `main`.

I measure cache changes with isolated build benchmarks before publishing a
release. The [v3.3.1 baseline](https://github.com/moryoav/ha-addons/actions/runs/40651500767)
took 31 minutes 30 seconds overall; the architecture build-and-push steps took
24 minutes 37 seconds on amd64 and 29 minutes 39 seconds on aarch64. A native
source, toolchain, lockfile, or patch change can still require compilation.

### Build benchmarks

I use the manually triggered **Build benchmark** workflow to investigate build
changes without bumping versions, creating release tags, or publishing a GitHub
release. I select an immutable source commit and the native runner architecture.

The initial dependency probes compare CI and release options on separate fresh
runners. They stop before Rust compilation, import existing caches read-only,
and export no cache entries or container images. I capture the actual BuildKit
cache-key inputs through a debug endpoint bound to the builder container's
loopback interface. The workflow retains those diagnostics and Docker build
records for seven days.

I follow a successful probe with complete image tests and repeated consumers
on fresh runners before claiming that a change fixes release performance.
Any image-publishing experiment must use the separate `whatsapp-addon-bench`
repositories and run-specific tags. I never use the existing manual
**Build add-on image** workflow for benchmarks: it writes the configured version
tag even when `publish_latest` is false.

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
