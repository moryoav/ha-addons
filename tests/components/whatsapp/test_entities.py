"""Tests for account devices, entity availability, and lifecycle."""

from unittest.mock import AsyncMock, PropertyMock, patch

import pytest
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.whatsapp import async_remove_config_entry_device
from custom_components.whatsapp.client import WhatsappApiError, WhatsappCannotConnect
from custom_components.whatsapp.const import CONF_URL, DOMAIN, SESSION_STATES
from custom_components.whatsapp.entity import app_device_identifier

pytestmark = pytest.mark.enable_socket


@pytest.fixture
def account_api():
    """Mock the app API without opening real connections."""
    health = AsyncMock(return_value={"status": "ok", "client_count": 2})
    status = AsyncMock(return_value={"personal": "connected", "work": "pairing"})
    with (
        patch("custom_components.whatsapp.WhatsappClient.async_health", health),
        patch("custom_components.whatsapp.WhatsappClient.async_status", status),
        patch(
            "custom_components.whatsapp.WhatsappClient.capabilities",
            new_callable=PropertyMock,
        ) as capabilities,
    ):
        capabilities.return_value = frozenset({"get_status"})
        yield health, status, capabilities


async def setup_entry(hass):
    """Load the complete integration including both entity platforms."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="WhatsApp app",
        unique_id=DOMAIN,
        data={CONF_URL: "http://app:3000"},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def entity_id(hass, entry, account, key):
    """Find an entity by stable identity rather than its generated name."""
    unique_id = (
        f"{entry.entry_id}_app_connection"
        if account is None
        else f"{entry.entry_id}_account_{account}_{key}"
    )
    platform = "sensor" if key == "session_state" else "binary_sensor"
    return er.async_get(hass).async_get_entity_id(platform, DOMAIN, unique_id)


async def refresh(hass, entry):
    """Refresh the shared snapshot and wait for dynamic entity registration."""
    await entry.runtime_data.coordinator.async_refresh()
    await hass.async_block_till_done()


async def action_descriptions(ws):
    """Read the descriptions the Home Assistant frontend receives."""
    await ws.send_json_auto_id({"type": "get_services"})
    result = await ws.receive_json()
    assert result["success"]
    return result["result"][DOMAIN]


def devices_by_identifier(registry, entry):
    """Index the entry's devices by their WhatsApp identifiers."""
    return {
        identifier: device
        for device in dr.async_entries_for_config_entry(registry, entry.entry_id)
        for domain, identifier in device.identifiers
        if domain == DOMAIN
    }


async def test_action_account_dropdown(
    hass, enable_custom_integrations, account_api, hass_ws_client
) -> None:
    """Publish actual account IDs and prefill only a sole configured account."""
    _, status, _ = account_api
    assert await async_setup_component(hass, DOMAIN, {})
    ws = await hass_ws_client(hass)
    original = await action_descriptions(ws)

    status.return_value = {"personal": "connected"}
    entry = await setup_entry(hass)
    single = await action_descriptions(ws)

    status.return_value = {"work": "disconnected", "personal": "connected"}
    await refresh(hass, entry)
    multiple = await action_descriptions(ws)

    assert single.keys() == multiple.keys() == original.keys()
    for action, description in original.items():
        fields = description["fields"]
        client_field = fields["clientId"]
        assert single[action]["fields"] == {
            **fields,
            "clientId": {
                **client_field,
                "default": "personal",
                "selector": {"select": {"options": ["personal"], "custom_value": True}},
            },
        }
        assert multiple[action]["fields"] == {
            **fields,
            "clientId": {
                **client_field,
                "selector": {
                    "select": {"options": ["personal", "work"], "custom_value": True}
                },
            },
        }
        assert single[action].get("response") == description.get("response")
        assert multiple[action].get("response") == description.get("response")

    status.return_value = {"work": "connected"}
    await refresh(hass, entry)
    updated = await action_descriptions(ws)
    assert updated["send_message"]["fields"]["clientId"]["default"] == "work"


async def test_separate_devices_and_entity_names(
    hass, enable_custom_integrations, account_api, caplog
) -> None:
    """Each account owns two entities, alongside one shared app device."""
    entry = await setup_entry(hass)
    assert "deprecated `via_device` parameter" not in caplog.text
    registry = dr.async_get(hass)
    devices = devices_by_identifier(registry, entry)
    assert {device.name for device in devices.values()} == {
        "WhatsApp app",
        "WhatsApp (personal)",
        "WhatsApp (work)",
    }
    app = devices[app_device_identifier(entry)]
    personal = devices[f"{entry.entry_id}_account_personal"]
    work = devices[f"{entry.entry_id}_account_work"]
    assert personal.id != work.id
    assert personal.via_device_id == work.via_device_id == app.id

    expected = [
        (None, "connection", "on", app.id, "WhatsApp app App connection"),
        (
            "personal",
            "connection",
            "on",
            personal.id,
            "WhatsApp (personal) WhatsApp connection",
        ),
        (
            "personal",
            "session_state",
            "connected",
            personal.id,
            "WhatsApp (personal) Session state",
        ),
        ("work", "connection", "off", work.id, "WhatsApp (work) WhatsApp connection"),
        ("work", "session_state", "pairing", work.id, "WhatsApp (work) Session state"),
    ]
    entity_registry = er.async_get(hass)
    assert len(er.async_entries_for_config_entry(entity_registry, entry.entry_id)) == 5
    for account, key, value, device_id, name in expected:
        target = entity_id(hass, entry, account, key)
        state = hass.states.get(target)
        assert state.state == value
        assert state.attributes["friendly_name"] == name
        assert entity_registry.async_get(target).device_id == device_id
        assert state.attributes["device_class"] == (
            "enum" if key == "session_state" else "connectivity"
        )
    assert hass.states.get(
        entity_id(hass, entry, "personal", "session_state")
    ).attributes["options"] == list(SESSION_STATES)


@pytest.mark.parametrize("state", SESSION_STATES)
async def test_account_states_are_independent(
    hass, enable_custom_integrations, account_api, state
) -> None:
    """One account's state must not change another account or app reachability."""
    _, status, _ = account_api
    entry = await setup_entry(hass)
    status.return_value = {"personal": state, "work": "connected"}
    await refresh(hass, entry)
    assert hass.states.get(entity_id(hass, entry, None, "connection")).state == "on"
    assert hass.states.get(entity_id(hass, entry, "work", "connection")).state == "on"
    assert hass.states.get(entity_id(hass, entry, "personal", "connection")).state == (
        "on" if state == "connected" else "off"
    )
    assert (
        hass.states.get(entity_id(hass, entry, "personal", "session_state")).state
        == state
    )


async def test_outages_and_account_api_failure(
    hass, enable_custom_integrations, account_api, hass_ws_client
) -> None:
    """Separate a failed status request from an app that cannot be reached."""
    health, status, _ = account_api
    entry = await setup_entry(hass)
    ws = await hass_ws_client(hass)
    app_entity = entity_id(hass, entry, None, "connection")
    account_entities = [
        entity_id(hass, entry, "personal", key)
        for key in ("connection", "session_state")
    ]

    status.side_effect = WhatsappApiError(status=401)
    await refresh(hass, entry)
    unavailable = await action_descriptions(ws)
    assert "text" in unavailable["send_message"]["fields"]["clientId"]["selector"]
    assert hass.states.get(app_entity).state == "on"
    for target in account_entities:
        assert hass.states.get(target).state == "unavailable"

    status.side_effect = None
    await refresh(hass, entry)
    recovered = await action_descriptions(ws)
    assert "select" in recovered["send_message"]["fields"]["clientId"]["selector"]

    health.side_effect = WhatsappCannotConnect()
    await refresh(hass, entry)
    assert await action_descriptions(ws) == unavailable
    assert hass.states.get(app_entity).state == "off"
    for target in account_entities:
        assert hass.states.get(target).state == "unavailable"

    health.side_effect = None
    await refresh(hass, entry)
    assert hass.states.get(app_entity).state == "on"
    assert hass.states.get(account_entities[0]).state == "on"
    assert hass.states.get(account_entities[1]).state == "connected"


async def test_dynamic_accounts_and_safe_device_removal(
    hass, enable_custom_integrations, account_api
) -> None:
    """Discover new accounts and allow removing only stale account devices."""
    health, status, _ = account_api
    entry = await setup_entry(hass)
    status.return_value = {
        "personal": "reconnecting",
        "work": "connected",
        "app": "pairing",
    }
    await refresh(hass, entry)
    registry = dr.async_get(hass)
    devices = devices_by_identifier(registry, entry)
    assert len(devices) == 4
    assert (
        len(er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)) == 7
    )
    app = devices[app_device_identifier(entry)]
    work = devices[f"{entry.entry_id}_account_work"]
    new_account = devices[f"{entry.entry_id}_account_app"]
    assert new_account.via_device_id == app.id
    assert not await async_remove_config_entry_device(hass, entry, app)
    assert not await async_remove_config_entry_device(hass, entry, work)

    status.return_value = {"personal": "connected", "app": "connected"}
    await refresh(hass, entry)
    assert (
        hass.states.get(entity_id(hass, entry, "work", "connection")).state
        == "unavailable"
    )
    assert await async_remove_config_entry_device(hass, entry, work)

    health.side_effect = WhatsappCannotConnect()
    await refresh(hass, entry)
    assert not await async_remove_config_entry_device(hass, entry, work)
    health.side_effect = None
    status.side_effect = WhatsappApiError()
    await refresh(hass, entry)
    assert not await async_remove_config_entry_device(hass, entry, work)

    status.side_effect = None
    status.return_value = {
        "personal": "connected",
        "work": "pairing",
        "app": "connected",
    }
    await refresh(hass, entry)
    assert len(dr.async_entries_for_config_entry(registry, entry.entry_id)) == 4
    assert (
        len(er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)) == 7
    )
    assert (
        devices_by_identifier(registry, entry)[f"{entry.entry_id}_account_work"].id
        == work.id
    )


async def test_legacy_upgrade_and_unload(
    hass, enable_custom_integrations, account_api, hass_ws_client
) -> None:
    """Discover accounts after an app upgrade and retain IDs across reloads."""
    _, status, capabilities = account_api
    capabilities.return_value = None
    entry = await setup_entry(hass)
    coordinator = entry.runtime_data.coordinator
    ws = await hass_ws_client(hass)
    legacy = await action_descriptions(ws)
    legacy_field = legacy["send_message"]["fields"]["clientId"]
    assert "text" in legacy_field["selector"]
    assert "default" not in legacy_field
    assert (
        len(er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)) == 1
    )
    status.assert_not_awaited()

    capabilities.return_value = frozenset({"get_status"})
    await refresh(hass, entry)
    upgraded = await action_descriptions(ws)
    assert "select" in upgraded["send_message"]["fields"]["clientId"]["selector"]
    assert (
        len(er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)) == 5
    )
    identities = {
        entity.unique_id: entity.entity_id
        for entity in er.async_entries_for_config_entry(
            er.async_get(hass), entry.entry_id
        )
    }
    registry = dr.async_get(hass)
    device_links = {
        device.id: device.via_device_id
        for device in dr.async_entries_for_config_entry(registry, entry.entry_id)
    }
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    unloaded = await action_descriptions(ws)
    assert unloaded["send_message"]["fields"]["clientId"] == legacy_field
    assert not coordinator._listeners
    assert coordinator._unsub_refresh is None

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert await action_descriptions(ws) == upgraded
    assert {
        entity.unique_id: entity.entity_id
        for entity in er.async_entries_for_config_entry(
            er.async_get(hass), entry.entry_id
        )
    } == identities
    assert {
        device.id: device.via_device_id
        for device in dr.async_entries_for_config_entry(registry, entry.entry_id)
    } == device_links


async def test_deleted_account_can_be_discovered_again(
    hass, enable_custom_integrations, account_api
) -> None:
    """A removed device must not prevent a returning account from being added."""
    _, status, _ = account_api
    entry = await setup_entry(hass)
    registry = dr.async_get(hass)
    work = devices_by_identifier(registry, entry)[f"{entry.entry_id}_account_work"]
    status.return_value = {"personal": "connected"}
    await refresh(hass, entry)
    registry.async_remove_device(work.id)
    await hass.async_block_till_done()
    assert entity_id(hass, entry, "work", "connection") is None
    assert entity_id(hass, entry, "work", "session_state") is None

    status.return_value = {"personal": "connected", "work": "pairing"}
    await refresh(hass, entry)
    assert hass.states.get(entity_id(hass, entry, "work", "connection")).state == "off"
    assert (
        hass.states.get(entity_id(hass, entry, "work", "session_state")).state
        == "pairing"
    )
    assert len(dr.async_entries_for_config_entry(registry, entry.entry_id)) == 3


async def test_account_status_failure_during_setup(
    hass, enable_custom_integrations, account_api
) -> None:
    """Keep app monitoring available during status authentication errors."""
    _, status, _ = account_api
    status.side_effect = WhatsappApiError(status=401)
    entry = await setup_entry(hass)
    assert hass.states.get(entity_id(hass, entry, None, "connection")).state == "on"
    assert (
        len(er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)) == 1
    )


async def test_device_removal_without_coordinator(hass, account_api) -> None:
    """A partial runtime must not allow deleting monitored devices."""
    from custom_components.whatsapp import WhatsappRuntimeData

    entry = MockConfigEntry(domain=DOMAIN, data={CONF_URL: "http://app"})
    entry.runtime_data = WhatsappRuntimeData(client=AsyncMock())
    assert not await async_remove_config_entry_device(hass, entry, None)
