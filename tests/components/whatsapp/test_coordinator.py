"""Tests for app reachability and independent account availability."""

from unittest.mock import AsyncMock, Mock

import pytest
from homeassistant.config_entries import ConfigEntryState
from homeassistant.exceptions import ConfigEntryNotReady
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.whatsapp.client import (
    WhatsappApiError,
    WhatsappCannotConnect,
    WhatsappClient,
)
from custom_components.whatsapp.coordinator import WhatsappStatusCoordinator

pytestmark = pytest.mark.enable_socket


def status_client(capabilities=frozenset({"get_status"})):
    """Build a client with separate app and account responses."""
    client = Mock(spec=WhatsappClient)
    client.capabilities = capabilities
    client.async_health = AsyncMock(return_value={"status": "ok"})
    client.async_status = AsyncMock(
        return_value={"personal": "connected", "work": "pairing"}
    )
    return client


async def test_status_updates_and_reachability(hass, caplog) -> None:
    """Account failure must not claim the app itself is disconnected."""
    client = status_client()
    coordinator = WhatsappStatusCoordinator(
        hass,
        MockConfigEntry(domain="whatsapp", state=ConfigEntryState.SETUP_IN_PROGRESS),
        client,
    )
    await coordinator.async_config_entry_first_refresh()
    assert coordinator.data == {"personal": "connected", "work": "pairing"}

    client.async_status.side_effect = WhatsappApiError("private content")
    await coordinator.async_refresh()
    await coordinator.async_refresh()
    assert coordinator.last_update_success
    assert coordinator.data is None
    assert caplog.text.count("WhatsApp account status is unavailable") == 1
    assert "private content" not in caplog.text

    client.async_status.side_effect = None
    await coordinator.async_refresh()
    assert coordinator.data["personal"] == "connected"
    assert "WhatsApp account status is available again" in caplog.text

    client.async_health.side_effect = WhatsappCannotConnect("private-url")
    await coordinator.async_refresh()
    assert not coordinator.last_update_success
    assert "private-url" not in caplog.text
    client.async_health.side_effect = None
    await coordinator.async_refresh()
    assert coordinator.last_update_success


@pytest.mark.parametrize(
    "capabilities", [None, frozenset(), frozenset({"send_message"})]
)
async def test_legacy_app_only_monitors_reachability(hass, capabilities) -> None:
    """Existing actions keep working without the new status endpoint."""
    client = status_client(capabilities)
    coordinator = WhatsappStatusCoordinator(
        hass,
        MockConfigEntry(domain="whatsapp", state=ConfigEntryState.SETUP_IN_PROGRESS),
        client,
    )
    await coordinator.async_config_entry_first_refresh()
    assert coordinator.last_update_success
    assert coordinator.data is None
    client.async_status.assert_not_awaited()


async def test_initial_app_failure_retries_setup(hass) -> None:
    """Keep the integration's existing retry behavior."""
    client = status_client()
    client.async_health.side_effect = WhatsappCannotConnect()
    coordinator = WhatsappStatusCoordinator(
        hass,
        MockConfigEntry(domain="whatsapp", state=ConfigEntryState.SETUP_IN_PROGRESS),
        client,
    )
    with pytest.raises(ConfigEntryNotReady):
        await coordinator.async_config_entry_first_refresh()
