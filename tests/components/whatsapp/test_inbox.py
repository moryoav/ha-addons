"""Offline inbox lifecycle, service, and protocol validation tests."""

from __future__ import annotations

import asyncio
import re
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest
import yaml
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import CoreState
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.whatsapp import (
    WhatsappRuntimeData,
    async_setup,
    async_setup_entry,
)
from custom_components.whatsapp.client import (
    WhatsappApiError,
    WhatsappClient,
    WhatsappUnsupportedCapability,
    _valid_inbox_result,
)
from custom_components.whatsapp.inbox import WhatsappInbox

pytestmark = pytest.mark.enable_socket
SESSION = "a" * 32
REFERENCE = {"id": "b" * 64, "receipt": "c" * 64, "session": SESSION}
COUNTS = {"pending": 1, "processing": 0, "interrupted": 0, "blocked": 0}


def pending(session=SESSION):
    return {
        "status": "pending",
        "counts": dict(COUNTS),
        "attention": [],
        "message": {
            "clientId": "default",
            "key": {
                "id": "fictional-id",
                "remoteJid": "12025550123@s.whatsapp.net",
                "fromMe": False,
            },
            "message": {"conversation": "Fictional private content"},
            "inbox": {**REFERENCE, "session": session},
        },
    }


def api_client(result, status=200):
    response = SimpleNamespace(status=status, json=AsyncMock(return_value=result))
    session = SimpleNamespace(request=AsyncMock(return_value=response))
    return WhatsappClient(
        session, "http://addon:3000", api_token="fictional-token"
    ), session


@pytest.mark.parametrize(
    "operation,result,data",
    [
        ("open", {"status": "ready", "clients": ["default"]}, {"session": SESSION}),
        ("poll", pending(), {"session": SESSION}),
        ("start", {"started": True, "status": "processing"}, {"inbox": REFERENCE}),
        ("complete", {"status": "completed"}, {"inbox": REFERENCE}),
        ("resolve", {"status": "pending"}, {"inbox": REFERENCE, "resolution": "retry"}),
    ],
)
async def test_client_inbox_protocol(operation, result, data):
    client, session = api_client(result)
    assert await client.async_inbox(operation, data) == result
    args, kwargs = session.request.call_args
    assert args == ("POST", f"http://addon:3000/inbox/{operation}")
    assert kwargs["json"] == data
    assert kwargs["headers"]["Authorization"] == "Bearer fictional-token"


async def test_client_rejects_unsupported_and_invalid_protocol():
    client, _ = api_client({})
    with pytest.raises(ValueError):
        await client.async_inbox("anything", {})
    client._capabilities = frozenset()
    with pytest.raises(WhatsappUnsupportedCapability):
        await client.async_inbox("poll", {})
    client._capabilities = frozenset({"message_inbox"})
    with pytest.raises(WhatsappApiError, match="invalid inbox"):
        await client.async_inbox("poll", {})
    client, _ = api_client({"error": {"code": "inbox_session_changed"}}, 409)
    with pytest.raises(WhatsappApiError) as error:
        await client.async_inbox("poll", {"session": SESSION})
    assert error.value.code == "inbox_session_changed"


@pytest.mark.parametrize(
    "result",
    [
        None,
        [],
        {},
        {"status": {}},
        {"status": "unknown"},
        {"status": "empty", "counts": {"pending": True}},
        {"status": "empty", "counts": COUNTS},
        {"status": "processing", "counts": COUNTS, "inbox": {}},
        {"status": "pending", "counts": COUNTS, "message": []},
    ],
)
def test_malformed_poll_replies_are_refused(result):
    assert not _valid_inbox_result("poll", result, SESSION)


@pytest.mark.parametrize(
    "field,value",
    [
        ("clientId", "invalid/account"),
        ("message", []),
        ("key", {}),
        ("inbox", {**REFERENCE, "session": "d" * 32}),
    ],
)
def test_private_message_envelope_is_validated(field, value):
    result = pending()
    result["message"][field] = value
    assert not _valid_inbox_result("poll", result, SESSION)


@pytest.mark.parametrize(
    "key,value", [("fromMe", True), ("id", None), ("remoteJid", "")]
)
def test_invalid_origin_or_identity_is_refused(key, value):
    result = pending()
    result["message"]["key"][key] = value
    assert not _valid_inbox_result("poll", result, SESSION)


@pytest.mark.parametrize(
    "operation,result,expected",
    [
        ("open", {"status": "ready", "clients": ["../bad"]}, False),
        ("open", {"status": "ready", "clients": []}, True),
        ("start", {"started": True, "status": "completed"}, False),
        ("start", {"started": False, "status": "completed"}, True),
        ("complete", {"status": "pending"}, False),
        ("resolve", {"status": "completed"}, True),
        ("resolve", {"status": "interrupted"}, True),
        (
            "poll",
            {"status": "empty", "counts": dict.fromkeys(COUNTS, 0), "attention": []},
            True,
        ),
        (
            "poll",
            {
                "status": "preparing",
                "counts": COUNTS,
                "attention": [],
                "inbox": REFERENCE,
            },
            True,
        ),
    ],
)
def test_protocol_response_states(operation, result, expected):
    assert bool(_valid_inbox_result(operation, result, SESSION)) is expected


async def test_worker_waits_for_ha_start_and_preserves_message_metadata(hass):
    client = Mock(spec=WhatsappClient)
    worker = WhatsappInbox(hass, client)
    message = pending(worker.session)
    client.async_inbox = AsyncMock(
        side_effect=lambda operation, data: (
            {"status": "ready", "clients": ["default"]}
            if operation == "open"
            else deepcopy(message)
        )
    )
    events = []
    hass.bus.async_listen(
        "new_whatsapp_message", lambda event: events.append(event.data)
    )
    hass.state = CoreState.not_running
    worker.start()
    assert client.async_inbox.await_count == 0
    hass.state = CoreState.running
    hass.bus.async_fire(EVENT_HOMEASSISTANT_STARTED)
    await hass.async_block_till_done()
    assert events == [message["message"]]
    worker.stop()
    await asyncio.gather(worker._task, return_exceptions=True)
    worker.stop()


async def test_worker_can_be_unloaded_before_startup(hass):
    client = Mock(spec=WhatsappClient)
    client.async_inbox = AsyncMock()
    hass.state = CoreState.not_running
    worker = WhatsappInbox(hass, client)
    worker.start()
    worker.stop()
    hass.state = CoreState.running
    hass.bus.async_fire(EVENT_HOMEASSISTANT_STARTED)
    await hass.async_block_till_done()
    client.async_inbox.assert_not_awaited()


async def test_worker_announces_interruption_once_and_recovers_transient_failure(
    hass, caplog
):
    client = Mock(spec=WhatsappClient)
    worker = WhatsappInbox(hass, client)
    calls = 0

    async def request(operation, data):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise WhatsappApiError("Fictional private payload and credential")
        if operation == "open":
            return {"status": "ready", "clients": ["default"]}
        return {
            "status": "interrupted",
            "counts": COUNTS,
            "inbox": {**REFERENCE, "session": worker.session},
            "attention": [
                {
                    "inbox": {**REFERENCE, "session": worker.session},
                    "clientId": "default",
                    "status": "interrupted",
                    "reason": "processing_interrupted",
                }
            ],
        }

    client.async_inbox = AsyncMock(side_effect=request)
    events = []
    hass.bus.async_listen(
        "whatsapp_inbox_interrupted", lambda event: events.append(event.data)
    )
    with patch("custom_components.whatsapp.inbox.POLL_SECONDS", 0.01):
        task = asyncio.create_task(worker._run())
        for _ in range(100):
            if len(events) == 1 and calls >= 4:
                break
            await asyncio.sleep(0.01)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert len(events) == 1
    assert "Fictional private" not in caplog.text


async def test_worker_reopens_after_a_restored_app_snapshot_changes_session(hass):
    client = Mock(spec=WhatsappClient)
    worker = WhatsappInbox(hass, client)
    operations = []

    async def request(operation, data):
        operations.append(operation)
        if operations == ["open", "poll"]:
            raise WhatsappApiError("replaced", code="inbox_session_changed")
        return (
            {"status": "ready", "clients": ["default"]}
            if operation == "open"
            else pending(worker.session)
        )

    client.async_inbox = AsyncMock(side_effect=request)
    events = []
    hass.bus.async_listen(
        "new_whatsapp_message", lambda event: events.append(event.data)
    )
    with patch("custom_components.whatsapp.inbox.POLL_SECONDS", 0.01):
        task = asyncio.create_task(worker._run())
        for _ in range(100):
            if events:
                break
            await asyncio.sleep(0.01)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert operations[:4] == ["open", "poll", "open", "poll"]
    assert len(events) == 1


async def test_setup_entry_starts_only_capability_supported_worker(
    hass, enable_custom_integrations
):
    entry = MockConfigEntry(
        domain="whatsapp",
        state=ConfigEntryState.SETUP_IN_PROGRESS,
        data={"url": "http://addon:3000"},
    )
    entry.add_to_hass(hass)
    with (
        patch("custom_components.whatsapp.WhatsappClient") as constructor,
        patch.object(hass.config_entries, "async_forward_entry_setups", AsyncMock()),
    ):
        constructor.return_value.capabilities = {"message_inbox"}
        constructor.return_value.async_health = AsyncMock(return_value={"status": "ok"})
        assert await async_setup_entry(hass, entry)
    assert isinstance(entry.runtime_data.inbox, WhatsappInbox)
    entry.runtime_data.inbox.stop()


async def test_acknowledgement_services_pass_only_reference_and_wake_worker(
    hass, enable_custom_integrations
):
    await async_setup(hass, {})
    entry = MockConfigEntry(domain="whatsapp", data={"url": "http://addon:3000"})
    entry.add_to_hass(hass)
    client = Mock(spec=WhatsappClient)
    worker = Mock(spec=WhatsappInbox)
    worker.session = SESSION
    entry.runtime_data = WhatsappRuntimeData(client=client, inbox=worker)
    for action, operation, data, reply in [
        ("get_inbox", "poll", {}, pending()),
        (
            "start_inbox_message",
            "start",
            {"inbox": REFERENCE},
            {"started": True, "status": "processing"},
        ),
        (
            "complete_inbox_message",
            "complete",
            {"inbox": REFERENCE},
            {"status": "completed"},
        ),
        (
            "resolve_inbox_message",
            "resolve",
            {"inbox": REFERENCE, "resolution": "discard"},
            {"status": "completed"},
        ),
    ]:
        client.async_inbox = AsyncMock(return_value=reply)
        result = await hass.services.async_call(
            "whatsapp", action, data, blocking=True, return_response=True
        )
        assert result == reply
        client.async_inbox.assert_awaited_once_with(
            operation,
            {"session": SESSION, "inspect": True} if action == "get_inbox" else data,
        )
    assert worker.wake.call_count == 3
    client.async_inbox = AsyncMock(
        side_effect=WhatsappApiError("Fictional secret", code="inbox_message_not_found")
    )
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call(
            "whatsapp",
            "start_inbox_message",
            {"inbox": REFERENCE},
            blocking=True,
            return_response=True,
        )


async def test_disabled_inbox_refuses_actions(hass, enable_custom_integrations):
    await async_setup(hass, {})
    with pytest.raises(ServiceValidationError) as error:
        await hass.services.async_call(
            "whatsapp", "get_inbox", {}, blocking=True, return_response=True
        )
    assert error.value.translation_key == "inbox_disabled"
    assert error.value.translation_domain == "whatsapp"


async def test_delivery_is_bounded_despite_frequent_hints_and_elapsed_days(hass):
    worker = WhatsappInbox(hass, Mock(spec=WhatsappClient))
    message = pending(worker.session)
    events = []
    hass.bus.async_listen(
        "new_whatsapp_message", lambda event: events.append(event.data)
    )
    with patch("custom_components.whatsapp.inbox.monotonic") as now:
        for seconds in [0] * 100 + [20, 40, 60, 86400, 864000]:
            now.return_value = seconds
            worker._handle_result(message)
    await hass.async_block_till_done()
    assert len(events) == 3


async def test_attention_is_visible_once_per_item_and_does_not_hide_deliverable_messages(
    hass, caplog
):
    worker = WhatsappInbox(hass, Mock(spec=WhatsappClient))
    result = pending(worker.session)
    result["attention"] = [
        {
            "inbox": {**REFERENCE, "id": "d" * 64, "session": worker.session},
            "clientId": "other",
            "status": "blocked",
            "reason": "unclaimed",
        }
    ]
    attention_events = []
    messages = []
    hass.bus.async_listen(
        "whatsapp_inbox_attention", lambda event: attention_events.append(event.data)
    )
    hass.bus.async_listen(
        "new_whatsapp_message", lambda event: messages.append(event.data)
    )
    with (
        patch(
            "custom_components.whatsapp.inbox.persistent_notification.async_create"
        ) as create,
        patch(
            "custom_components.whatsapp.inbox.persistent_notification.async_dismiss"
        ) as dismiss,
    ):
        worker._handle_result(result)
        worker._handle_result(result)
        await hass.async_block_till_done()
        assert len(attention_events) == 1
        assert len(messages) == 1
        create.assert_called_once()
        assert "Fictional private" not in str(create.call_args)
        result["attention"] = []
        worker._handle_result(result)
        dismiss.assert_called_once_with(hass, "whatsapp_inbox_attention")
    assert "Fictional private" not in caplog.text


@pytest.mark.parametrize("status", ["blocked", "interrupted"])
@pytest.mark.parametrize(
    "field,value",
    [
        ("reason", {}),
        ("status", []),
        ("clientId", "../account"),
        ("inbox", {}),
        ("reason", "private/unexpected reason"),
    ],
)
def test_malformed_attention_is_rejected_without_raising(status, field, value):
    result = pending()
    item = {
        "inbox": REFERENCE,
        "clientId": "default",
        "status": status,
        "reason": "unclaimed",
    }
    item[field] = value
    result["attention"] = [item]
    assert not _valid_inbox_result("poll", result, SESSION)


@pytest.mark.parametrize(
    "case", ["success", "ignored", "failed_action", "failed_ack", "legacy", "duplicate"]
)
async def test_documented_automation_runs_real_scripts_and_handles_failures(
    hass, enable_custom_integrations, case
):
    """Exercise the published YAML through HA, including its actual error semantics."""
    document = (
        Path(__file__).parents[3] / "docs/examples/reliable-incoming-messages.md"
    ).read_text()
    blocks = re.findall(r"```yaml\n(.*?)```", document, re.DOTALL)
    script_config, automation_config = [yaml.safe_load(block) for block in blocks[:2]]
    await async_setup(hass, {})
    entry = MockConfigEntry(domain="whatsapp", data={"url": "http://addon:3000"})
    entry.add_to_hass(hass)
    client = Mock(spec=WhatsappClient)
    worker = Mock(spec=WhatsappInbox)
    worker.session = SESSION
    entry.runtime_data = WhatsappRuntimeData(client=client, inbox=worker)
    calls = []
    started = False

    async def inbox_request(operation, data):
        nonlocal started
        calls.append((operation, data))
        if operation == "start":
            was_started = started
            started = True
            return {"started": not was_started, "status": "processing"}
        if operation == "complete":
            if case == "failed_ack":
                raise WhatsappApiError(
                    "Fictional failure", code="inbox_storage_unavailable"
                )
            return {"status": "completed"}
        return {"status": "interrupted"}

    client.async_inbox = AsyncMock(side_effect=inbox_request)

    async def send_message(call):
        calls.append(("send", dict(call.data)))
        if case == "failed_action":
            raise HomeAssistantError("Fictional send failure")

    hass.services.async_register("whatsapp", "send_message", send_message)
    hass.state = CoreState.running
    assert await async_setup_component(hass, "script", {"script": script_config})
    assert await async_setup_component(
        hass, "automation", {"automation": [automation_config]}
    )
    message = pending()["message"]
    if case == "ignored":
        message["key"]["remoteJid"] = "12025550124@s.whatsapp.net"
    if case == "legacy":
        del message["inbox"]
        message["inbox_error"] = "inbox_full"
    hass.bus.async_fire("new_whatsapp_message", message)
    if case == "duplicate":
        hass.bus.async_fire("new_whatsapp_message", message)
    await hass.async_block_till_done()
    operations = [item[0] for item in calls]
    if case == "ignored":
        assert operations == ["start", "complete"]
    elif case == "failed_action":
        assert operations == ["start", "send", "resolve"]
        assert calls[-1][1]["resolution"] == "hold"
    elif case == "legacy":
        assert operations == ["send"]
    else:
        assert operations.count("start") == (2 if case == "duplicate" else 1)
        assert operations.count("send") == 1
        assert operations.count("complete") == 1


async def test_first_healthy_poll_clears_notifications_left_before_ha_restarted(hass):
    worker = WhatsappInbox(hass, Mock(spec=WhatsappClient))
    worker._deliveries[(REFERENCE["id"], REFERENCE["receipt"])] = (3, 1)
    with patch(
        "custom_components.whatsapp.inbox.persistent_notification.async_dismiss"
    ) as dismiss:
        worker._handle_result(
            {"status": "empty", "counts": dict.fromkeys(COUNTS, 0), "attention": []}
        )
        dismiss.assert_called_once_with(hass, "whatsapp_inbox_attention")
    assert not worker._deliveries


@pytest.mark.parametrize(
    "counts",
    [
        {**COUNTS, "pending": True},
        {**COUNTS, "pending": -1},
        {**COUNTS, "pending": 1001},
        {**COUNTS, "extra": 0},
        {**COUNTS, "blocked": 1},
        {**COUNTS, "interrupted": 1},
    ],
)
def test_poll_counts_must_be_bounded_and_match_held_references(counts):
    result = pending()
    result["counts"] = counts
    assert not _valid_inbox_result("poll", result, SESSION)
