"""Tests for the WhatsApp add-on API client."""

from __future__ import annotations

import pytest
from aiohttp import ClientError

from custom_components.whatsapp.client import (
    WhatsappApiError,
    WhatsappCannotConnect,
    WhatsappClient,
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


async def test_health_success() -> None:
    """Test health endpoint success."""
    session = FakeSession(FakeResponse(json_data={"status": "ok"}))
    client = WhatsappClient(session, "http://addon:3000/")

    assert await client.async_health() == {"status": "ok"}
    assert session.calls[0][0] == "GET"
    assert session.calls[0][1] == "http://addon:3000/health"


async def test_health_http_error() -> None:
    """Test health endpoint HTTP errors."""
    session = FakeSession(FakeResponse(status=404, text_data="missing"))
    client = WhatsappClient(session, "http://addon:3000")

    with pytest.raises(WhatsappCannotConnect):
        await client.async_health()


async def test_health_non_json() -> None:
    """Test health endpoint non-JSON response."""
    session = FakeSession(
        FakeResponse(json_error=ValueError("no json"), text_data="not json")
    )
    client = WhatsappClient(session, "http://addon:3000")

    with pytest.raises(WhatsappCannotConnect):
        await client.async_health()


async def test_request_cannot_connect() -> None:
    """Test transport errors are translated."""
    session = FakeSession(ClientError("down"))
    client = WhatsappClient(session, "http://addon:3000")

    with pytest.raises(WhatsappCannotConnect):
        await client.async_health()


async def test_send_message_success() -> None:
    """Test sending a message returns JSON."""
    sent = {"key": {"id": "abc"}}
    session = FakeSession(FakeResponse(json_data=sent))
    client = WhatsappClient(session, "http://addon:3000")

    assert await client.async_send_message({"body": {"text": "hi"}}) == sent
    assert session.calls[0][0] == "POST"
    assert session.calls[0][1] == "http://addon:3000/sendMessage"


async def test_send_message_non_json() -> None:
    """Test non-JSON send responses fail."""
    session = FakeSession(FakeResponse(json_error=ValueError("no json"), text_data="KO"))
    client = WhatsappClient(session, "http://addon:3000")

    with pytest.raises(WhatsappApiError):
        await client.async_send_message({})


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
    """Test non-OK action bodies fail."""
    session = FakeSession(FakeResponse(text_data="KO"))
    client = WhatsappClient(session, "http://addon:3000")

    with pytest.raises(WhatsappApiError):
        await client.async_set_status({})


async def test_http_error_json() -> None:
    """Test HTTP error JSON body is included."""
    session = FakeSession(FakeResponse(status=500, json_data={"error": "boom"}))
    client = WhatsappClient(session, "http://addon:3000")

    with pytest.raises(WhatsappApiError, match="boom"):
        await client.async_read_messages({})


async def test_http_error_text() -> None:
    """Test HTTP error text body is included."""
    session = FakeSession(
        FakeResponse(status=500, json_error=ValueError("no json"), text_data="bad")
    )
    client = WhatsappClient(session, "http://addon:3000")

    with pytest.raises(WhatsappApiError, match="bad"):
        await client.async_read_messages({})
