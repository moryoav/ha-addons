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
from homeassistant.core import Context, CoreState
from homeassistant.exceptions import (
    HomeAssistantError,
    ServiceValidationError,
    Unauthorized,
)
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry, MockUser

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
        (
            "resolve_many",
            {"status": "resolved", "resolved": 3, "resolution": "discard"},
            {
                "session": SESSION,
                "clientId": "default",
                "reason": "unclaimed",
                "resolution": "discard",
            },
        ),
        ("recover", {"status": "ready", "clients": ["default"]}, {"mode": "reload"}),
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
    polls = 0

    async def request(operation, data):
        nonlocal calls, polls
        calls += 1
        if calls == 1:
            raise WhatsappApiError("Fictional private payload and credential")
        if operation == "open":
            return {"status": "ready", "clients": ["default"]}
        polls += 1
        if polls == 1:
            return {
                "status": "empty",
                "counts": dict.fromkeys(COUNTS, 0),
                "attention": [],
            }
        return {
            "status": "interrupted",
            "counts": {"pending": 0, "processing": 0, "interrupted": 1, "blocked": 0},
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
        worker._handle_result(
            {"status": "empty", "counts": dict.fromkeys(COUNTS, 0), "attention": []}
        )
        dismiss.reset_mock()
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
    "case",
    [
        "success",
        "ignored",
        "failed_action",
        "failed_ack",
        "legacy",
        "duplicate",
        "superseded",
    ],
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
            if case == "superseded":
                return {"started": False, "status": "pending"}
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
    elif case == "superseded":
        assert operations == ["start"]
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


@pytest.mark.parametrize(
    "operation,result",
    [
        (
            "resolve_many",
            {"status": "resolved", "resolved": True, "resolution": "discard"},
        ),
        (
            "resolve_many",
            {"status": "resolved", "resolved": 1001, "resolution": "discard"},
        ),
        ("resolve_many", {"status": "resolved", "resolved": 1, "resolution": "hold"}),
        ("recover", {"status": "ready", "clients": [], "archive": "../private.json"}),
        ("recover", {"status": "ready", "clients": [], "archive": []}),
        ("recover", {"status": "ready", "clients": ["../account"]}),
    ],
)
def test_recovery_protocol_rejects_malformed_or_unsafe_replies(operation, result):
    assert not _valid_inbox_result(operation, result, SESSION)


async def test_bulk_and_storage_recovery_services_are_scoped_and_wake_delivery(
    hass, enable_custom_integrations
):
    await async_setup(hass, {})
    entry = MockConfigEntry(domain="whatsapp", data={"url": "http://addon:3000"})
    entry.add_to_hass(hass)
    client = Mock(spec=WhatsappClient)
    worker = Mock(spec=WhatsappInbox)
    worker.session = SESSION
    entry.runtime_data = WhatsappRuntimeData(client=client, inbox=worker)
    client.async_inbox = AsyncMock(
        return_value={"status": "resolved", "resolved": 1000, "resolution": "discard"}
    )
    reply = await hass.services.async_call(
        "whatsapp",
        "resolve_inbox_messages",
        {
            "resolution": "discard",
            "reason": "unclaimed",
            "client_id": "default",
        },
        blocking=True,
        return_response=True,
    )
    assert reply["resolved"] == 1000
    client.async_inbox.assert_awaited_once_with(
        "resolve_many",
        {
            "resolution": "discard",
            "reason": "unclaimed",
            "clientId": "default",
            "session": SESSION,
        },
    )
    client.async_inbox.reset_mock()
    with pytest.raises(ServiceValidationError) as err:
        await hass.services.async_call(
            "whatsapp",
            "resolve_inbox_messages",
            {"resolution": "discard"},
            blocking=True,
            return_response=True,
        )
    assert err.value.translation_key == "inbox_filter_required"
    client.async_inbox.assert_not_awaited()
    client.async_inbox = AsyncMock(
        return_value={"status": "ready", "clients": ["default"]}
    )
    with patch(
        "custom_components.whatsapp.persistent_notification.async_dismiss"
    ) as dismiss:
        await hass.services.async_call(
            "whatsapp", "recover_inbox", {}, blocking=True, return_response=True
        )
        dismiss.assert_called_once_with(hass, "whatsapp_inbox_storage")
    client.async_inbox.assert_awaited_once_with("recover", {"mode": "reload"})
    assert worker.wake.call_count == 2


@pytest.mark.parametrize(
    "action,data",
    [
        ("recover_inbox", {"mode": "reload"}),
        ("recover_inbox", {"mode": "reset"}),
        ("resolve_inbox_messages", {"resolution": "discard", "reason": "unclaimed"}),
        ("resolve_inbox_messages", {"resolution": "retry", "client_id": "default"}),
    ],
)
async def test_bulk_and_recovery_require_admin_but_allow_unattended_automations(
    hass, enable_custom_integrations, hass_admin_user, action, data
):
    """Reject household-user calls before the app can change any inbox state."""
    await async_setup(hass, {})
    entry = MockConfigEntry(domain="whatsapp", data={"url": "http://addon:3000"})
    entry.add_to_hass(hass)
    client = Mock(spec=WhatsappClient)
    client.async_inbox = AsyncMock(return_value={"status": "ready", "clients": []})
    worker = Mock(spec=WhatsappInbox)
    worker.session = SESSION
    entry.runtime_data = WhatsappRuntimeData(client=client, inbox=worker)
    user = MockUser().add_to_hass(hass)
    assert not user.is_admin
    with pytest.raises(Unauthorized):
        await hass.services.async_call(
            "whatsapp",
            action,
            data,
            blocking=True,
            return_response=True,
            context=Context(user_id=user.id),
        )
    client.async_inbox.assert_not_awaited()
    worker.wake.assert_not_called()
    for context in [Context(user_id=hass_admin_user.id), Context()]:
        await hass.services.async_call(
            "whatsapp",
            action,
            data,
            blocking=True,
            return_response=True,
            context=context,
        )
    assert client.async_inbox.await_count == 2
    assert worker.wake.call_count == 2


@pytest.mark.parametrize(
    "action,data,reply",
    [
        ("get_inbox", {}, pending()),
        (
            "start_inbox_message",
            {"inbox": REFERENCE},
            {"started": False, "status": "pending"},
        ),
        ("complete_inbox_message", {"inbox": REFERENCE}, {"status": "completed"}),
        (
            "resolve_inbox_message",
            {"inbox": REFERENCE, "resolution": "hold"},
            {"status": "interrupted"},
        ),
    ],
)
async def test_individual_workflow_actions_remain_available_to_household_users(
    hass, enable_custom_integrations, action, data, reply
):
    """Keep normal processing and failure handling outside bulk-admin restrictions."""
    await async_setup(hass, {})
    entry = MockConfigEntry(domain="whatsapp", data={"url": "http://addon:3000"})
    entry.add_to_hass(hass)
    client = Mock(spec=WhatsappClient)
    client.async_inbox = AsyncMock(return_value=reply)
    worker = Mock(spec=WhatsappInbox)
    worker.session = SESSION
    entry.runtime_data = WhatsappRuntimeData(client=client, inbox=worker)
    user = MockUser().add_to_hass(hass)
    assert (
        await hass.services.async_call(
            "whatsapp",
            action,
            data,
            blocking=True,
            return_response=True,
            context=Context(user_id=user.id),
        )
        == reply
    )
    client.async_inbox.assert_awaited_once()


async def test_held_backlog_is_baselined_on_reload_and_only_new_transitions_emit_events(
    hass, caplog
):
    """Keep backlog reminders without replaying per-message event automations."""

    def held(index, status="blocked", reason="unclaimed"):
        return {
            "inbox": {**REFERENCE, "id": f"{index:064x}"},
            "clientId": "default",
            "status": status,
            "reason": reason,
        }

    def snapshot(items):
        return {
            "status": "blocked",
            "inbox": items[0]["inbox"],
            "attention": items,
            "counts": {
                "pending": 0,
                "processing": 0,
                "blocked": sum(item["status"] == "blocked" for item in items),
                "interrupted": sum(item["status"] == "interrupted" for item in items),
            },
        }

    attention_events, interrupted_events = [], []
    hass.bus.async_listen(
        "whatsapp_inbox_attention", lambda event: attention_events.append(event.data)
    )
    hass.bus.async_listen(
        "whatsapp_inbox_interrupted",
        lambda event: interrupted_events.append(event.data),
    )
    old = [held(index) for index in range(250)]
    new = [held(250), held(251, "interrupted", "workflow_failed"), held(252)]
    first = WhatsappInbox(hass, Mock(spec=WhatsappClient))
    with patch(
        "custom_components.whatsapp.inbox.persistent_notification.async_create"
    ) as notify:
        first._handle_result(snapshot(old))
        first._handle_result(snapshot(old))
        await hass.async_block_till_done()
        assert not attention_events and not interrupted_events
        assert notify.call_count == 1
        assert "250" in notify.call_args.args[1]
        first._handle_result(snapshot(old + new))
        first._handle_result(snapshot(old + new))
        second = WhatsappInbox(hass, Mock(spec=WhatsappClient))
        second._handle_result(snapshot(old + new))
        await hass.async_block_till_done()
    assert attention_events == new
    assert interrupted_events == [{"inbox": new[1]["inbox"]}]
    warnings = [
        record
        for record in caplog.records
        if record.name == "custom_components.whatsapp.inbox"
    ]
    assert (
        len(warnings) == 3
    )  # One baseline per worker, one aggregate for new held work.
    assert "250" in warnings[0].message
    assert "3" in warnings[1].message
    assert "253" in warnings[2].message
    assert "12025550123" not in caplog.text


async def test_worker_stops_cleanly_when_inbox_support_is_removed(hass):
    client = Mock(spec=WhatsappClient)
    client.async_inbox = AsyncMock(
        side_effect=WhatsappUnsupportedCapability(
            "Disabled", code="unsupported_capability"
        )
    )
    with (
        patch(
            "custom_components.whatsapp.inbox.persistent_notification.async_create"
        ) as create,
        patch(
            "custom_components.whatsapp.inbox.persistent_notification.async_dismiss"
        ) as dismiss,
    ):
        await asyncio.wait_for(WhatsappInbox(hass, client)._run(), 1)
    create.assert_not_called()
    assert dismiss.call_count == 2


async def test_app_restart_receipt_refreshes_the_existing_ha_workers_delivery_budget(
    hass,
):
    worker = WhatsappInbox(hass, Mock(spec=WhatsappClient))
    original = pending(worker.session)
    events = []
    hass.bus.async_listen(
        "new_whatsapp_message", lambda event: events.append(event.data)
    )
    with patch("custom_components.whatsapp.inbox.monotonic") as now:
        for seconds in [0, 20, 40, 60]:
            now.return_value = seconds
            worker._handle_result(original)
        restored = deepcopy(original)
        restored["message"]["inbox"]["receipt"] = "f" * 64
        now.return_value = 91
        worker._handle_result(restored)
    await hass.async_block_till_done()
    assert len(events) == 4
    assert events[-1]["inbox"]["session"] == worker.session
    assert events[-1]["inbox"]["receipt"] != events[0]["inbox"]["receipt"]


async def test_parallel_example_claims_another_account_while_a_workflow_is_waiting(
    hass, enable_custom_integrations
):
    document = (
        Path(__file__).parents[3] / "docs/examples/reliable-incoming-messages.md"
    ).read_text()
    blocks = re.findall(r"```yaml\n(.*?)```", document, re.DOTALL)
    script_config, automation_config = [yaml.safe_load(block) for block in blocks[:2]]
    # Adapt the example's allowed-account policy to this two-account installation.
    automation_config["actions"][2]["if"] = automation_config["actions"][2][
        "if"
    ].replace(
        "incoming.clientId != 'default'",
        "incoming.clientId not in ['default', 'other']",
    )
    await async_setup(hass, {})
    entry = MockConfigEntry(domain="whatsapp", data={"url": "http://addon:3000"})
    entry.add_to_hass(hass)
    client = Mock(spec=WhatsappClient)
    worker = Mock(spec=WhatsappInbox)
    worker.session = SESSION
    entry.runtime_data = WhatsappRuntimeData(client=client, inbox=worker)
    first_waiting = asyncio.Event()
    release_first = asyncio.Event()
    second_done = asyncio.Event()
    started = set()

    async def inbox_request(operation, data):
        identity = data["inbox"]["id"]
        if operation == "start":
            already = identity in started
            started.add(identity)
            return {"started": not already, "status": "processing"}
        if operation == "complete" and identity == "e" * 64:
            second_done.set()
        return {"status": "completed"}

    async def send(call):
        if call.data["clientId"] == "default":
            first_waiting.set()
            await release_first.wait()

    client.async_inbox = AsyncMock(side_effect=inbox_request)
    hass.services.async_register("whatsapp", "send_message", send)
    hass.state = CoreState.running
    assert await async_setup_component(hass, "script", {"script": script_config})
    assert await async_setup_component(
        hass, "automation", {"automation": [automation_config]}
    )
    first = pending()["message"]
    second = deepcopy(first)
    second["clientId"] = "other"
    second["inbox"]["id"] = "e" * 64
    try:
        hass.bus.async_fire("new_whatsapp_message", first)
        await asyncio.wait_for(first_waiting.wait(), 1)
        hass.bus.async_fire("new_whatsapp_message", second)
        await asyncio.wait_for(second_done.wait(), 1)
        assert not release_first.is_set()
        assert len(started) == 2
    finally:
        release_first.set()
        await hass.async_block_till_done()
