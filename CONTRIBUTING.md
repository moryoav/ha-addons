# Contributing to WhatsApp for Home Assistant

Bug reports, documentation improvements, tests, fixes, and feature ideas are
welcome. This guide covers how to prepare, test, and submit a contribution.

## Before you start

Open an issue before starting large or risky changes, especially those involving
pairing, authentication, session storage, or permissions. This gives maintainers
a chance to discuss the approach and helps avoid duplicated work. Small fixes
and documentation updates can go straight to a pull request.

For vulnerabilities and security-sensitive changes, follow
[SECURITY.md](SECURITY.md). Keep exploit details out of public issues.

## Reporting bugs

Include enough information to reproduce the problem:

- The add-on, integration, and Home Assistant versions.
- The Home Assistant installation type and architecture, such as `amd64` or
  `aarch64`.
- Whether the integration was installed through HACS or manually.
- Steps to reproduce, the expected result, and what actually happened.
- Relevant Home Assistant or add-on logs.

Remove credentials, QR codes, phone numbers, chat IDs, message bodies, personal
paths, and private Home Assistant configuration from logs and screenshots
before sharing them.

## Development setup

Fork the repository on GitHub, then clone your fork, replacing `YOUR_USERNAME`:

```bash
git clone https://github.com/YOUR_USERNAME/ha-addons.git
cd ha-addons
```

The main directories are:

```text
custom_components/whatsapp/  Home Assistant custom integration
tests/components/whatsapp/   Integration tests
whatsapp_addon/              Add-on runtime, web UI, and voice bridge
docs/                       Knowledge base source
.github/workflows/          Automated checks and builds
```

Use a separate Home Assistant test installation for live checks. To test the
integration, copy `custom_components/whatsapp` into
`/config/custom_components/whatsapp` and restart Home Assistant. Follow the
[installation guide](README.md#installation) to install the companion add-on
and complete setup.

For changes to the add-on itself, build and test the edited source using the
[image test instructions](whatsapp_addon/voice/README.md#offline-tests).

## Testing

Run the checks relevant to your changes and include the commands and results
in the pull request.

### Integration

Add or update tests under `tests/components/whatsapp` when changing integration
code. From the repository root, use a Python 3.14 environment on Linux or WSL:

```bash
python -m pip install -r requirements_test.txt
pytest
```

Home Assistant imports Unix-only modules, so native Windows Python cannot run
this suite. CI checks both the minimum supported and current stable Home
Assistant versions.

### Add-on

With Node.js 20 or newer, run:

```bash
cd whatsapp_addon
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

This runs the messaging and voice JavaScript tests. For Python bridge or native
voice changes, also follow the
[offline voice and image tests](whatsapp_addon/voice/README.md#offline-tests).
Keep voice tests offline and use synthetic keys, callers, and audio.

### Live checks

For changes that affect live behavior, check the relevant flows in a test
installation:

- Add-on startup and the `GET /health` endpoint.
- Integration discovery, setup, and authenticated communication with the add-on.
- QR-code and phone-number pairing, including recovery after a failed attempt.
- Sending messages, calling actions, and receiving the affected Home Assistant
  events.
- Diagnostics without private message contents.
- Reloads and restarts without errors or lost sessions.
- Add-on operation without writing to Home Assistant's `/config` directory.

### Documentation

Edit the knowledge base in `docs/` and its navigation in `mkdocs.yml`. To preview
changes from the repository root:

```bash
python -m pip install -r requirements_docs.txt
python -m mkdocs serve
```

Check the site before submitting documentation changes:

```bash
python -m mkdocs build --strict
```

The [Documentation workflow](.github/workflows/docs.yml) checks knowledge base
changes and publishes them from `main`. Keep generated `site/` files out of
commits, and update README or add-on documentation links when moving pages.

### Build workflows and performance

For Docker, native dependency, or build-cache changes, use the manual
[Build benchmark workflow](.github/workflows/build-benchmark.yaml) with an exact
source commit and the target architecture. The `probe` suite checks dependency
cache behavior; the `full` suite repeats complete image builds and offline image
tests on fresh runners, publishing only isolated benchmark image tags. Neither
suite exports caches or creates a release.

Support cache-reuse claims with complete builds on fresh runners. A populated
cache index or a local cache hit is not enough evidence.

The [Build add-on image workflow](.github/workflows/build.yaml) publishes the
configured version tag even when `publish_latest` is false. Use the benchmark
workflow for experiments.

## Submitting a pull request

Keep the change focused and explain the problem it solves. Link any related
issue, describe the resulting behavior, and report what was tested.

Before submitting:

- Keep unrelated formatting and refactoring out of the change.
- Update documentation when installation, options, actions, events, diagnostics,
  or limitations change. Update English translations when changing setup or
  user-facing messages.
- Update `CHANGELOG.md` for user-visible changes. For add-on runtime changes,
  also update `whatsapp_addon/CHANGELOG.md`.
- Include screenshots for changes to notifications or the add-on web UI.
- Keep HACS and Hassfest checks passing without ignored checks.
- Use synthetic data in tests and examples. Never commit credentials, WhatsApp
  sessions, QR codes, phone numbers, chat IDs, message bodies, recordings, or
  private Home Assistant configuration.

When preparing a release, keep `whatsapp_addon/config.yaml` and
`whatsapp_addon/package.json` versions aligned, and update
`custom_components/whatsapp/manifest.json` if the integration version changes.
Documentation-only changes do not need a version bump.

Be respectful and constructive in issues and reviews.
