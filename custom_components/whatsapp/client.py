"""Client for the local WhatsApp add-on HTTP API."""

from __future__ import annotations

from typing import Any

from aiohttp import ClientError, ClientResponse, ClientSession, ClientTimeout

from .const import DEFAULT_TIMEOUT


class WhatsappApiError(Exception):
    """Base exception for WhatsApp add-on API errors."""


class WhatsappCannotConnect(WhatsappApiError):
    """Raised when the WhatsApp add-on cannot be reached."""


class WhatsappClient:
    """Async client for the WhatsApp add-on."""

    def __init__(
        self,
        session: ClientSession,
        base_url: str,
        *,
        timeout: int = DEFAULT_TIMEOUT,
    ) -> None:
        """Initialize the API client."""
        self._session = session
        self._base_url = base_url.rstrip("/")
        self._timeout = ClientTimeout(total=timeout)

    @property
    def base_url(self) -> str:
        """Return the configured base URL."""
        return self._base_url

    async def async_health(self) -> dict[str, Any]:
        """Return add-on health information."""
        response = await self._request("GET", "health")
        if response.status >= 400:
            raise WhatsappCannotConnect(
                f"health endpoint returned HTTP {response.status}"
            )

        try:
            return await response.json()
        except ValueError as err:
            body = (await response.text()).strip()
            raise WhatsappCannotConnect(
                f"health endpoint returned non-JSON response: {body[:120]}"
            ) from err

    async def async_send_message(self, data: dict[str, Any]) -> dict[str, Any]:
        """Send a WhatsApp message."""
        response = await self._request("POST", "sendMessage", json=data)
        await self._raise_for_error(response, "send message")

        try:
            return await response.json()
        except ValueError as err:
            body = (await response.text()).strip()
            raise WhatsappApiError(
                f"send message returned non-JSON response: {body[:120]}"
            ) from err

    async def async_set_status(self, data: dict[str, Any]) -> None:
        """Set the WhatsApp account status message."""
        await self._post_ok("setStatus", data, "set status")

    async def async_presence_subscribe(self, data: dict[str, Any]) -> None:
        """Subscribe to a contact presence stream."""
        await self._post_ok("presenceSubscribe", data, "presence subscribe")

    async def async_send_presence_update(self, data: dict[str, Any]) -> None:
        """Send a one-shot presence update."""
        await self._post_ok("sendPresenceUpdate", data, "send presence update")

    async def async_send_infinity_presence_update(self, data: dict[str, Any]) -> None:
        """Send a long-running presence update."""
        await self._post_ok(
            "sendInfinityPresenceUpdate",
            data,
            "send infinity presence update",
        )

    async def async_read_messages(self, data: dict[str, Any]) -> None:
        """Mark messages as read."""
        await self._post_ok("readMessages", data, "read messages")

    async def _post_ok(
        self,
        endpoint: str,
        data: dict[str, Any],
        action: str,
    ) -> None:
        """Post data and require an OK response body."""
        response = await self._request("POST", endpoint, json=data)
        await self._raise_for_error(response, action)
        body = (await response.text()).strip()
        if body != "OK":
            raise WhatsappApiError(f"{action} returned {body or 'an empty response'}")

    async def _request(
        self,
        method: str,
        endpoint: str,
        **kwargs: Any,
    ) -> ClientResponse:
        """Make an HTTP request to the add-on API."""
        url = f"{self._base_url}/{endpoint.lstrip('/')}"
        try:
            return await self._session.request(
                method,
                url,
                timeout=self._timeout,
                **kwargs,
            )
        except (TimeoutError, ClientError) as err:
            raise WhatsappCannotConnect(str(err)) from err

    @staticmethod
    async def _raise_for_error(response: ClientResponse, action: str) -> None:
        """Raise a readable API error for an unsuccessful response."""
        if response.status < 400:
            return

        try:
            payload = await response.json()
        except ValueError:
            payload = {}

        if isinstance(payload, dict) and payload.get("error"):
            message = payload["error"]
        else:
            message = (await response.text()).strip() or f"HTTP {response.status}"

        raise WhatsappApiError(f"{action} failed: {message}")
