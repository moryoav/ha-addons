"""Tests for the WhatsApp integration setup and actions."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
import yaml
from homeassistant.exceptions import (
    ConfigEntryError,
    ConfigEntryNotReady,
    HomeAssistantError,
    ServiceValidationError,
)
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.whatsapp import (
    WhatsappRuntimeData,
    async_setup,
    async_setup_entry,
)
from custom_components.whatsapp.client import (
    WhatsappApiError,
    WhatsappCannotConnect,
    WhatsappClient,
    WhatsappUnsupportedCapability,
)
from custom_components.whatsapp.const import CONF_API_TOKEN, CONF_URL, DOMAIN

pytestmark = pytest.mark.enable_socket


def _entry_with_client(hass, client) -> MockConfigEntry:
    """Add a loaded WhatsApp config entry with the supplied client."""
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_URL: "http://addon:3000"})
    entry.add_to_hass(hass)
    entry.runtime_data = WhatsappRuntimeData(client=client)
    return entry


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


async def test_setup_entry_passes_discovered_api_token(
    hass,
    enable_custom_integrations,
) -> None:
    """Test a discovery token is passed only to the API client."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={CONF_URL: "http://addon:3000", CONF_API_TOKEN: "secret-token"},
    )
    entry.add_to_hass(hass)

    with patch("custom_components.whatsapp.WhatsappClient") as client_cls:
        client_cls.return_value.async_health = AsyncMock(return_value={"status": "ok"})
        assert await async_setup_entry(hass, entry)

    client_cls.assert_called_once()
    assert client_cls.call_args.kwargs == {"api_token": "secret-token"}


async def test_setup_entry_cannot_connect(hass, enable_custom_integrations) -> None:
    """Test setup retry when the add-on cannot be reached or identified."""
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_URL: "http://addon:3000"})

    with patch(
        "custom_components.whatsapp.WhatsappClient.async_health",
        AsyncMock(side_effect=WhatsappCannotConnect),
    ):
        with pytest.raises(ConfigEntryNotReady):
            await async_setup_entry(hass, entry)


async def test_setup_entry_rejects_invalid_api_token(
    hass,
    enable_custom_integrations,
) -> None:
    """Test malformed stored tokens cannot reach an HTTP header."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={CONF_URL: "http://addon:3000", CONF_API_TOKEN: "bad\r\ntoken"},
    )

    with pytest.raises(ConfigEntryError) as exc_info:
        await async_setup_entry(hass, entry)
    assert exc_info.value.translation_key == "invalid_api_token_config"


async def test_service_requires_config_entry(hass, enable_custom_integrations) -> None:
    """Test actions fail as validation errors before integration setup."""
    assert await async_setup(hass, {})

    with pytest.raises(ServiceValidationError) as exc_info:
        await hass.services.async_call(
            DOMAIN,
            "send_message",
            {
                "clientId": "default",
                "to": "12025550123@s.whatsapp.net",
                "body": {"text": "hello"},
            },
            blocking=True,
            return_response=True,
        )
    assert exc_info.value.translation_key == "not_configured"


async def test_service_actions_success(hass, enable_custom_integrations) -> None:
    """Test successful service action calls."""
    client = AsyncMock(spec=WhatsappClient)
    client.async_send_message.return_value = {"key": {"id": "abc"}}
    client.async_check_number.return_value = {
        "jid": "12025550123@s.whatsapp.net",
        "exists": True,
        "lid": "123456789@lid",
    }
    _entry_with_client(hass, client)

    assert await async_setup(hass, {})

    response = await hass.services.async_call(
        DOMAIN,
        "send_message",
        {
            "clientId": "default",
            "to": "12025550123@s.whatsapp.net",
            "body": {"text": "hello"},
        },
        blocking=True,
        return_response=True,
    )
    assert response["message_id"] == "abc"

    check_response = await hass.services.async_call(
        DOMAIN,
        "check_number",
        {"clientId": "default", "to": "+12025550123"},
        blocking=True,
        return_response=True,
    )
    assert check_response == {
        "jid": "12025550123@s.whatsapp.net",
        "exists": True,
        "lid": "123456789@lid",
    }
    client.async_check_number.assert_awaited_once_with(
        {"clientId": "default", "to": "12025550123@s.whatsapp.net"}
    )

    service_calls = [
        ("set_status", {"clientId": "default", "status": "Available"}),
        (
            "presence_subscribe",
            {"clientId": "default", "userId": "12025550123@s.whatsapp.net"},
        ),
        ("send_presence_update", {"clientId": "default", "type": "available"}),
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


async def test_send_message_without_response_still_fires_result_event(
    hass,
    enable_custom_integrations,
) -> None:
    """Test optional responses are omitted while the compatibility event remains."""
    client = AsyncMock(spec=WhatsappClient)
    client.async_send_message.return_value = {"key": {"id": "abc"}}
    _entry_with_client(hass, client)
    events = []
    hass.bus.async_listen("whatsapp_send_message_result", events.append)
    assert await async_setup(hass, {})

    response = await hass.services.async_call(
        DOMAIN,
        "send_message",
        {
            "clientId": "default",
            "to": "12025550123@s.whatsapp.net",
            "body": {"text": "hello"},
        },
        blocking=True,
    )
    await hass.async_block_till_done()

    assert response is None
    assert len(events) == 1
    assert events[0].data["sent_message"] == {"key": {"id": "abc"}}


async def test_check_number_requires_response(hass, enable_custom_integrations) -> None:
    """Test number checks cannot silently discard their only useful result."""
    client = AsyncMock(spec=WhatsappClient)
    _entry_with_client(hass, client)
    assert await async_setup(hass, {})

    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(
            DOMAIN,
            "check_number",
            {"clientId": "default", "to": "12025550123"},
            blocking=True,
        )
    client.async_check_number.assert_not_awaited()


@pytest.mark.parametrize(
    "target",
    [
        "12345@g.us",
        "12025550123@lid",
        "status@broadcast",
        "12025550123:2@s.whatsapp.net",
        "1555-123-4567",
    ],
)
async def test_check_number_rejects_invalid_target(
    hass,
    enable_custom_integrations,
    target,
) -> None:
    """Test the action rejects every non-phone recipient type."""
    client = AsyncMock(spec=WhatsappClient)
    _entry_with_client(hass, client)
    assert await async_setup(hass, {})

    with pytest.raises(ServiceValidationError) as exc_info:
        await hass.services.async_call(
            DOMAIN,
            "check_number",
            {"clientId": "default", "to": target},
            blocking=True,
            return_response=True,
        )
    assert exc_info.value.translation_key == "invalid_phone_target"
    client.async_check_number.assert_not_awaited()


async def test_send_message_translates_unregistered_number(
    hass,
    enable_custom_integrations,
) -> None:
    """Test a send lookup miss is presented as a caller validation error."""
    client = AsyncMock(spec=WhatsappClient)
    client.async_send_message.side_effect = WhatsappApiError(
        status=404,
        code="number_not_found",
    )
    _entry_with_client(hass, client)
    assert await async_setup(hass, {})

    with pytest.raises(ServiceValidationError) as exc_info:
        await hass.services.async_call(
            DOMAIN,
            "send_message",
            {
                "clientId": "default",
                "to": "12025550123",
                "body": {"text": "hello"},
            },
            blocking=True,
            return_response=True,
        )
    assert exc_info.value.translation_key == "number_not_found"


@pytest.mark.parametrize(
    ("side_effect", "error_type", "translation_key"),
    [
        (WhatsappCannotConnect(), HomeAssistantError, "cannot_connect"),
        (
            WhatsappUnsupportedCapability(),
            ServiceValidationError,
            "addon_too_old",
        ),
        (
            WhatsappApiError(status=400, code="invalid_request"),
            ServiceValidationError,
            "invalid_request",
        ),
        (
            WhatsappApiError(status=404, code="client_not_found"),
            ServiceValidationError,
            "client_not_found",
        ),
        (
            WhatsappApiError(status=401, code="unauthorized"),
            HomeAssistantError,
            "unauthorized",
        ),
        (
            WhatsappApiError(status=503, code="client_disconnected"),
            HomeAssistantError,
            "client_disconnected",
        ),
        (
            WhatsappApiError(status=429, code="rate_limited"),
            HomeAssistantError,
            "rate_limited",
        ),
        (
            WhatsappApiError(status=502, code="upstream_error"),
            HomeAssistantError,
            "upstream_error",
        ),
        (
            WhatsappApiError(status=500),
            HomeAssistantError,
            "api_request_failed",
        ),
    ],
)
async def test_service_action_failures_use_translated_exception_types(
    hass,
    enable_custom_integrations,
    side_effect,
    error_type,
    translation_key,
) -> None:
    """Test user errors and operational failures use the appropriate exception."""
    client = AsyncMock(spec=WhatsappClient)
    client.async_check_number.side_effect = side_effect
    _entry_with_client(hass, client)
    assert await async_setup(hass, {})

    with pytest.raises(error_type) as exc_info:
        await hass.services.async_call(
            DOMAIN,
            "check_number",
            {"clientId": "default", "to": "12025550123"},
            blocking=True,
            return_response=True,
        )
    assert exc_info.value.translation_domain == DOMAIN
    assert exc_info.value.translation_key == translation_key


def test_service_descriptions_are_complete() -> None:
    """Test service metadata is translated or provided for legacy camel-case fields."""
    integration_dir = (
        Path(__file__).resolve().parents[3] / "custom_components" / "whatsapp"
    )
    services = yaml.safe_load((integration_dir / "services.yaml").read_text())
    translations = json.loads(
        (integration_dir / "translations" / "en.json").read_text()
    )["services"]

    assert services.keys() == translations.keys()
    for service_name, service in services.items():
        assert "name" not in service
        assert "description" not in service
        assert translations[service_name]["name"]
        assert translations[service_name]["description"]
        translated_fields = translations[service_name].get("fields", {})
        for field_name, field in service.get("fields", {}).items():
            if field_name in translated_fields:
                assert "name" not in field
                assert "description" not in field
                assert translated_fields[field_name]["name"]
                assert translated_fields[field_name]["description"]
            else:
                assert field["name"]
                assert field["description"]
                assert field_name in {"clientId", "userId"}
