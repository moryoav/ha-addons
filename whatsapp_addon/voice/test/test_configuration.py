"""Configuration preflight and credential selection use only synthetic files and HTTP."""
import asyncio
from contextlib import asynccontextmanager
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch

BRIDGE = Path(__file__).parents[1] / "bridge"
sys.path.insert(0, str(BRIDGE))
spec = importlib.util.spec_from_file_location("configuration_bridge", BRIDGE / "bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConfigurationTests(unittest.IsolatedAsyncioTestCase):
    async def run_protocol(self, allowed, failure=None):
        commands = [
            {"action": "configure", "id": 1, "options": {"agent_id": "conversation.synthetic_agent"}},
            {"action": "shutdown", "id": 2},
        ]
        reader = types.SimpleNamespace(readline=AsyncMock(side_effect=[json.dumps(c).encode() + b"\n" for c in commands] + [b""]))
        transport = Mock()
        fake = types.SimpleNamespace(
            load_key=Mock(), ha_token="synthetic-ha-token", task=lambda coro: coro.close(),
            status_writer=AsyncMock(), preflight=AsyncMock(side_effect=failure, return_value={"agent_service": "conversation.process", "openai_key_source": "selected_agent"}), shutdown=AsyncMock(),
        )
        loop = asyncio.get_running_loop()
        with patch.object(module.asyncio, "StreamReader", return_value=reader), \
             patch.object(module.asyncio, "StreamReaderProtocol"), \
             patch.object(loop, "connect_read_pipe", new=AsyncMock(return_value=(transport, None))), \
             patch.object(module, "Bridge", return_value=fake) as constructor, \
             patch.object(module.aiohttp, "ClientSession"), \
             patch.object(module, "emit") as output:
            if allowed and not failure:
                await module.serve(allowed)
                self.assertEqual(output.call_args_list[1].args[0], {"type": "response", "id": 1, "ok": True, "result": {"agent_service": "conversation.process", "openai_key_source": "selected_agent"}})
                fake.preflight.assert_awaited_once()
                fake.load_key.assert_called_once()
            else:
                with self.assertRaises(ValueError):
                    await module.serve(allowed)
                self.assertEqual(output.call_count, 1, "No successful configuration ACK may be emitted")
                if not allowed:
                    constructor.assert_not_called()
            transport.close.assert_called_once()

    async def test_configuration_ack_follows_successful_agent_preflight(self):
        await self.run_protocol(True)

    async def test_failed_agent_preflight_never_acknowledges_configuration(self):
        await self.run_protocol(True, ValueError("synthetic agent unavailable"))

    async def test_disabled_network_gate_never_reads_credentials(self):
        await self.run_protocol(False)

    async def test_ha_preflight_has_short_timeout_and_delegation_retains_long_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = module.Bridge({}, directory)
            requests = []

            @asynccontextmanager
            async def request(method, url, **options):
                requests.append((method, options["timeout"].total))
                yield types.SimpleNamespace(raise_for_status=lambda: None, json=AsyncMock(return_value={}))

            bridge.http = types.SimpleNamespace(request=request)
            await bridge.ha("/states/conversation.synthetic_agent")
            await bridge.ha("/services/conversation/process", {"text": "Synthetic request"})
            self.assertEqual(requests, [("GET", 10), ("POST", 620)])

    async def test_openai_key_requires_a_registered_selected_agent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".storage").mkdir()
            entries = [{"entry_id": "only", "domain": "openai_conversation", "title": "Only OpenAI", "data": {"api_key": "synthetic-key"}}]
            (root / ".storage/core.config_entries").write_text(json.dumps({"data": {"entries": entries}}))
            bridge = module.Bridge({"agent_id": "conversation.unregistered", "openai_entry_title": "Only OpenAI"}, root / "metrics", root)
            with self.assertRaises(ValueError):
                bridge.load_key()
            self.assertIsNone(bridge.key)
            self.write_registry(root, entries)
            with self.assertRaises(ValueError):
                bridge.load_key()
            self.assertIsNone(bridge.key)

    async def test_ambiguous_agent_ownership_never_selects_an_arbitrary_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entries = [{"entry_id": name, "domain": "openai_conversation", "data": {"api_key": "synthetic-" + name}}
                       for name in ("first", "second")]
            entities = [{"entity_id": "conversation.selected", "config_entry_id": name} for name in ("first", "second")]
            self.write_registry(root, entries, entities)
            bridge = module.Bridge({"agent_id": "conversation.selected"}, root / "metrics", root)
            with self.assertRaises(ValueError):
                bridge.load_key()
            self.assertIsNone(bridge.key)

    def write_registry(self, root, entries, entities=()):
        (root / ".storage").mkdir(exist_ok=True)
        (root / ".storage/core.config_entries").write_text(json.dumps({"data": {"entries": entries}}))
        (root / ".storage/core.entity_registry").write_text(json.dumps({"data": {"entities": list(entities)}}))

    async def test_selected_agent_key_wins_with_multiple_openai_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entries = [{"entry_id": title, "domain": "openai_conversation", "title": title,
                        "data": {"api_key": "synthetic-key-" + title}} for title in ("first", "second")]
            self.write_registry(root, entries, [{"entity_id": "conversation.selected", "config_entry_id": "second"}])
            bridge = module.Bridge({"agent_id": "conversation.selected"}, root / "metrics", root)
            bridge.load_key()
            self.assertEqual(bridge.key, "synthetic-key-second")
            self.assertEqual(bridge.key_source, "selected_agent")
            bridge.options["openai_entry_title"] = "first"
            bridge.load_key()
            self.assertEqual(bridge.key, "synthetic-key-second", "An obsolete override must not redirect the key")
            self.assertEqual(bridge.key_source, "selected_agent")
            bridge.options["openai_entry_title"] = "missing"
            bridge.load_key()
            self.assertEqual(bridge.key, "synthetic-key-second")

    async def test_selected_agent_with_missing_key_never_uses_another_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_registry(root, [
                {"entry_id": "selected", "domain": "openai_conversation", "data": {}},
                {"entry_id": "other", "domain": "openai_conversation", "data": {"api_key": "synthetic-other-key"}},
            ], [{"entity_id": "conversation.selected", "config_entry_id": "selected"}])
            bridge = module.Bridge({"agent_id": "conversation.selected"}, root / "metrics", root)
            bridge.key = "synthetic-stale-key"
            with self.assertRaises(ValueError):
                bridge.load_key()
            self.assertIsNone(bridge.key)

    async def test_other_agent_providers_are_rejected_even_with_a_single_openai_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entries = [{"entry_id": "other-provider", "domain": "synthetic_provider"},
                       {"entry_id": "openai", "domain": "openai_conversation", "title": "Synthetic OpenAI", "data": {"api_key": "synthetic-key"}}]
            entities = [{"entity_id": "conversation.selected", "config_entry_id": "other-provider"}]
            self.write_registry(root, entries, entities)
            bridge = module.Bridge({"agent_id": "conversation.selected"}, root / "metrics", root)
            with self.assertRaisesRegex(ValueError, "OpenAI integration"):
                bridge.load_key()
            self.assertIsNone(bridge.key)
            entries.append({"entry_id": "another", "domain": "openai_conversation", "title": "Another", "data": {"api_key": "synthetic-another-key"}})
            self.write_registry(root, entries, entities)
            with self.assertRaises(ValueError):
                module.Bridge({"agent_id": "conversation.selected"}, root / "metrics", root).load_key()

    async def test_standard_service_is_used_even_when_a_guard_and_legacy_override_exist(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = module.Bridge({"agent_id": "conversation.selected", "agent_service": "whatsapp_conversation_guard.process"}, directory)
            bridge.ha = AsyncMock(side_effect=[{"state": "ready"}, [
                {"domain": "conversation", "services": {"process": {}}},
                {"domain": "whatsapp_conversation_guard", "services": {"process": {}}},
            ]])
            result = await bridge.preflight()
            self.assertEqual(result["agent_service"], "conversation.process")
            self.assertEqual(bridge.ha.await_args_list[1].args, ("/services",))
            bridge.options["agent_service"] = "unknown.process"
            bridge.ha = AsyncMock(side_effect=[{"state": "ready"}, [{"domain": "conversation", "services": {"process": {}}}]])
            await bridge.preflight()
            self.assertEqual(bridge.ha.await_args_list[1].args, ("/services",))

    async def test_standard_service_preflight_does_not_hide_discovery_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = module.Bridge({"agent_id": "conversation.selected"}, directory)
            bridge.ha = AsyncMock(side_effect=[{"state": "ready"}, [{"domain": "conversation", "services": {"process": {}}}]])
            self.assertEqual((await bridge.preflight())["agent_service"], "conversation.process")
            bridge.ha = AsyncMock(side_effect=[{"state": "ready"}, ValueError("Synthetic lookup failed")])
            with self.assertRaises(ValueError):
                await bridge.preflight()
            bridge.ha = AsyncMock(side_effect=[{"state": "ready"}, [{"domain": "whatsapp_conversation_guard", "services": {"process": {}}}]])
            with self.assertRaisesRegex(ValueError, "conversation.process"):
                await bridge.preflight()

    async def test_unavailable_agent_or_missing_services_never_passes_preflight(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = module.Bridge({"agent_id": "conversation.selected"}, directory)
            bridge.ha = AsyncMock(return_value={"state": "unavailable"})
            with self.assertRaises(ValueError):
                await bridge.preflight()
            bridge.ha.assert_awaited_once()
            bridge.ha = AsyncMock(side_effect=[{"state": "ready"}, []])
            with self.assertRaises(ValueError):
                await bridge.preflight()

    async def test_an_unused_agent_with_unknown_last_activity_can_still_receive_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = module.Bridge({"agent_id": "conversation.selected"}, directory)
            bridge.ha = AsyncMock(side_effect=[{"state": "unknown"}, [{"domain": "conversation", "services": {"process": {}}}]])
            self.assertEqual((await bridge.preflight())["agent_service"], "conversation.process")
            self.assertEqual(bridge.ha.await_count, 2)
