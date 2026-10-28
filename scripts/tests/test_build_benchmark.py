"""Check benchmark isolation and the controlled architecture/case matrix."""

import os
import base64
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import build_benchmark as benchmark


class BenchmarkPlanTests(unittest.TestCase):
    """Reject uncontrolled experiments and retain exactly one changed input per probe."""

    def test_complete_source_sha_is_required(self):
        """Refuse branch names, abbreviated commits, and workflow-command input."""
        for source in ["main", "6885e1c", "A" * 40, "a" * 40 + "\nother=value", "a" * 39]:
            with self.subTest(source=source):
                with self.assertRaises(ValueError):
                    benchmark.plan(source, "amd64", "probe")

    def test_architecture_and_suite_are_bounded(self):
        """Keep architecture selection and the dependencies-only suite explicit."""
        for architecture, suite in [("armhf", "probe"), ("amd64", "release"), ("../amd64", "probe")]:
            with self.subTest(architecture=architecture, suite=suite):
                with self.assertRaises(ValueError):
                    benchmark.plan("a" * 40, architecture, suite)

    def test_cases_only_read_production_caches(self):
        """Never generate a cache export or image-publishing destination."""
        cases = benchmark.plan("a" * 40, "both", "probe")["include"]
        self.assertEqual(len(cases), 10)
        for entry in cases:
            with self.subTest(arch=entry["arch"], case=entry["case"]):
                self.assertEqual(set(entry), {"arch", "runner", "case", "pull", "platforms", "cache_from"})
                self.assertIn(f"type=gha,scope={entry['arch']}-rust", entry["cache_from"])
                self.assertEqual("type=registry" in entry["cache_from"], entry["case"] == "release-inline")
                if entry["case"] == "release-inline":
                    self.assertIn(benchmark.PRODUCTION_INLINE_BASELINE[entry["arch"]], entry["cache_from"])
                    self.assertNotIn(":latest", entry["cache_from"])

    def test_each_case_uses_the_same_native_runner(self):
        """Vary only pull, explicit platform, and the documented inline fallback."""
        for arch, (platform, runner) in benchmark.ARCHITECTURES.items():
            cases = {entry["case"]: entry for entry in benchmark.plan("a" * 40, arch, "probe")["include"]}
            self.assertEqual({entry["runner"] for entry in cases.values()}, {runner})
            self.assertEqual(cases["ci-control"]["platforms"], platform)
            self.assertFalse(cases["ci-control"]["pull"])
            self.assertTrue(cases["pull-explicit"]["pull"])
            self.assertEqual(cases["release-like"]["platforms"], "")
            self.assertTrue(cases["release-like"]["pull"])
            self.assertFalse(cases["native-default"]["pull"])

    def test_action_outputs_cannot_inject_another_output(self):
        """Reject multiline output values before opening GitHub's output file."""
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "outputs"
            with patch.dict(os.environ, {"GITHUB_OUTPUT": str(target)}):
                with self.assertRaises(ValueError):
                    benchmark.output("source_sha", "a\nproduction=value")
                self.assertFalse(target.exists())
                benchmark.output("source_sha", "a" * 40)
                self.assertEqual(target.read_text(), "source_sha=" + "a" * 40 + "\n")

    def test_workflow_has_no_publication_or_cache_export_capability(self):
        """Keep probe permissions read-only and full publishing behind the guarded tag."""
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/build-benchmark.yaml").read_text()
        probe = workflow.split("\n  probe:", 1)[1].split("\n  full:", 1)[0]
        full = workflow.split("\n  full:", 1)[1]
        self.assertNotRegex(workflow, r"(?m)^\s*cache-to:")
        self.assertNotIn("packages: write", probe)
        self.assertNotIn("id-token: write", probe)
        self.assertNotIn("home-assistant/builder/actions/build-image", workflow)
        self.assertNotIn("workflow_call:", workflow)
        self.assertIn("push: false", probe)
        self.assertIn("outputs: type=cacheonly", probe)
        self.assertIn("target: dependencies", probe)
        self.assertIn("tags: ${{ steps.prepare.outputs.image }}", full)
        self.assertIn("--certificate-identity", full)
        self.assertIn("source/whatsapp_addon/voice/test/image-tests.ps1", full)

    def test_full_matrix_repeats_both_gha_only_cases_on_fresh_jobs(self):
        """Cover both architectures twice without importing the offending inline cache."""
        cases = benchmark.plan("a" * 40, "both", "full")["include"]
        self.assertEqual(len(cases), 8)
        self.assertEqual({(entry["arch"], entry["case"], entry["repeat"]) for entry in cases}, {
            (arch, case, repeat) for arch in benchmark.ARCHITECTURES
            for case in ("rust-only", "gha-combined") for repeat in (1, 2)
        })
        for entry in cases:
            self.assertTrue(entry["pull"])
            self.assertEqual(entry["platforms"], "")
            self.assertNotIn("type=registry", entry["cache_from"])
            self.assertIn(f"type=gha,scope={entry['arch']}-rust", entry["cache_from"])
            self.assertEqual(f"type=gha,scope={entry['arch']}\n" in entry["cache_from"], entry["case"] == "gha-combined")

    def test_full_outputs_reject_production_tags_and_uncontrolled_names(self):
        """Permit only run-specific tags in architecture-specific benchmark repositories."""
        image = benchmark.full_destination("12345", "1", "amd64", "gha-combined", 2)
        self.assertEqual(image, "ghcr.io/moryoav/amd64-whatsapp-addon-bench:run-12345-1-gha-combined-repeat-2")
        for run_id, attempt, arch, case, repeat in [
            ("latest", "1", "amd64", "rust-only", 1),
            ("123", "latest", "amd64", "rust-only", 1),
            ("123", "1", "multi", "rust-only", 1),
            ("123", "1", "amd64", "release-inline", 1),
            ("123", "1", "amd64", "rust-only", 3),
        ]:
            with self.subTest(run_id=run_id, attempt=attempt, arch=arch, case=case, repeat=repeat):
                with self.assertRaises(ValueError):
                    benchmark.full_destination(run_id, attempt, arch, case, repeat)

    def test_phase_markers_are_write_once(self):
        """Avoid silently changing the timing boundaries of an already recorded phase."""
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)
            benchmark.mark(target, "build-start")
            with self.assertRaises(ValueError):
                benchmark.mark(target, "build-start")
            with self.assertRaises(ValueError):
                benchmark.mark(target, "production")

    def test_diagnostics_redact_tokens_but_keep_cache_digests(self):
        """Remove raw credentials and signed query secrets without losing SHA evidence."""
        digest = "sha256:" + "a" * 64
        raw = (
            f"{digest} jwt=eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl "
            "github=ghp_synthetic123 oauth=gho_synthetic456 pat=github_pat_synthetic789 "
            "url=https://example.invalid/blob?sig=private1&token=private2&hmac=private3&other=ok "
            "known=synthetic-known-secret"
        )
        with patch.dict(os.environ, {"ACTIONS_RUNTIME_TOKEN": "synthetic-known-secret"}):
            safe = benchmark.sanitize_text(raw)
        for secret in ["eyJhbGci", "ghp_synthetic123", "gho_synthetic456", "github_pat_synthetic789", "private1", "private2", "private3", "synthetic-known-secret"]:
            self.assertNotIn(secret, safe)
        self.assertIn(digest, safe)
        self.assertIn("other=ok", safe)

    def test_encoded_frames_are_only_changed_for_credentials(self):
        """Retain exact hash-frame bytes unless a credential requires redaction."""
        clean = base64.b64encode(b'buildkit.source.v0:sha256:abc123').decode()
        secret = base64.b64encode(b'attrs token=ghs_synthetic123').decode()
        result = benchmark.sanitize_data({"data": clean, "nested": [{"Data": secret}]})
        self.assertEqual(result["data"], clean)
        self.assertEqual(base64.b64decode(result["nested"][0]["Data"]), b'attrs token=[REDACTED]')

    def test_cache_dump_policy_accepts_empty_local_store_only(self):
        """Distinguish a legitimate unused store from missing hash-frame evidence."""
        self.assertEqual(benchmark.parse_cache_dump("[]", "store", after_probe=True), [])
        self.assertIsNone(benchmark.parse_cache_dump("null", "store", after_probe=True))
        self.assertEqual(benchmark.parse_cache_dump('[{"digest":"sha256:abc"}]', "all", after_probe=True), [{"digest": "sha256:abc"}])
        self.assertIsNone(benchmark.parse_cache_dump("null", "all"))
        for contents, endpoint in [("[]", "all"), ("null", "all"), ("<html>not JSON</html>", "store"), ("{}", "store")]:
            with self.subTest(contents=contents, endpoint=endpoint):
                with self.assertRaises(ValueError):
                    benchmark.parse_cache_dump(contents, endpoint, after_probe=True)


if __name__ == "__main__":
    unittest.main()
