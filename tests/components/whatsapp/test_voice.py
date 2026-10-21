"""Voice action validation, authentication, capability checks, and error handling."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from homeassistant.exceptions import ServiceValidationError
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.whatsapp import WhatsappRuntimeData, async_setup
from custom_components.whatsapp.client import (
    WhatsappApiError,
    WhatsappClient,
    WhatsappUnsupportedCapability,
    normalize_voice_target,
)
from custom_components.whatsapp.const import CONF_URL, DOMAIN

pytestmark = pytest.mark.enable_socket


@pytest.mark.parametrize(
    ("target", "expected"),
    [("+12025550123", "12025550123@s.whatsapp.net"),
     ("12025550123@s.whatsapp.net", "12025550123@s.whatsapp.net"),
     ("222222222@lid", "222222222@lid")],
)
def test_voice_target(target, expected):
    """Direct targets normalize without changing LIDs."""
    assert normalize_voice_target(target) == expected


@pytest.mark.parametrize("target", ["", "invalid", "120363000000000000@g.us"])
def test_voice_target_rejects_groups_and_invalid_values(target):
    """Voice actions cannot initiate a group call."""
    with pytest.raises(ValueError):
        normalize_voice_target(target)


@pytest.mark.parametrize(
    ("action", "endpoint", "response"),
    [("make_call", "voice/call", {"status": "calling"}),
     ("hang_up", "voice/hangup", {"status": "ended"})],
)
async def test_voice_client_uses_authentication_and_explicit_account(action, endpoint, response):
    """Call actions use the managed API credential and advertise bounded timeouts."""
    session = SimpleNamespace(request=AsyncMock(return_value=SimpleNamespace(
        status=200, json=AsyncMock(return_value=response))))
    client = WhatsappClient(session, "http://addon:3000", api_token="synthetic-token")
    client._capabilities = frozenset({action})
    payload = {"clientId": "default", **({"to": "+12025550123", "message": "Synthetic alert"} if action == "make_call" else {})}
    original = dict(payload)
    assert await getattr(client, "async_" + action)(payload) == response
    assert payload == original
    args = session.request.call_args
    assert args.args == ("POST", "http://addon:3000/" + endpoint)
    assert args.kwargs["headers"]["Authorization"] == "Bearer synthetic-token"
    assert args.kwargs["json"]["clientId"] == "default"
    if action == "make_call":
        assert args.kwargs["json"]["to"] == "12025550123@s.whatsapp.net"
        assert args.kwargs["timeout"].total == 60


@pytest.mark.parametrize("action", ["make_call", "hang_up"])
async def test_voice_client_rejects_unsupported_or_invalid_responses(action):
    """Old apps fail before requests; malformed successes never appear as calls."""
    session = SimpleNamespace(request=AsyncMock(return_value=SimpleNamespace(
        status=200, json=AsyncMock(return_value={"unexpected": True}))))
    client = WhatsappClient(session, "http://addon:3000")
    client._capabilities = frozenset()
    data = {"clientId": "default", "to": "222222222@lid"}
    with pytest.raises(WhatsappUnsupportedCapability):
        await getattr(client, "async_" + action)(data)
    session.request.assert_not_called()
    client._capabilities = frozenset({action})
    with pytest.raises(WhatsappApiError, match="invalid response"):
        await getattr(client, "async_" + action)(data)


@pytest.mark.parametrize("action", ["make_call", "hang_up"])
@pytest.mark.parametrize("return_response", [False, True])
async def test_voice_services_route_through_existing_entry(hass, enable_custom_integrations, action, return_response):
    """Automations call through the existing integration and accept optional results."""
    expected = {"status": "calling" if action == "make_call" else "ended"}
    client = SimpleNamespace(**{"async_" + action: AsyncMock(return_value=expected)})
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_URL: "http://addon:3000"})
    entry.add_to_hass(hass)
    entry.runtime_data = WhatsappRuntimeData(client=client)
    assert await async_setup(hass, {})
    data = {"clientId": "default", **({"to": "+12025550123", "message": "Synthetic alert"} if action == "make_call" else {})}
    result = await hass.services.async_call(DOMAIN, action, data, blocking=True, return_response=return_response)
    assert result == (expected if return_response else None)
    received = getattr(client, "async_" + action).call_args.args[0]
    assert received["clientId"] == "default"
    if action == "make_call":
        assert received["to"] == "12025550123@s.whatsapp.net"
        assert received["message"] == "Synthetic alert"


async def test_voice_service_rejects_group_before_calling_app(hass, enable_custom_integrations):
    """Invalid group targets never reach the app."""
    assert await async_setup(hass, {})
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "make_call", {"clientId": "default", "to": "120363000000000000@g.us"}, blocking=True)
