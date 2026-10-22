"""Offline inbox lifecycle, service, and protocol validation tests."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest
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
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import CoreState
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from pytest_homeassistant_custom_component.common import MockConfigEntry

pytestmark = pytest.mark.enable_socket
SESSION = "a" * 32
REFERENCE = {"id": "b" * 64, "receipt": "c" * 64, "session": SESSION}
COUNTS = {"pending": 1, "processing": 0, "interrupted": 0}


def pending(session=SESSION):
    return {
        "status": "pending",
        "counts": dict(COUNTS),
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
        ("poll", {"status": "empty", "counts": dict.fromkeys(COUNTS, 0)}, True),
        ("poll", {"status": "preparing", "counts": COUNTS, "inbox": REFERENCE}, True),
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


async def test_replaced_consumer_stops_instead_of_stealing_delivery(hass):
    client = Mock(spec=WhatsappClient)
    client.async_inbox = AsyncMock(
        side_effect=WhatsappApiError("replaced", code="inbox_session_changed")
    )
    await asyncio.wait_for(WhatsappInbox(hass, client)._run(), 1)
    assert client.async_inbox.await_count == 1


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
            operation, {"session": SESSION} if action == "get_inbox" else data
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
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(
            "whatsapp", "get_inbox", {}, blocking=True, return_response=True
        )
