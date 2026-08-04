"""Tests for the WhatsApp add-on API client."""

from __future__ import annotations

from unittest.mock import Mock

import pytest
from aiohttp import ClientError, ContentTypeError

from custom_components.whatsapp.client import (
    WhatsappApiError,
    WhatsappCannotConnect,
    WhatsappClient,
    WhatsappUnsupportedCapability,
    normalize_api_token,
    normalize_phone_target,
)

pytestmark = pytest.mark.enable_socket


class FakeResponse:
    """Fake aiohttp response."""

    def __init__(
        self,
        *,
        status: int = 200,
        json_data=None,
        text_data: str = "OK",
        json_error: Exception | None = None,
    ) -> None:
        """Initialize the fake response."""
        self.status = status
        self._json_data = json_data
        self._text_data = text_data
        self._json_error = json_error

    async def json(self):
        """Return fake JSON."""
        if self._json_error is not None:
            raise self._json_error
        return self._json_data

    async def text(self) -> str:
        """Return fake text."""
        return self._text_data


class FakeSession:
    """Fake aiohttp session."""

    def __init__(self, response_or_error) -> None:
        """Initialize the fake session."""
        self.response_or_error = response_or_error
        self.calls = []

    async def request(self, method, url, **kwargs):
        """Return the configured response or raise the configured error."""
        self.calls.append((method, url, kwargs))
        if isinstance(self.response_or_error, Exception):
            raise self.response_or_error
        return self.response_or_error


def _modern_health(*, capabilities=None) -> dict:
    """Return a valid versioned health response."""
    return {
        "status": "ok",
        "service": "ha-whatsapp-addon",
        "api_version": 1,
        "capabilities": capabilities
        if capabilities is not None
        else ["send_message", "check_number"],
        "client_count": 1,
    }


async def test_health_legacy_success() -> None:
    """Test a legacy health response remains supported."""
    session = FakeSession(FakeResponse(json_data={"status": "ok"}))
    client = WhatsappClient(session, "http://addon:3000/")

    assert await client.async_health() == {"status": "ok"}
    assert client.capabilities is None
    assert session.calls[0][0] == "GET"
    assert session.calls[0][1] == "http://addon:3000/health"


async def test_health_modern_success() -> None:
    """Test versioned health metadata and capabilities are recorded."""
    health = _modern_health()
    client = WhatsappClient(FakeSession(FakeResponse(json_data=health)), "http://addon")

    assert await client.async_health() == health
    assert client.capabilities == frozenset({"send_message", "check_number"})


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"status": "starting"},
        {"status": "ok", "client_count": -1},
        {"status": "ok", "client_count": True},
        {**_modern_health(), "service": "another-service"},
        {**_modern_health(), "api_version": 2},
        {**_modern_health(), "api_version": True},
        {**_modern_health(), "capabilities": "check_number"},
        {**_modern_health(), "capabilities": ["check_number", 1]},
        {
            key: value
            for key, value in _modern_health().items()
            if key != "client_count"
        },
        {"status": "ok", "service": "ha-whatsapp-addon"},
    ],
)
async def test_health_rejects_invalid_contract(payload) -> None:
    """Test invalid and foreign health responses are rejected."""
    client = WhatsappClient(
        FakeSession(FakeResponse(json_data=payload)), "http://addon"
    )

    with pytest.raises(WhatsappCannotConnect):
        await client.async_health()


async def test_health_http_error_preserves_status() -> None:
    """Test health HTTP errors preserve their status."""
    client = WhatsappClient(
        FakeSession(FakeResponse(status=404, text_data="missing")),
        "http://addon",
    )

    with pytest.raises(WhatsappCannotConnect) as exc_info:
        await client.async_health()
    assert exc_info.value.status == 404


@pytest.mark.parametrize(
    "json_error",
    [
        ValueError("no json"),
        ContentTypeError(Mock(), (), message="unexpected content type"),
    ],
)
async def test_health_non_json(json_error) -> None:
    """Test malformed health responses, including aiohttp content type errors."""
    client = WhatsappClient(
        FakeSession(FakeResponse(json_error=json_error, text_data="not json")),
        "http://addon",
    )

    with pytest.raises(WhatsappCannotConnect, match="non-JSON"):
        await client.async_health()


async def test_request_cannot_connect() -> None:
    """Test transport errors are translated."""
    client = WhatsappClient(FakeSession(ClientError("down")), "http://addon")

    with pytest.raises(WhatsappCannotConnect):
        await client.async_health()


async def test_api_token_is_sent_as_bearer_header() -> None:
    """Test API tokens are sent without placing them in URLs or payloads."""
    session = FakeSession(FakeResponse(json_data={"status": "ok"}))
    client = WhatsappClient(session, "http://addon", api_token="secret-token")

    await client.async_health()

    assert session.calls[0][2]["headers"] == {"Authorization": "Bearer secret-token"}
    assert "secret-token" not in session.calls[0][1]


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        (None, None),
        ("", None),
        ("secret-token", "secret-token"),
        ("abc+/==", "abc+/=="),
        ("a" * 512, "a" * 512),
    ],
)
def test_normalize_api_token(token, expected) -> None:
    """Test valid optional bearer tokens are preserved exactly."""
    assert normalize_api_token(token) == expected


@pytest.mark.parametrize(
    "token",
    [
        " ",
        "token with spaces",
        "abc=def",
        "token\r\ninjected",
        "a" * 513,
        123,
    ],
)
def test_normalize_api_token_rejects_invalid_values(token) -> None:
    """Test malformed tokens cannot enter an Authorization header."""
    with pytest.raises(ValueError):
        normalize_api_token(token)


@pytest.mark.parametrize(
    ("target", "expected"),
    [
        ("12025550123", "12025550123@s.whatsapp.net"),
        ("+12025550123", "12025550123@s.whatsapp.net"),
        ("12025550123@s.whatsapp.net", "12025550123@s.whatsapp.net"),
    ],
)
def test_normalize_phone_target(target, expected) -> None:
    """Test supported number formats normalize to one canonical JID."""
    assert normalize_phone_target(target) == expected


@pytest.mark.parametrize(
    "target",
    [
        "12025550123@g.us",
        "12025550123@lid",
        "status@broadcast",
        "12025550123:4@s.whatsapp.net",
        "+12025550123@s.whatsapp.net",
        "05551234567",
        "1234",
        "1234567890123456",
        "1555 123 4567",
        "1555-123-4567",
        "\u0661\u0662\u0660\u0662\u0665\u0665\u0665\u0660\u0661\u0662\u0663",
        " 12025550123",
        "",
    ],
)
def test_normalize_phone_target_rejects_non_phone_targets(target) -> None:
    """Test groups, LIDs, broadcasts, devices, and malformed numbers fail."""
    with pytest.raises(ValueError):
        normalize_phone_target(target)


async def test_check_number_registered() -> None:
    """Test a registered number response is normalized and validated."""
    session = FakeSession(
        FakeResponse(
            json_data={
                "jid": "12025550123@s.whatsapp.net",
                "exists": True,
                "lid": "123456789012345@lid",
                "ignored": "upstream extension",
            }
        )
    )
    client = WhatsappClient(session, "http://addon")

    result = await client.async_check_number(
        {"clientId": "default", "to": "+12025550123"}
    )

    assert result == {
        "jid": "12025550123@s.whatsapp.net",
        "exists": True,
        "lid": "123456789012345@lid",
    }
    assert session.calls[0][0:2] == ("POST", "http://addon/onWhatsApp")
    assert session.calls[0][2]["json"] == {
        "clientId": "default",
        "to": "12025550123@s.whatsapp.net",
    }


async def test_check_number_unregistered() -> None:
    """Test an unregistered number has a stable false response."""
    response = {
        "jid": "12025550123@s.whatsapp.net",
        "exists": False,
        "lid": None,
    }
    client = WhatsappClient(
        FakeSession(FakeResponse(json_data=response)), "http://addon"
    )

    assert (
        await client.async_check_number(
            {"clientId": "default", "to": "12025550123@s.whatsapp.net"}
        )
        == response
    )


async def test_check_number_registered_without_lid() -> None:
    """Test a registered number may not have an associated LID."""
    response = {
        "jid": "12025550123@s.whatsapp.net",
        "exists": True,
        "lid": None,
    }
    client = WhatsappClient(
        FakeSession(FakeResponse(json_data=response)), "http://addon"
    )

    assert (
        await client.async_check_number({"clientId": "default", "to": "12025550123"})
        == response
    )


@pytest.mark.parametrize(
    "payload",
    [
        [],
        {"jid": "12025550123@s.whatsapp.net", "exists": True},
        {"jid": "12025550124@s.whatsapp.net", "exists": True, "lid": None},
        {"jid": "12025550123@s.whatsapp.net", "exists": 1, "lid": None},
        {"jid": "12025550123@s.whatsapp.net", "exists": True, "lid": 123},
        {"jid": "12025550123@s.whatsapp.net", "exists": True, "lid": "bad"},
        {"jid": "12025550123@s.whatsapp.net", "exists": True, "lid": "@lid"},
        {"jid": "12025550123@s.whatsapp.net", "exists": True, "lid": "1234@lid"},
        {
            "jid": "12025550123@s.whatsapp.net",
            "exists": True,
            "lid": "\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669@lid",
        },
        {
            "jid": "12025550123@s.whatsapp.net",
            "exists": True,
            "lid": "12345:1@lid",
        },
        {
            "jid": "12025550123@s.whatsapp.net",
            "exists": True,
            "lid": "bad value@lid",
        },
        {
            "jid": "12025550123@s.whatsapp.net",
            "exists": True,
            "lid": f"{'1' * 125}@lid",
        },
        {
            "jid": "12025550123@s.whatsapp.net",
            "exists": False,
            "lid": "123456789@lid",
        },
    ],
)
async def test_check_number_rejects_malformed_response(payload) -> None:
    """Test malformed add-on lookup data cannot leak into automations."""
    client = WhatsappClient(
        FakeSession(FakeResponse(json_data=payload)), "http://addon"
    )

    with pytest.raises(WhatsappApiError, match="invalid response") as exc_info:
        await client.async_check_number({"clientId": "default", "to": "12025550123"})
    assert exc_info.value.status == 200
    assert exc_info.value.code == "invalid_response"


async def test_check_number_rejects_missing_advertised_capability() -> None:
    """Test a versioned add-on without lookup support fails before the POST."""
    session = FakeSession(FakeResponse(json_data=_modern_health(capabilities=[])))
    client = WhatsappClient(session, "http://addon")
    await client.async_health()

    with pytest.raises(WhatsappUnsupportedCapability):
        await client.async_check_number({"clientId": "default", "to": "12025550123"})
    assert len(session.calls) == 1


async def test_check_number_legacy_endpoint_missing() -> None:
    """Test an old add-on's missing route becomes an upgrade error."""
    response = FakeResponse(
        status=404,
        json_error=ContentTypeError(Mock(), (), message="text/html"),
        text_data="Cannot POST /onWhatsApp",
    )
    client = WhatsappClient(FakeSession(response), "http://addon")

    with pytest.raises(WhatsappUnsupportedCapability) as exc_info:
        await client.async_check_number({"clientId": "default", "to": "12025550123"})
    assert exc_info.value.status == 404
    assert exc_info.value.code == "unsupported_capability"


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (400, "invalid_request"),
        (401, "unauthorized"),
        (404, "client_not_found"),
        (429, "rate_limited"),
        (502, "upstream_error"),
        (503, "client_disconnected"),
    ],
)
async def test_check_number_preserves_structured_api_error(status, code) -> None:
    """Test structured add-on status and codes survive client translation."""
    response = FakeResponse(
        status=status,
        json_data={"error": {"code": code, "message": "Request failed."}},
    )
    client = WhatsappClient(FakeSession(response), "http://addon")

    with pytest.raises(WhatsappApiError) as exc_info:
        await client.async_check_number({"clientId": "default", "to": "12025550123"})
    assert exc_info.value.status == status
    assert exc_info.value.code == code
    assert "Request failed" not in str(exc_info.value)


async def test_api_error_rejects_untrusted_machine_code() -> None:
    """Test arbitrary error codes and messages cannot reflect recipient data."""
    sensitive_value = "12025550123@s.whatsapp.net"
    response = FakeResponse(
        status=500,
        json_data={
            "error": {
                "code": f"failed for {sensitive_value}",
                "message": f"Lookup failed for {sensitive_value}",
            }
        },
    )
    client = WhatsappClient(FakeSession(response), "http://addon")

    with pytest.raises(WhatsappApiError) as exc_info:
        await client.async_read_messages({})
    assert exc_info.value.status == 500
    assert exc_info.value.code is None
    assert sensitive_value not in str(exc_info.value)


async def test_send_message_success() -> None:
    """Test sending a message returns JSON."""
    sent = {"key": {"id": "abc"}}
    session = FakeSession(FakeResponse(json_data=sent))
    client = WhatsappClient(session, "http://addon:3000")

    assert await client.async_send_message({"body": {"text": "hi"}}) == sent
    assert session.calls[0][0] == "POST"
    assert session.calls[0][1] == "http://addon:3000/sendMessage"


@pytest.mark.parametrize(
    "json_error",
    [
        ValueError("no json"),
        ContentTypeError(Mock(), (), message="text/plain"),
    ],
)
async def test_send_message_non_json(json_error) -> None:
    """Test non-JSON send responses fail."""
    client = WhatsappClient(
        FakeSession(FakeResponse(json_error=json_error, text_data="KO")),
        "http://addon",
    )

    with pytest.raises(WhatsappApiError, match="non-JSON") as exc_info:
        await client.async_send_message({})
    assert exc_info.value.status == 200
    assert exc_info.value.code == "invalid_response"


async def test_post_ok_success() -> None:
    """Test OK-only actions."""
    session = FakeSession(FakeResponse(text_data="OK"))
    client = WhatsappClient(session, "http://addon:3000")

    await client.async_set_status({"status": "Available"})
    await client.async_presence_subscribe({"userId": "user"})
    await client.async_send_presence_update({"type": "available"})
    await client.async_send_infinity_presence_update({"type": "available"})
    await client.async_read_messages({"body": {"keys": {}}})


async def test_post_ok_failure_body() -> None:
    """Test non-OK action bodies fail without reflecting the response body."""
    client = WhatsappClient(FakeSession(FakeResponse(text_data="KO")), "http://addon")

    with pytest.raises(WhatsappApiError, match="unexpected response") as exc_info:
        await client.async_set_status({})
    assert exc_info.value.status == 200
    assert exc_info.value.code == "invalid_response"


async def test_http_error_legacy_json_is_sanitized_and_preserves_status() -> None:
    """Test legacy error content is not reflected while status is preserved."""
    client = WhatsappClient(
        FakeSession(FakeResponse(status=500, json_data={"error": "boom"})),
        "http://addon",
    )

    with pytest.raises(WhatsappApiError, match="HTTP 500") as exc_info:
        await client.async_read_messages({})
    assert exc_info.value.status == 500
    assert exc_info.value.code is None
    assert "boom" not in str(exc_info.value)


async def test_http_error_text_is_sanitized() -> None:
    """Test untrusted text errors are not included in exceptions."""
    response = FakeResponse(
        status=500,
        json_error=ContentTypeError(Mock(), (), message="text/plain"),
        text_data="bad",
    )
    client = WhatsappClient(FakeSession(response), "http://addon")

    with pytest.raises(WhatsappApiError, match="HTTP 500") as exc_info:
        await client.async_read_messages({})
    assert exc_info.value.status == 500
    assert "bad" not in str(exc_info.value)
