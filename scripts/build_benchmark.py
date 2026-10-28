"""Plan read-only Docker cache probes and collect the actual BuildKit cache keys."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

REPOSITORY = "moryoav/ha-addons"
ARCHITECTURES = {
    "amd64": ("linux/amd64", "ubuntu-24.04"),
    "aarch64": ("linux/arm64", "ubuntu-24.04-arm"),
}
PRODUCTION_INLINE_BASELINE = {
    "amd64": "ghcr.io/moryoav/amd64-whatsapp-addon@sha256:f504293137634f47173a0e2dd8fd8ecdf0afab9547690b7bc6564695839df621",
    "aarch64": "ghcr.io/moryoav/aarch64-whatsapp-addon@sha256:446c65f30bfe718a6e179dcd28c06998ee1c74c0d25243fc37030b3e4e263618",
}
CASES = {
    "ci-control": (False, True, False),
    "pull-explicit": (True, True, False),
    "native-default": (False, False, False),
    "release-like": (True, False, False),
    "release-inline": (True, False, True),
}
TOKEN_PATTERN = re.compile(r"\b(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b")
SIGNED_QUERY_PATTERN = re.compile(
    r"([?&](?:sig|signature|token|hmac|policy|x-amz-signature|x-amz-security-token|x-amz-credential)=)[^&#\s\"']+",
    re.IGNORECASE,
)


def sanitize_text(value: str) -> str:
    """Remove credentials and signed URL query values while preserving cache hashes."""
    names = ("GITHUB_TOKEN", "GH_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    known = sorted({os.environ[name] for name in names if os.environ.get(name)}, key=len, reverse=True)
    for secret in known:
        value = value.replace(secret, "[REDACTED]")
    value = TOKEN_PATTERN.sub("[REDACTED]", value)
    return SIGNED_QUERY_PATTERN.sub(r"\1[REDACTED]", value)


def sanitize_data(value: object, *, frame_data: bool = False) -> object:
    """Redact JSON strings and encoded debug frames only when they contain secrets."""
    if isinstance(value, dict):
        return {key: sanitize_data(item, frame_data=key.lower() == "data") for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize_data(item, frame_data=frame_data) for item in value]
    if not isinstance(value, str):
        return value
    redacted = sanitize_text(value)
    if frame_data and redacted == value:
        try:
            decoded = base64.b64decode(value, validate=True).decode("utf-8")
        except (ValueError, binascii.Error, UnicodeDecodeError):
            return redacted
        safe = sanitize_text(decoded)
        if safe != decoded:
            return base64.b64encode(safe.encode("utf-8")).decode("ascii")
    return redacted


def plan(source_sha: str, architecture: str, suite: str) -> dict:
    """Return only the fixed, read-only probe cases for a full source commit."""
    if re.fullmatch(r"[0-9a-f]{40}", source_sha) is None:
        raise ValueError("source_sha must be a complete lowercase Git commit SHA")
    if suite != "probe":
        raise ValueError("Only the dependencies-only probe suite is supported")
    if architecture not in (*ARCHITECTURES, "both"):
        raise ValueError("Unsupported benchmark architecture")
    selected = ARCHITECTURES if architecture == "both" else [architecture]
    include = []
    for arch in selected:
        platform, runner = ARCHITECTURES[arch]
        for case, (pull, explicit_platform, inline) in CASES.items():
            cache_from = f"type=gha,scope={arch}-rust"
            if inline:
                cache_from += f"\ntype=registry,ref={PRODUCTION_INLINE_BASELINE[arch]}"
            include.append({
                "arch": arch, "runner": runner, "case": case, "pull": pull,
                "platforms": platform if explicit_platform else "",
                "cache_from": cache_from,
            })
    return {"include": include}


def output(name: str, value: str) -> None:
    """Write a single-line action output without accepting workflow commands."""
    if "\n" in value or "\r" in value:
        raise ValueError(f"Action output {name} must fit on one line")
    with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as stream:
        stream.write(f"{name}={value}\n")


def run(arguments: list[str]) -> str:
    """Run one local diagnostic command without shell expansion or credentials."""
    result = subprocess.run(arguments, check=True, capture_output=True, text=True)
    return result.stdout


def builder_container(builder: str) -> str:
    """Find exactly the container owned by the selected Buildx instance."""
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", builder) is None:
        raise ValueError("Invalid Buildx builder name")
    prefix = f"buildx_buildkit_{builder}"
    names = run(["docker", "ps", "--filter", f"name={prefix}", "--format", "{{.Names}}"])
    matches = [name for name in names.splitlines() if re.fullmatch(re.escape(prefix) + r"\d+", name)]
    if len(matches) != 1:
        raise ValueError("Expected exactly one container for this benchmark builder")
    return matches[0]


def parse_cache_dump(contents: str, endpoint: str, *, after_probe: bool = False) -> object:
    """Validate HTTP JSON while allowing an unused local store after cache hits."""
    if endpoint not in ("all", "store"):
        raise ValueError("Unsupported cache diagnostic endpoint")
    data = json.loads(contents)
    if data is not None and not isinstance(data, list):
        raise ValueError(f"Cache diagnostic {endpoint} must be a JSON array or null")
    if after_probe and endpoint == "all" and not data:
        raise ValueError("Cache-map hash diagnostics were empty after the probe")
    return data


def cache_json(container: str, endpoint: str, *, after_probe: bool = False) -> object:
    """Read cache diagnostics through the builder's unpublished loopback endpoint."""
    if endpoint not in ("all", "store"):
        raise ValueError("Unsupported cache diagnostic endpoint")
    command = (
        "if command -v wget >/dev/null 2>&1; then exec wget \"$@\"; "
        "else exec /bin/busybox wget \"$@\"; fi"
    )
    contents = run([
        "docker", "exec", container, "/bin/sh", "-c", command, "benchmark-wget",
        "-qO-", "--header=Accept: application/json",
        f"http://127.0.0.1:6060/debug/cache/{endpoint}",
    ])
    return parse_cache_dump(contents, endpoint, after_probe=after_probe)


def prepare(source: Path, destination: Path) -> None:
    """Verify the selected source and require working cache diagnostics before building."""
    requested = os.environ["BENCH_SOURCE_SHA"]
    matrix = plan(requested, os.environ["BENCH_ARCHITECTURE"], "probe")
    if os.environ["BENCH_CASE"] not in {entry["case"] for entry in matrix["include"]}:
        raise ValueError("Unsupported benchmark case")
    actual = run(["git", "-C", str(source), "rev-parse", "HEAD"]).strip()
    if actual != requested:
        raise ValueError("Checked-out source does not match the requested commit")
    config = (source / "whatsapp_addon/config.yaml").read_text(encoding="utf-8")
    version = re.search(r"^version:\s*(\d+\.\d+\.\d+)\s*$", config, re.MULTILINE)
    if version is None:
        raise ValueError("Cannot read the configured add-on version")
    container = builder_container(os.environ["BENCH_BUILDER"])
    destination.mkdir(parents=True, exist_ok=True)
    for endpoint in ("all", "store"):
        initial = cache_json(container, endpoint)
        (destination / f"cache-{endpoint}-before.json").write_text(
            json.dumps(sanitize_data(initial), indent=2), encoding="utf-8"
        )
    contract = {
        "source_sha": requested,
        "version": version.group(1),
        "arch": os.environ["BENCH_ARCHITECTURE"],
        "case": os.environ["BENCH_CASE"],
        "pull": os.environ["BENCH_PULL"],
        "platforms": os.environ["BENCH_PLATFORMS"],
        "cache_from": os.environ["BENCH_CACHE_FROM"].splitlines(),
        "target": "dependencies",
        "outputs": "type=cacheonly",
        "cache_exports": [],
        "dockerfile_sha256": hashlib.sha256((source / "whatsapp_addon/Dockerfile").read_bytes()).hexdigest(),
        "started_unix": time.time(),
    }
    (destination / "contract.json").write_text(json.dumps(contract, indent=2), encoding="utf-8")
    output("version", version.group(1))


def collect(destination: Path) -> None:
    """Save cache-map hash frames, record links, and probe metadata as CI artifacts."""
    container = builder_container(os.environ["BENCH_BUILDER"])
    errors = []
    counts = {}
    for endpoint in ("all", "store"):
        try:
            data = cache_json(container, endpoint, after_probe=True)
            (destination / f"cache-{endpoint}.json").write_text(json.dumps(sanitize_data(data), indent=2), encoding="utf-8")
            counts[endpoint] = len(data or [])
        except (ValueError, subprocess.CalledProcessError) as error:
            errors.append(f"Could not collect {endpoint}: {error}")
    for name, arguments in {
        "builder.log": ["docker", "logs", "--timestamps", container],
        "worker.txt": ["docker", "exec", container, "buildctl", "debug", "workers", "--verbose"],
        "buildkit-version.txt": ["docker", "exec", container, "buildkitd", "--version"],
        "buildx-version.txt": ["docker", "buildx", "version"],
        "builder-image.txt": ["docker", "inspect", "--format", "{{.Image}}", container],
    }.items():
        result = subprocess.run(arguments, capture_output=True, text=True)
        (destination / name).write_text(sanitize_text(result.stdout + result.stderr), encoding="utf-8")
        if result.returncode:
            errors.append(f"Could not collect {name}")
    contract = json.loads((destination / "contract.json").read_text(encoding="utf-8"))
    contract["elapsed_seconds"] = round(time.time() - contract["started_unix"], 3)
    contract["outcome"] = os.environ.get("BENCH_BUILD_OUTCOME", "unknown")
    contract["build_metadata"] = json.loads(os.environ.get("BENCH_BUILD_METADATA") or "{}")
    contract["diagnostic_errors"] = errors
    contract["diagnostic_entry_counts"] = counts
    (destination / "result.json").write_text(json.dumps(sanitize_data(contract), indent=2), encoding="utf-8")
    summary = (
        f"### {contract['arch']} / {contract['case']}\n\n"
        f"- Source: `{contract['source_sha']}`\n"
        f"- Target: `dependencies` (no Rust compilation)\n"
        f"- Pull: `{contract['pull']}`; platforms: `{contract['platforms'] or 'native default'}`\n"
        f"- Build outcome: `{contract['outcome']}`\n"
        f"- Probe and collection elapsed: {contract['elapsed_seconds']} seconds\n"
        f"- Cache-map entries: {counts.get('all', 'unavailable')}; local solver-store entries: {counts.get('store', 'unavailable')}\n"
        f"- Diagnostic errors: {len(errors)}\n\n"
        "The raw job log and Docker build record provide cache-hit and first-miss evidence. "
        "The uploaded JSON contains the actual cache-map hash frames and record links. "
        "An empty local solver store can be valid when imported cache results satisfy the probe.\n\n"
    )
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a", encoding="utf-8") as stream:
        stream.write(summary)
    if errors:
        raise ValueError("; ".join(errors))


def main() -> int:
    """Run the bounded benchmark planning or diagnostic collection command."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["plan", "prepare", "collect"])
    parser.add_argument("--source", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY:
            raise ValueError("This diagnostic workflow is restricted to its original repository")
        if args.command == "plan":
            source_sha = os.environ["BENCH_SOURCE_SHA"]
            matrix = plan(source_sha, os.environ["BENCH_ARCHITECTURE"], os.environ["BENCH_SUITE"])
            output("matrix", json.dumps(matrix, separators=(",", ":")))
            output("source_sha", source_sha)
            print(json.dumps(matrix, indent=2))
        elif args.command == "prepare" and args.source is not None and args.output is not None:
            prepare(args.source, args.output)
        elif args.command == "collect" and args.output is not None:
            collect(args.output)
        else:
            raise ValueError("Required source or output directory is missing")
    except (KeyError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print(sanitize_text(f"Build benchmark failed: {error}"), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
