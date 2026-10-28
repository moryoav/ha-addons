"""Inspect benchmark images and permit registry copies only into isolated targets.

Registry reads are anonymous unless GHCR_USER and GHCR_TOKEN are both supplied.
The mirror command uses Docker's existing login and never builds an image.
Embedded build attestations are checked here; signature verification remains a
separate Cosign step in the workflow.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REGISTRY = "ghcr.io"
OWNER = "moryoav"
ARCHITECTURES = {"amd64": "amd64", "aarch64": "arm64"}
PRODUCTION_REPOSITORIES = tuple(
    f"{OWNER}/{prefix}whatsapp-addon" for prefix in ("", "amd64-", "aarch64-")
)
BENCHMARK_REPOSITORIES = tuple(f"{name}-bench" for name in PRODUCTION_REPOSITORIES)
DIGEST_PATTERN = re.compile(r"sha256:[0-9a-f]{64}")
TAG_PATTERN = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}")
BENCHMARK_TAG_PATTERN = re.compile(r"run-[1-9][0-9]{0,19}(?:-[a-z0-9]+)*")
INDEX_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
MANIFEST_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}
ACCEPT = ", ".join(sorted(INDEX_TYPES | MANIFEST_TYPES))
MAX_JSON_BYTES = 16 * 1024 * 1024


class BenchmarkError(ValueError):
    """Report a deliberately safe benchmark invariant or registry-read failure."""


@dataclass(frozen=True)
class ImageReference:
    """Hold an allowed GHCR repository and one tag or immutable digest."""

    repository: str
    selector: str

    def pinned(self, digest: str) -> str:
        """Return this repository addressed by a validated content digest."""
        if DIGEST_PATTERN.fullmatch(digest) is None:
            raise BenchmarkError("Expected a SHA256 image digest")
        return f"{REGISTRY}/{self.repository}@{digest}"


def parse_reference(value: str) -> ImageReference:
    """Accept only this project's production or benchmark image references."""
    prefix = f"{REGISTRY}/"
    if not value.startswith(prefix):
        raise BenchmarkError("Only the project's GHCR image references are allowed")
    remainder = value[len(prefix) :]
    if "@" in remainder:
        repository, selector = remainder.split("@", 1)
        valid = DIGEST_PATTERN.fullmatch(selector)
    else:
        repository, separator, selector = remainder.rpartition(":")
        valid = separator and TAG_PATTERN.fullmatch(selector)
    if repository not in PRODUCTION_REPOSITORIES + BENCHMARK_REPOSITORIES or not valid:
        raise BenchmarkError("Unsupported project image repository, tag, or digest")
    return ImageReference(repository, selector)


def benchmark_destination(run_id: str, architecture: str, label: str) -> str:
    """Generate a benchmark-only reference whose tag identifies one experiment."""
    prefix = "" if architecture == "multi" else f"{architecture}-"
    if architecture not in (*ARCHITECTURES, "multi"):
        raise BenchmarkError("Unsupported benchmark architecture")
    destination = (
        f"{REGISTRY}/{OWNER}/{prefix}whatsapp-addon-bench:run-{run_id}-{label}"
    )
    validate_destination(destination)
    return destination


def validate_destination(value: str) -> ImageReference:
    """Reject production repositories and every non-experiment destination tag."""
    reference = parse_reference(value)
    if (
        reference.repository not in BENCHMARK_REPOSITORIES
        or BENCHMARK_TAG_PATTERN.fullmatch(reference.selector) is None
        or len(reference.selector) > 128
    ):
        raise BenchmarkError(
            "Writes require a benchmark repository and run-<id>-<label> tag"
        )
    return reference


def content_digest(data: bytes) -> str:
    """Return the OCI SHA256 digest of the exact downloaded bytes."""
    return "sha256:" + hashlib.sha256(data).hexdigest()


def normalized_platform(platform: dict[str, Any]) -> str:
    """Normalize default ARM64/AMD64 variants without trusting descriptor labels."""
    operating_system = platform.get("os")
    architecture = platform.get("architecture")
    variant = platform.get("variant", "")
    if operating_system != "linux" or architecture not in ARCHITECTURES.values():
        raise BenchmarkError("Expected a Linux AMD64 or ARM64 runtime image")
    if (architecture, variant) in (("arm64", "v8"), ("amd64", "v1")):
        variant = ""
    return f"{operating_system}/{architecture}" + (f"/{variant}" if variant else "")


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Keep GHCR authorization off a different host used for blob downloads."""

    def redirect_request(self, request, fp, code, message, headers, new_url):
        """Allow HTTPS redirects while stripping authorization across origins."""
        if urllib.parse.urlsplit(new_url).scheme != "https":
            raise BenchmarkError("Registry downloads must remain on HTTPS")
        redirected = super().redirect_request(
            request, fp, code, message, headers, new_url
        )
        if (
            redirected
            and urllib.parse.urlsplit(request.full_url).netloc
            != urllib.parse.urlsplit(new_url).netloc
        ):
            redirected.remove_header("Authorization")
        return redirected


class RegistryClient:
    """Read GHCR JSON documents without printing registry credentials or JWTs."""

    def __init__(
        self, username: str | None = None, password: str | None = None, opener=None
    ):
        """Use anonymous access by default and permit explicit workflow credentials."""
        if bool(username) != bool(password):
            raise BenchmarkError("Supply both GHCR_USER and GHCR_TOKEN or neither")
        self._username = username
        self._password = password
        self._opener = opener or urllib.request.build_opener(SafeRedirectHandler())
        self._tokens: dict[str, str] = {}

    def _read(self, request: urllib.request.Request) -> tuple[bytes, Any]:
        """Read a bounded JSON response and redact HTTP errors from authenticated URLs."""
        try:
            with self._opener.open(request, timeout=30) as response:
                data = response.read(MAX_JSON_BYTES + 1)
                headers = response.headers
        except urllib.error.HTTPError as error:
            raise BenchmarkError(
                f"Registry read failed with HTTP {error.code}"
            ) from None
        except urllib.error.URLError:
            raise BenchmarkError(
                "Registry read failed; check connectivity and credentials"
            ) from None
        if len(data) > MAX_JSON_BYTES:
            raise BenchmarkError("Registry JSON response exceeded the size limit")
        return data, headers

    def _token(self, repository: str) -> str:
        """Obtain and cache a read-only token for one allowed repository."""
        if repository not in PRODUCTION_REPOSITORIES + BENCHMARK_REPOSITORIES:
            raise BenchmarkError("Unsupported registry repository")
        if repository not in self._tokens:
            query = urllib.parse.urlencode(
                {"service": REGISTRY, "scope": f"repository:{repository}:pull"}
            )
            request = urllib.request.Request(f"https://{REGISTRY}/token?{query}")
            if self._username and self._password:
                basic = base64.b64encode(
                    f"{self._username}:{self._password}".encode()
                ).decode()
                request.add_header("Authorization", f"Basic {basic}")
            data, _ = self._read(request)
            payload = json.loads(data)
            token = payload.get("token") or payload.get("access_token")
            if not isinstance(token, str) or not token:
                raise BenchmarkError("Registry did not supply a read token")
            self._tokens[repository] = token
        return self._tokens[repository]

    def _document(
        self, repository: str, kind: str, selector: str
    ) -> tuple[dict[str, Any], str]:
        """Fetch a manifest or config and verify its exact content digest."""
        token = self._token(repository)
        request = urllib.request.Request(
            f"https://{REGISTRY}/v2/{repository}/{kind}/{selector}",
            headers={"Authorization": f"Bearer {token}", "Accept": ACCEPT},
        )
        data, headers = self._read(request)
        digest = content_digest(data)
        advertised = headers.get("Docker-Content-Digest")
        if advertised and advertised != digest:
            raise BenchmarkError("Registry response digest does not match its bytes")
        if DIGEST_PATTERN.fullmatch(selector) and selector != digest:
            raise BenchmarkError("Requested content digest does not match its bytes")
        document = json.loads(data)
        if not isinstance(document, dict):
            raise BenchmarkError("Registry JSON document must be an object")
        return document, digest

    def manifest(self, repository: str, selector: str) -> tuple[dict[str, Any], str]:
        """Read a tagged or digest-addressed image manifest."""
        return self._document(repository, "manifests", selector)

    def config(self, repository: str, digest: str) -> dict[str, Any]:
        """Read an image configuration addressed by SHA256."""
        if DIGEST_PATTERN.fullmatch(digest) is None:
            raise BenchmarkError("Expected an image config digest")
        return self._document(repository, "blobs", digest)[0]


def inspect_image(client: RegistryClient, value: str) -> dict[str, Any]:
    """Inspect actual runtime configs and embedded attestation descriptors recursively."""
    reference = parse_reference(value)
    root, root_digest = client.manifest(reference.repository, reference.selector)
    platforms: dict[str, dict[str, Any]] = {}
    attestations: list[dict[str, Any]] = []
    visited: set[str] = set()

    def visit(document: dict[str, Any], digest: str, descriptor=None) -> None:
        """Walk nested indexes, treating attestation descriptors separately from runtimes."""
        media_type = document.get("mediaType")
        if media_type in INDEX_TYPES:
            if digest in visited:
                raise BenchmarkError("Image repeats a nested index")
            visited.add(digest)
            for child in document.get("manifests", []):
                child_digest = child.get("digest", "")
                if DIGEST_PATTERN.fullmatch(child_digest) is None:
                    raise BenchmarkError("Index contains an invalid descriptor digest")
                annotations = child.get("annotations", {})
                platform = child.get("platform", {})
                if (
                    annotations.get("vnd.docker.reference.type")
                    == "attestation-manifest"
                    or platform.get("architecture") == "unknown"
                    or child.get("artifactType")
                ):
                    payload, _ = client.manifest(reference.repository, child_digest)
                    client.config(reference.repository, payload["config"]["digest"])
                    for layer in payload.get("layers", []):
                        client.config(reference.repository, layer["digest"])
                    attestations.append(child)
                    continue
                payload, actual_digest = client.manifest(
                    reference.repository, child_digest
                )
                visit(payload, actual_digest, child)
            return
        if media_type not in MANIFEST_TYPES:
            raise BenchmarkError("Unsupported runtime image manifest type")
        config_digest = document.get("config", {}).get("digest", "")
        config = client.config(reference.repository, config_digest)
        platform_name = normalized_platform(config)
        if descriptor and descriptor.get("platform"):
            if normalized_platform(descriptor["platform"]) != platform_name:
                raise BenchmarkError(
                    "Manifest platform disagrees with the actual image config"
                )
        if platform_name in platforms:
            raise BenchmarkError(
                "Image has multiple runtime manifests for one platform"
            )
        labels = config.get("config", {}).get("Labels", {}) or {}
        expected_arch = next(
            name
            for name, arch in ARCHITECTURES.items()
            if arch == config["architecture"]
        )
        if labels.get("io.hass.arch") != expected_arch:
            raise BenchmarkError("Actual image architecture and add-on label disagree")
        version = labels.get("io.hass.version")
        if not version or labels.get("org.opencontainers.image.version") != version:
            raise BenchmarkError("Image version labels are absent or inconsistent")
        platforms[platform_name] = {
            "manifest_digest": digest,
            "config_digest": config_digest,
            "layer_digests": [layer["digest"] for layer in document.get("layers", [])],
            "version": version,
            "addon_architecture": expected_arch,
        }

    visit(root, root_digest)
    if not platforms:
        raise BenchmarkError("Image has no supported runtime manifests")
    for addon_arch, oci_arch in ARCHITECTURES.items():
        if reference.repository.rsplit("/", 1)[-1].startswith(f"{addon_arch}-"):
            if set(platforms) != {f"linux/{oci_arch}"}:
                raise BenchmarkError(
                    "Architecture-specific repository contains unexpected runtime platforms"
                )
    if len({platform["version"] for platform in platforms.values()}) != 1:
        raise BenchmarkError("Runtime image versions differ between architectures")
    return {
        "reference": value,
        "pinned_reference": reference.pinned(root_digest),
        "digest": root_digest,
        "media_type": root.get("mediaType"),
        "platforms": dict(sorted(platforms.items())),
        "embedded_attestations": sorted(attestations, key=lambda item: item["digest"]),
    }


def verify_provenance(
    client: RegistryClient, value: str, revision: str
) -> dict[str, Any]:
    """Verify the application revision in digest-checked embedded SLSA statements."""
    if re.fullmatch(r"[0-9a-f]{40}", revision) is None:
        raise BenchmarkError("Expected a complete Git source revision")
    reference = parse_reference(value)
    inspected = inspect_image(client, value)
    statements = []
    for descriptor in inspected["embedded_attestations"]:
        manifest, _ = client.manifest(reference.repository, descriptor["digest"])
        for layer in manifest.get("layers", []):
            statement = client.config(reference.repository, layer["digest"])
            if statement.get("predicateType") != "https://slsa.dev/provenance/v1":
                continue
            predicate = statement.get("predicate", {})
            recorded = (
                predicate.get("runDetails", {})
                .get("metadata", {})
                .get("buildkit_metadata", {})
                .get("vcs", {})
                .get("revision")
            )
            if recorded != revision:
                raise BenchmarkError(
                    "Embedded provenance has a different application revision"
                )
            statements.append(layer["digest"])
    if not statements:
        raise BenchmarkError("Image has no embedded SLSA v1 source provenance")
    return {
        "source_revision": revision,
        "statement_digests": sorted(statements),
        "image_digest": inspected["digest"],
    }


def compare_images(
    source: dict[str, Any], destination: dict[str, Any], same_root: bool = True
) -> dict[str, Any]:
    """Require identical runtime payloads and preserved embedded attestations."""
    if source["platforms"] != destination["platforms"]:
        raise BenchmarkError(
            "Promoted runtime manifests, configs, layers, or labels changed"
        )
    destination_attestations = {
        json.dumps(item, sort_keys=True)
        for item in destination["embedded_attestations"]
    }
    if any(
        json.dumps(item, sort_keys=True) not in destination_attestations
        for item in source["embedded_attestations"]
    ):
        raise BenchmarkError(
            "An embedded source attestation descriptor was lost or changed"
        )
    root_equal = source["digest"] == destination["digest"]
    if same_root and not root_equal:
        raise BenchmarkError("An exact index copy changed the source root digest")
    return {
        "runtime_payloads_equal": True,
        "embedded_attestations_preserved": True,
        "root_digest_equal": root_equal,
    }


def production_snapshot(client: RegistryClient, version: str) -> dict[str, Any]:
    """Capture version and latest references for all three production repositories."""
    if re.fullmatch(r"\d+\.\d+\.\d+", version) is None:
        raise BenchmarkError("Production snapshot requires an existing X.Y.Z version")
    images = {}
    for repository in PRODUCTION_REPOSITORIES:
        for selector in (version, "latest"):
            value = f"{REGISTRY}/{repository}:{selector}"
            image = inspect_image(client, value)
            if selector == version and any(
                platform["version"] != version
                for platform in image["platforms"].values()
            ):
                raise BenchmarkError(
                    "Production version tag contains a different image version"
                )
            images[value] = image
    return {
        "version": version,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "images": images,
    }


def compare_snapshots(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """Fail when any captured production image reference moved during an experiment."""
    version = before.get("version")
    if not isinstance(version, str) or re.fullmatch(r"\d+\.\d+\.\d+", version) is None:
        raise BenchmarkError("Production snapshot version is missing or invalid")
    expected = {
        f"{REGISTRY}/{repository}:{selector}"
        for repository in PRODUCTION_REPOSITORIES
        for selector in (version, "latest")
    }
    for snapshot in (before, after):
        if (
            snapshot.get("version") != version
            or set(snapshot.get("images", {})) != expected
        ):
            raise BenchmarkError(
                "Production snapshot must contain all six expected references"
            )
    old = {name: image["digest"] for name, image in before["images"].items()}
    new = {name: image["digest"] for name, image in after["images"].items()}
    if any(
        not isinstance(digest, str) or DIGEST_PATTERN.fullmatch(digest) is None
        for digest in (*old.values(), *new.values())
    ):
        raise BenchmarkError("Production snapshot contains an invalid image digest")
    if old != new:
        raise BenchmarkError("Production image references changed during the benchmark")
    return {"production_references_unchanged": True, "references": len(old)}


def mirror_image(
    client: RegistryClient, source: str, destination: str
) -> dict[str, Any]:
    """Copy an immutable inspected image only into a guarded benchmark destination."""
    validate_destination(destination)
    source_image = inspect_image(client, source)
    command = [
        "docker",
        "buildx",
        "imagetools",
        "create",
        "--tag",
        destination,
        source_image["pinned_reference"],
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode:
        raise BenchmarkError(
            f"Docker manifest copy failed with exit code {completed.returncode}"
        )
    destination_image = inspect_image(client, destination)
    comparison = compare_images(source_image, destination_image)
    return {
        "source": source_image,
        "destination": destination_image,
        "comparison": comparison,
    }


def main() -> int:
    """Expose guarded inspection, snapshots, and no-build promotion as JSON commands."""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("reference")
    snapshot = commands.add_parser("snapshot")
    snapshot.add_argument("--version", required=True)
    destination = commands.add_parser("destination")
    destination.add_argument("--run-id", required=True)
    destination.add_argument(
        "--architecture", choices=(*ARCHITECTURES, "multi"), required=True
    )
    destination.add_argument("--label", required=True)
    mirror = commands.add_parser("mirror")
    mirror.add_argument("source")
    mirror.add_argument("destination")
    verify = commands.add_parser("verify")
    verify.add_argument("source")
    verify.add_argument("destination")
    verify.add_argument("--allow-index-change", action="store_true")
    provenance = commands.add_parser("provenance")
    provenance.add_argument("reference")
    provenance.add_argument("--revision", required=True)
    unchanged = commands.add_parser("assert-unchanged")
    unchanged.add_argument("before", type=Path)
    unchanged.add_argument("after", type=Path)
    arguments = parser.parse_args()
    try:
        client = RegistryClient(
            os.environ.get("GHCR_USER"), os.environ.get("GHCR_TOKEN")
        )
        if arguments.command == "inspect":
            result = inspect_image(client, arguments.reference)
        elif arguments.command == "snapshot":
            result = production_snapshot(client, arguments.version)
        elif arguments.command == "destination":
            result = {
                "reference": benchmark_destination(
                    arguments.run_id, arguments.architecture, arguments.label
                )
            }
        elif arguments.command == "mirror":
            result = mirror_image(client, arguments.source, arguments.destination)
        elif arguments.command == "verify":
            validate_destination(arguments.destination)
            result = compare_images(
                inspect_image(client, arguments.source),
                inspect_image(client, arguments.destination),
                not arguments.allow_index_change,
            )
        elif arguments.command == "provenance":
            result = verify_provenance(client, arguments.reference, arguments.revision)
        else:
            result = compare_snapshots(
                json.loads(arguments.before.read_text()),
                json.loads(arguments.after.read_text()),
            )
        print(json.dumps(result, sort_keys=True, indent=2))
    except BenchmarkError as error:
        print(f"Image benchmark operation failed: {error}", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        # Do not print exception objects that might contain authenticated URLs.
        print(
            "Image benchmark operation failed; inspect inputs, registry access, and invariants.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
