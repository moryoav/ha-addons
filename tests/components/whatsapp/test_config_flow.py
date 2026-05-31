"""Tests for the WhatsApp config flow."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.whatsapp.client import WhatsappCannotConnect
from custom_components.whatsapp.config_flow import _async_validate_url, _normalize_url
from custom_components.whatsapp.const import CONF_URL, DOMAIN

pytestmark = pytest.mark.enable_socket


async def test_user_flow_success(hass, enable_custom_integrations) -> None:
    """Test a successful user flow."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": config_entries.SOURCE_USER},
    )

    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"

    with patch(
        "custom_components.whatsapp.config_flow._async_validate_url",
        return_value=None,
    ):
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"],
            {CONF_URL: "http://whatsapp_addon:3000/"},
        )

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "WhatsApp Add-on"
    assert result["data"] == {CONF_URL: "http://whatsapp_addon:3000"}


async def test_user_flow_invalid_url(hass, enable_custom_integrations) -> None:
    """Test that invalid URLs are rejected."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": config_entries.SOURCE_USER},
    )

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {CONF_URL: "not-a-url"},
    )

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_url"}


async def test_user_flow_cannot_connect(hass, enable_custom_integrations) -> None:
    """Test that connection failures keep the form open."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": config_entries.SOURCE_USER},
    )

    with patch(
        "custom_components.whatsapp.config_flow._async_validate_url",
        side_effect=WhatsappCannotConnect,
    ):
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"],
            {CONF_URL: "http://whatsapp_addon:3000"},
        )

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}


async def test_user_flow_single_instance(hass, enable_custom_integrations) -> None:
    """Test that only one config entry is allowed."""
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_URL: "http://one:3000"})
    entry.add_to_hass(hass)

    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": config_entries.SOURCE_USER},
    )

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"


async def test_reconfigure_flow(hass, enable_custom_integrations) -> None:
    """Test the reconfigure branch."""
    flow = await hass.config_entries.flow.async_create_flow(
        DOMAIN,
        context={"source": "reconfigure"},
        data=None,
    )
    flow._get_reconfigure_entry = lambda: MockConfigEntry(
        domain=DOMAIN,
        data={CONF_URL: "http://old-addon:3000"},
    )
    flow.async_update_reload_and_abort = lambda entry, data_updates: {
        "type": FlowResultType.ABORT,
        "data_updates": data_updates,
    }

    with patch(
        "custom_components.whatsapp.config_flow._async_validate_url",
        return_value=None,
    ):
        result = await flow.async_step_reconfigure(
            {CONF_URL: "http://new-addon:3000/"}
        )

    assert result["type"] is FlowResultType.ABORT
    assert result["data_updates"] == {CONF_URL: "http://new-addon:3000"}


async def test_validate_url_uses_client(hass, enable_custom_integrations) -> None:
    """Test URL validation checks add-on health."""
    with patch(
        "custom_components.whatsapp.config_flow.WhatsappClient.async_health",
        AsyncMock(return_value={"status": "ok"}),
    ) as health:
        await _async_validate_url(hass, "http://addon:3000")

    health.assert_awaited_once()


def test_normalize_url() -> None:
    """Test URL normalization."""
    assert _normalize_url(" http://addon:3000/ ") == "http://addon:3000"
