"""Tests for WhatsApp diagnostics."""

from __future__ import annotations

from unittest.mock import AsyncMock, Mock

import pytest

from custom_components.whatsapp import WhatsappRuntimeData
from custom_components.whatsapp.client import WhatsappCannotConnect
from custom_components.whatsapp.const import CONF_URL
from custom_components.whatsapp.diagnostics import async_get_config_entry_diagnostics

pytestmark = pytest.mark.enable_socket


async def test_diagnostics_redacts_url_and_reports_health(hass) -> None:
    """Test diagnostics avoid exposing the configured add-on URL."""
    client = Mock()
    client.async_health = AsyncMock(return_value={"status": "ok", "client_count": 2})
    entry = Mock(
        title="WhatsApp Add-on",
        data={CONF_URL: "http://private-addon:3000"},
        runtime_data=WhatsappRuntimeData(client=client),
    )

    result = await async_get_config_entry_diagnostics(hass, entry)

    assert result == {
        "entry": {
            "title": "WhatsApp Add-on",
            "url_configured": True,
        },
        "addon": {
            "available": True,
            "status": "ok",
            "client_count": 2,
        },
    }


async def test_diagnostics_without_runtime_data(hass) -> None:
    """Test diagnostics before runtime data is available."""
    entry = Mock(
        title="WhatsApp Add-on",
        data={CONF_URL: "http://private-addon:3000"},
    )

    result = await async_get_config_entry_diagnostics(hass, entry)

    assert result["entry"]["url_configured"] is True
    assert result["addon"] == {"available": False}


async def test_diagnostics_health_error(hass) -> None:
    """Test diagnostics when health cannot be read."""
    client = Mock()
    client.async_health = AsyncMock(side_effect=WhatsappCannotConnect)
    entry = Mock(
        title="WhatsApp Add-on",
        data={CONF_URL: "http://private-addon:3000"},
        runtime_data=WhatsappRuntimeData(client=client),
    )

    result = await async_get_config_entry_diagnostics(hass, entry)

    assert result["addon"] == {
        "available": False,
        "error": "WhatsappCannotConnect",
    }
