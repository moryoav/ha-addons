"""Tests for the WhatsApp integration setup."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.exceptions import ConfigEntryNotReady, HomeAssistantError
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.whatsapp import (
    WhatsappRuntimeData,
    async_setup,
    async_setup_entry,
)
from custom_components.whatsapp.client import WhatsappApiError, WhatsappCannotConnect
from custom_components.whatsapp.const import CONF_URL, DOMAIN

pytestmark = pytest.mark.enable_socket


async def test_setup_entry_success(hass, enable_custom_integrations) -> None:
    """Test successful config entry setup."""
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_URL: "http://addon:3000"})
    entry.add_to_hass(hass)

    with patch(
        "custom_components.whatsapp.WhatsappClient.async_health",
        AsyncMock(return_value={"status": "ok"}),
    ):
        assert await async_setup_entry(hass, entry)

    assert isinstance(entry.runtime_data, WhatsappRuntimeData)


async def test_setup_entry_cannot_connect(hass, enable_custom_integrations) -> None:
    """Test setup retry when the add-on cannot be reached."""
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_URL: "http://addon:3000"})

    with patch(
        "custom_components.whatsapp.WhatsappClient.async_health",
        AsyncMock(side_effect=WhatsappCannotConnect),
    ):
        with pytest.raises(ConfigEntryNotReady):
            await async_setup_entry(hass, entry)


async def test_service_requires_config_entry(hass, enable_custom_integrations) -> None:
    """Test that service actions fail clearly before setup."""
    assert await async_setup(hass, {})

    with pytest.raises(HomeAssistantError):
        await hass.services.async_call(
            DOMAIN,
            "send_message",
            {
                "clientId": "default",
                "to": "391234567890@s.whatsapp.net",
                "body": {"text": "hello"},
            },
            blocking=True,
            return_response=True,
        )


async def test_service_actions_success(hass, enable_custom_integrations) -> None:
    """Test successful service action calls."""
    client = AsyncMock()
    client.async_send_message.return_value = {"key": {"id": "abc"}}
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_URL: "http://addon:3000"})
    entry.add_to_hass(hass)
    entry.runtime_data = WhatsappRuntimeData(client=client)

    assert await async_setup(hass, {})

    response = await hass.services.async_call(
        DOMAIN,
        "send_message",
        {
            "clientId": "default",
            "to": "391234567890@s.whatsapp.net",
            "body": {"text": "hello"},
        },
        blocking=True,
        return_response=True,
    )

    assert response["message_id"] == "abc"

    service_calls = [
        ("set_status", {"clientId": "default", "status": "Available"}),
        (
            "presence_subscribe",
            {"clientId": "default", "userId": "391234567890@s.whatsapp.net"},
        ),
        (
            "send_presence_update",
            {"clientId": "default", "type": "available"},
        ),
        (
            "send_infinity_presence_update",
            {"clientId": "default", "type": "available"},
        ),
        (
            "read_messages",
            {"clientId": "default", "body": {"keys": {"id": "abc"}}},
        ),
    ]

    for service, data in service_calls:
        await hass.services.async_call(DOMAIN, service, data, blocking=True)

    client.async_send_message.assert_awaited_once()
    client.async_set_status.assert_awaited_once()
    client.async_presence_subscribe.assert_awaited_once()
    client.async_send_presence_update.assert_awaited_once()
    client.async_send_infinity_presence_update.assert_awaited_once()
    client.async_read_messages.assert_awaited_once()


@pytest.mark.parametrize(
    ("side_effect", "message"),
    [
        (WhatsappCannotConnect, "Could not connect"),
        (WhatsappApiError("boom"), "Could not complete"),
    ],
)
async def test_service_action_failures(
    hass,
    enable_custom_integrations,
    side_effect,
    message,
) -> None:
    """Test service action failure translation."""
    client = AsyncMock()
    client.async_set_status.side_effect = side_effect
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_URL: "http://addon:3000"})
    entry.add_to_hass(hass)
    entry.runtime_data = WhatsappRuntimeData(client=client)

    assert await async_setup(hass, {})

    with pytest.raises(HomeAssistantError, match=message):
        await hass.services.async_call(
            DOMAIN,
            "set_status",
            {"clientId": "default", "status": "Available"},
            blocking=True,
        )
