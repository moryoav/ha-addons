"""Check configuration help with the paths produced by nested HA forms."""

from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).parents[2]


def resolve(entries, name, path):
    """Match the Supervisor frontend's configuration translation lookup."""
    for group in path:
        entries = entries.get(group, {}).get("fields", {})
    return entries.get(name)


def expandable(callback, name, *, parent_first=False):
    """Model HA's expandable callback, which appends its name to the path.

    Each containing form wraps the callback again, so the current frontend
    passes inner groups first. Also check the outer-first path used by a
    frontend that propagates the parent context before descending.
    """

    def compute(field, path=()):
        nested = (name, *path) if parent_first else (*path, name)
        return callback(field, nested)

    return compute


class ConfigurationLabelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = yaml.safe_load((ROOT / "config.yaml").read_text(encoding="utf-8"))
        cls.labels = yaml.safe_load(
            (ROOT / "translations/en.yaml").read_text(encoding="utf-8")
        )["configuration"]

    def test_every_visible_field_and_group_has_english_label_and_help(self):
        def check(schema, labels):
            for name, value in schema.items():
                with self.subTest(field=name):
                    entry = labels[name]
                    self.assertTrue(entry["name"].strip())
                    self.assertNotIn("_", entry["name"])
                    self.assertTrue(entry["description"].strip())
                    if isinstance(value, dict):
                        check(value, entry["fields"])

        check(self.config["schema"], self.labels)

    def test_nested_form_callbacks_resolve_identical_labels_and_help(self):
        canonical = self.labels["voice_calls"]["fields"]["advanced"]["fields"]
        def lookup(field, path):
            return resolve(self.labels, field, path)

        for parent_first in (False, True):
            voice = expandable(lookup, "voice_calls", parent_first=parent_first)
            advanced = expandable(voice, "advanced", parent_first=parent_first)
            for name in self.config["schema"]["voice_calls"]["advanced"]:
                with self.subTest(field=name, parent_first=parent_first):
                    self.assertEqual(advanced(name), canonical[name])


if __name__ == "__main__":
    unittest.main()
