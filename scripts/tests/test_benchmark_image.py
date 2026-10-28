"""Exercise benchmark write guards and actual image-payload verification offline."""

from __future__ import annotations

import copy
import importlib.util
import io
import json
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "benchmark_image.py"
SPEC = importlib.util.spec_from_file_location("benchmark_image", MODULE_PATH)
assert SPEC and SPEC.loader
image = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = image
SPEC.loader.exec_module(image)

INDEX_TYPE = "application/vnd.oci.image.index.v1+json"
MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json"
SOURCE = "ghcr.io/moryoav/whatsapp-addon:3.3.1"
DESTINATION = "ghcr.io/moryoav/whatsapp-addon-bench:run-123-seed"


class SyntheticRegistry:
    """Supply content-addressed image fixtures without registry or Docker access."""

    def __init__(self):
        """Build a two-architecture index with one embedded provenance descriptor."""
        self.documents = {}
        self.configs = {}
        children = []
        for addon_arch, oci_arch in image.ARCHITECTURES.items():
            config = {
                "os": "linux",
                "architecture": oci_arch,
                "config": {
                    "Labels": {
                        "io.hass.arch": addon_arch,
                        "io.hass.version": "3.3.1",
                        "org.opencontainers.image.version": "3.3.1",
                    }
                },
            }
            config_digest = self.digest(config)
            self.configs[config_digest] = config
            manifest = {
                "schemaVersion": 2,
                "mediaType": MANIFEST_TYPE,
                "config": {"digest": config_digest},
                "layers": [
                    {"digest": "sha256:" + ("1" if addon_arch == "amd64" else "2") * 64}
                ],
            }
            digest = self.digest(manifest)
            self.documents[digest] = manifest
            children.append(
                {
                    "digest": digest,
                    "mediaType": MANIFEST_TYPE,
                    "platform": {"os": "linux", "architecture": oci_arch},
                }
            )
        attestation_config = {"os": "unknown", "architecture": "unknown"}
        attestation_config_digest = self.digest(attestation_config)
        self.configs[attestation_config_digest] = attestation_config
        provenance = {
            "predicateType": "https://slsa.dev/provenance/v1",
            "predicate": {
                "runDetails": {
                    "metadata": {
                        "buildkit_metadata": {
                            "vcs": {
                                "revision": "6885e1ce4cbd58a2827499d6eb0272aa64403098"
                            }
                        }
                    }
                }
            },
        }
        self.provenance_digest = self.digest(provenance)
        self.configs[self.provenance_digest] = provenance
        attestation = {
            "schemaVersion": 2,
            "mediaType": MANIFEST_TYPE,
            "config": {"digest": attestation_config_digest},
            "layers": [{"digest": self.provenance_digest}],
        }
        self.attestation_digest = self.digest(attestation)
        self.documents[self.attestation_digest] = attestation
        children.append(
            {
                "digest": self.attestation_digest,
                "mediaType": MANIFEST_TYPE,
                "platform": {"os": "unknown", "architecture": "unknown"},
                "annotations": {
                    "vnd.docker.reference.type": "attestation-manifest",
                    "vnd.docker.reference.digest": children[0]["digest"],
                },
            }
        )
        self.root = {"schemaVersion": 2, "mediaType": INDEX_TYPE, "manifests": children}
        self.root_digest = self.digest(self.root)
        self.documents[self.root_digest] = self.root

    @staticmethod
    def digest(document):
        """Hash fixture JSON so every descriptor changes with its payload."""
        return image.content_digest(json.dumps(document, sort_keys=True).encode())

    def manifest(self, repository, selector):
        """Resolve fixture tags and immutable digests to independent documents."""
        if not selector.startswith("sha256:"):
            for addon_arch, oci_arch in image.ARCHITECTURES.items():
                if repository.rsplit("/", 1)[-1].startswith(f"{addon_arch}-"):
                    document = copy.deepcopy(self.root)
                    document["manifests"] = [
                        child
                        for child in document["manifests"]
                        if child.get("platform", {}).get("architecture") == oci_arch
                        or child.get("platform", {}).get("architecture") == "unknown"
                    ]
                    return document, self.digest(document)
        digest = selector if selector.startswith("sha256:") else self.root_digest
        return copy.deepcopy(self.documents[digest]), digest

    def config(self, repository, digest):
        """Read an independent fixture config using its content digest."""
        del repository
        return copy.deepcopy(self.configs[digest])


class GuardTests(unittest.TestCase):
    """Prove that promotion cannot target production names or mutable release tags."""

    def test_generated_targets_are_isolated(self):
        """Generate all allowed architecture targets using one experiment ID."""
        for architecture, prefix in (
            ("amd64", "amd64-"),
            ("aarch64", "aarch64-"),
            ("multi", ""),
        ):
            self.assertEqual(
                image.benchmark_destination("123", architecture, "warm-2"),
                f"ghcr.io/moryoav/{prefix}whatsapp-addon-bench:run-123-warm-2",
            )

    def test_production_and_unscoped_destinations_are_rejected(self):
        """Reject every production repository, version tag, alias, and injected suffix."""
        invalid = [
            "ghcr.io/moryoav/whatsapp-addon:run-123-test",
            "ghcr.io/moryoav/amd64-whatsapp-addon:run-123-test",
            "ghcr.io/moryoav/aarch64-whatsapp-addon:run-123-test",
            "ghcr.io/moryoav/whatsapp-addon-bench:latest",
            "ghcr.io/moryoav/whatsapp-addon-bench:3.3.1",
            "ghcr.io/moryoav/whatsapp-addon-bench:run-0-test",
            "ghcr.io/moryoav/whatsapp-addon-bench:run-123-test --tag production",
            "ghcr.io/moryoav/whatsapp-addon-bench:run-123-test\nlatest",
            "ghcr.io/another-owner/whatsapp-addon-bench:run-123-test",
            "ghcr.io/moryoav/other-whatsapp-addon-bench:run-123-test",
            "ghcr.io/moryoav/whatsapp-addon-bench@sha256:" + "1" * 64,
        ]
        for reference in invalid:
            with self.subTest(reference=reference), self.assertRaises(ValueError):
                image.validate_destination(reference)

    def test_guard_runs_before_registry_reads_or_docker(self):
        """Reject unsafe writes before any network call or registry mutation starts."""
        with (
            patch.object(image, "inspect_image") as inspect,
            patch.object(image.subprocess, "run") as run,
        ):
            with self.assertRaises(ValueError):
                image.mirror_image(
                    object(), SOURCE, "ghcr.io/moryoav/whatsapp-addon:latest"
                )
            inspect.assert_not_called()
            run.assert_not_called()

    def test_mirror_pins_the_source_before_copying(self):
        """Copy the inspected digest even when a caller supplied a mutable source tag."""
        registry = SyntheticRegistry()
        with patch.object(
            image.subprocess, "run", return_value=SimpleNamespace(returncode=0)
        ) as run:
            result = image.mirror_image(registry, SOURCE, DESTINATION)
        self.assertTrue(result["comparison"]["root_digest_equal"])
        command = run.call_args.args[0]
        self.assertEqual(
            command,
            [
                "docker",
                "buildx",
                "imagetools",
                "create",
                "--tag",
                DESTINATION,
                "ghcr.io/moryoav/whatsapp-addon@" + registry.root_digest,
            ],
        )


class PayloadTests(unittest.TestCase):
    """Compare real configuration fields rather than trusting an index's platform label."""

    def setUp(self):
        """Create a new registry fixture and its inspected source for every test."""
        self.registry = SyntheticRegistry()
        self.source = image.inspect_image(self.registry, SOURCE)

    def test_inspection_separates_runtime_images_from_attestations(self):
        """Recognize both actual runtime configs and retain provenance metadata."""
        self.assertEqual(set(self.source["platforms"]), {"linux/amd64", "linux/arm64"})
        self.assertEqual(len(self.source["embedded_attestations"]), 1)
        self.assertEqual(
            self.source["platforms"]["linux/arm64"]["addon_architecture"], "aarch64"
        )

    def test_missing_attestation_manifest_or_payload_is_rejected(self):
        """Require attestation payload availability in the inspected repository."""
        for missing in ("manifest", "payload"):
            registry = SyntheticRegistry()
            if missing == "manifest":
                del registry.documents[registry.attestation_digest]
            else:
                del registry.configs[registry.provenance_digest]
            with (
                self.subTest(missing=missing),
                self.assertRaises((ValueError, KeyError)),
            ):
                image.inspect_image(registry, SOURCE)

    def test_changed_attestation_bytes_fail_digest_verification(self):
        """Exercise the registry byte checker when an embedded provenance layer is read."""
        original = self.registry.config

        def changed_payload(repository, digest):
            """Return a tampered provenance response through the real digest checker."""
            if digest != self.registry.provenance_digest:
                return original(repository, digest)
            client = image.RegistryClient()
            with (
                patch.object(client, "_token", return_value="synthetic-token"),
                patch.object(client, "_read", return_value=(b'{"changed": true}', {})),
            ):
                return client.config(repository, digest)

        with patch.object(self.registry, "config", side_effect=changed_payload):
            with self.assertRaisesRegex(ValueError, "Requested content digest"):
                image.inspect_image(self.registry, SOURCE)

    def test_provenance_revision_is_checked_at_its_structured_field(self):
        """Verify source identity using SLSA data rather than image labels or text search."""
        expected = "6885e1ce4cbd58a2827499d6eb0272aa64403098"
        self.assertEqual(
            image.verify_provenance(self.registry, SOURCE, expected)["source_revision"],
            expected,
        )
        with self.assertRaisesRegex(ValueError, "different application revision"):
            image.verify_provenance(self.registry, SOURCE, "0" * 40)

    def test_forged_platform_descriptor_is_rejected(self):
        """Detect an ARM label attached to an actual AMD image configuration."""
        self.registry.root["manifests"][0]["platform"]["architecture"] = "arm64"
        with self.assertRaisesRegex(ValueError, "platform disagrees"):
            image.inspect_image(self.registry, SOURCE)

    def test_addon_label_must_match_actual_architecture(self):
        """Reject architecture metadata that disagrees with the executable image."""
        config = next(
            config
            for config in self.registry.configs.values()
            if config["architecture"] == "amd64"
        )
        config["config"]["Labels"]["io.hass.arch"] = "aarch64"
        with self.assertRaisesRegex(ValueError, "architecture.*disagree"):
            image.inspect_image(self.registry, SOURCE)

    def test_duplicate_digest_cannot_hide_a_forged_platform(self):
        """Validate a repeated payload descriptor instead of skipping it by digest."""
        self.registry.root["manifests"][1]["digest"] = self.registry.root["manifests"][
            0
        ]["digest"]
        with self.assertRaisesRegex(ValueError, "platform disagrees"):
            image.inspect_image(self.registry, SOURCE)

    def test_architecture_repository_cannot_contain_the_other_runtime(self):
        """Reject a multi-architecture image placed under a single-architecture name."""
        with self.assertRaisesRegex(ValueError, "unexpected runtime platforms"):
            image.inspect_image(
                self.registry,
                "ghcr.io/moryoav/amd64-whatsapp-addon@" + self.registry.root_digest,
            )

    def test_version_labels_must_agree(self):
        """Refuse an image that reports different add-on and OCI versions."""
        next(iter(self.registry.configs.values()))["config"]["Labels"][
            "io.hass.version"
        ] = "0.0.0"
        with self.assertRaisesRegex(ValueError, "version labels"):
            image.inspect_image(self.registry, SOURCE)

    def test_combined_image_cannot_mix_application_versions(self):
        """Refuse an index combining individually valid images from different releases."""
        labels = next(iter(self.registry.configs.values()))["config"]["Labels"]
        labels["io.hass.version"] = labels["org.opencontainers.image.version"] = "3.3.0"
        with self.assertRaisesRegex(ValueError, "versions differ"):
            image.inspect_image(self.registry, SOURCE)

    def test_default_variants_normalize_without_merging_other_variants(self):
        """Treat ARM v8 and AMD v1 as defaults while retaining nondefault variants."""
        self.assertEqual(
            image.normalized_platform(
                {"os": "linux", "architecture": "arm64", "variant": "v8"}
            ),
            "linux/arm64",
        )
        self.assertEqual(
            image.normalized_platform(
                {"os": "linux", "architecture": "amd64", "variant": "v1"}
            ),
            "linux/amd64",
        )
        self.assertEqual(
            image.normalized_platform(
                {"os": "linux", "architecture": "arm64", "variant": "v9"}
            ),
            "linux/arm64/v9",
        )

    def test_changed_runtime_payload_is_rejected(self):
        """Detect changes to configs, layers, manifest identity, architecture or version."""
        for field in (
            "config_digest",
            "manifest_digest",
            "layer_digests",
            "version",
            "addon_architecture",
        ):
            changed = copy.deepcopy(self.source)
            changed["platforms"]["linux/amd64"][field] = "different"
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(ValueError, "runtime"),
            ):
                image.compare_images(self.source, changed)

    def test_lost_or_changed_attestation_descriptor_is_rejected(self):
        """Require preserved provenance descriptors and their subject annotations."""
        for alteration in ("remove", "subject"):
            changed = copy.deepcopy(self.source)
            if alteration == "remove":
                changed["embedded_attestations"] = []
            else:
                changed["embedded_attestations"][0]["annotations"][
                    "vnd.docker.reference.digest"
                ] = "different"
            with (
                self.subTest(alteration=alteration),
                self.assertRaisesRegex(ValueError, "attestation"),
            ):
                image.compare_images(self.source, changed, same_root=False)

    def test_root_changes_require_an_explicit_comparison_mode(self):
        """Allow manifest-list restructuring only when requested by the caller."""
        changed = copy.deepcopy(self.source)
        changed["digest"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(ValueError, "root digest"):
            image.compare_images(self.source, changed)
        self.assertFalse(
            image.compare_images(self.source, changed, same_root=False)[
                "root_digest_equal"
            ]
        )

    def test_production_snapshot_detects_an_overwritten_tag(self):
        """Detect production tag movement while ignoring the snapshot capture clock."""
        before = image.production_snapshot(self.registry, "3.3.1")
        after = copy.deepcopy(before)
        after["captured_at"] = "another time"
        self.assertEqual(image.compare_snapshots(before, after)["references"], 6)
        after["images"][SOURCE]["digest"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(ValueError, "Production image references changed"):
            image.compare_snapshots(before, after)

    def test_empty_or_partial_snapshots_cannot_pass_the_production_guard(self):
        """Require all six real production references instead of accepting an empty report."""
        before = image.production_snapshot(self.registry, "3.3.1")
        for invalid in (
            {},
            {"version": "3.3.1", "images": {}},
            {"version": "3.3.1", "images": {SOURCE: self.source}},
        ):
            with (
                self.subTest(invalid=invalid),
                self.assertRaises((ValueError, KeyError)),
            ):
                image.compare_snapshots(before, invalid)


class ReadSafetyTests(unittest.TestCase):
    """Cover digest verification and credential handling without network requests."""

    def test_registry_response_must_match_requested_digest(self):
        """Reject a server returning different bytes for an immutable image reference."""
        client = image.RegistryClient()
        with (
            patch.object(client, "_token", return_value="synthetic-token"),
            patch.object(client, "_read", return_value=(b"{}", {})),
        ):
            with self.assertRaisesRegex(ValueError, "Requested content digest"):
                client.manifest("moryoav/whatsapp-addon", "sha256:" + "1" * 64)

    def test_registry_header_digest_is_verified(self):
        """Reject mismatched registry digest metadata even for mutable tags."""
        client = image.RegistryClient()
        with (
            patch.object(client, "_token", return_value="synthetic-token"),
            patch.object(
                client,
                "_read",
                return_value=(b"{}", {"Docker-Content-Digest": "sha256:" + "1" * 64}),
            ),
        ):
            with self.assertRaisesRegex(ValueError, "response digest"):
                client.manifest("moryoav/whatsapp-addon", "latest")

    def test_cross_origin_redirect_drops_authorization(self):
        """Keep the registry bearer token off a different blob-download host."""
        request = urllib.request.Request(
            "https://ghcr.io/v2/example/blobs/digest",
            headers={"Authorization": "Bearer synthetic-secret"},
        )
        redirected = image.SafeRedirectHandler().redirect_request(
            request, None, 307, "redirect", {}, "https://example.test/blob"
        )
        self.assertIsNone(redirected.get_header("Authorization"))

    def test_insecure_redirect_is_rejected(self):
        """Prevent authenticated registry downloads from being downgraded to HTTP."""
        request = urllib.request.Request("https://ghcr.io/v2/example/blobs/digest")
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            image.SafeRedirectHandler().redirect_request(
                request, None, 307, "redirect", {}, "http://example.test/blob"
            )

    def test_http_errors_do_not_include_authenticated_urls(self):
        """Redact a sensitive URL included in an underlying HTTP exception."""
        error = urllib.error.HTTPError(
            "https://example.test/?token=synthetic-secret",
            403,
            "secret",
            {},
            io.BytesIO(),
        )
        opener = SimpleNamespace(
            open=lambda *args, **kwargs: (_ for _ in ()).throw(error)
        )
        client = image.RegistryClient(opener=opener)
        with self.assertRaisesRegex(ValueError, "HTTP 403") as caught:
            client._read(urllib.request.Request("https://ghcr.io/token"))
        self.assertNotIn("synthetic-secret", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
