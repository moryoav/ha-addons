"""Client for the local WhatsApp add-on HTTP API."""

from __future__ import annotations

import re
from typing import Any

from aiohttp import (
    ClientError,
    ClientResponse,
    ClientSession,
    ClientTimeout,
    ContentTypeError,
)

from .const import (
    ADDON_API_VERSION,
    ADDON_SERVICE,
    ATTR_TO,
    CAPABILITY_CHECK_NUMBER,
    DEFAULT_TIMEOUT,
)

_PHONE_NUMBER_PATTERN = re.compile(r"^\+?([1-9][0-9]{4,14})$")
_PHONE_JID_PATTERN = re.compile(r"^([1-9][0-9]{4,14})@s\.whatsapp\.net$")
_LID_PATTERN = re.compile(r"^[1-9][0-9]{4,30}@lid$")
_API_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9._~+/-]+=*$")
_ERROR_CODE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class WhatsappApiError(Exception):
    """Base exception for WhatsApp add-on API errors."""

    def __init__(
        self,
        message: str = "WhatsApp add-on API request failed",
        *,
        status: int | None = None,
        code: str | None = None,
    ) -> None:
        """Initialize an API error with machine-readable response details."""
        super().__init__(message)
        self.status = status
        self.code = code


class WhatsappCannotConnect(WhatsappApiError):
    """Raised when the WhatsApp add-on cannot be reached or identified."""


class WhatsappUnsupportedCapability(WhatsappApiError):
    """Raised when an installed add-on does not support an API capability."""


def normalize_phone_target(value: str) -> str:
    """Validate a phone-number target and return its canonical WhatsApp JID."""
    if match := _PHONE_NUMBER_PATTERN.fullmatch(value):
        return f"{match.group(1)}@s.whatsapp.net"
    if _PHONE_JID_PATTERN.fullmatch(value):
        return value
    raise ValueError("target is not a valid phone number or phone-number JID")


def normalize_api_token(value: Any) -> str | None:
    """Validate an optional RFC 6750-style bearer token."""
    if value is None or value == "":
        return None
    if (
        not isinstance(value, str)
        or len(value) > 512
        or _API_TOKEN_PATTERN.fullmatch(value) is None
    ):
        raise ValueError("API token is invalid")
    return value


class WhatsappClient:
    """Async client for the WhatsApp add-on."""

    def __init__(
        self,
        session: ClientSession,
        base_url: str,
        *,
        timeout: int = DEFAULT_TIMEOUT,
        api_token: str | None = None,
    ) -> None:
        """Initialize the API client."""
        self._session = session
        self._base_url = base_url.rstrip("/")
        self._timeout = ClientTimeout(total=timeout)
        self._api_token = normalize_api_token(api_token)
        self._capabilities: frozenset[str] | None = None

    @property
    def base_url(self) -> str:
        """Return the configured base URL."""
        return self._base_url

    @property
    def capabilities(self) -> frozenset[str] | None:
        """Return advertised capabilities, or None for a legacy add-on."""
        return self._capabilities

    async def async_health(self) -> dict[str, Any]:
        """Return validated add-on health information.

        Add-ons released before the versioned API contract only returned a status
        and client count. Those responses remain valid so existing installations
        can still set up and use the actions they already support.
        """
        response = await self._request("GET", "health")
        if response.status >= 400:
            raise WhatsappCannotConnect(
                f"health endpoint returned HTTP {response.status}",
                status=response.status,
            )

        payload = await self._read_json(response, "health", WhatsappCannotConnect)
        if not isinstance(payload, dict) or payload.get("status") != "ok":
            raise WhatsappCannotConnect("health endpoint returned an invalid response")

        client_count = payload.get("client_count")
        if client_count is not None and (
            type(client_count) is not int or client_count < 0
        ):
            raise WhatsappCannotConnect(
                "health endpoint returned an invalid client count"
            )

        contract_keys = {"service", "api_version", "capabilities"}
        if not contract_keys.intersection(payload):
            self._capabilities = None
            return payload

        if payload.get("service") != ADDON_SERVICE:
            raise WhatsappCannotConnect("health endpoint belongs to another service")
        if (
            type(payload.get("api_version")) is not int
            or payload["api_version"] != ADDON_API_VERSION
        ):
            raise WhatsappCannotConnect(
                "health endpoint uses an unsupported API version"
            )
        if type(client_count) is not int or client_count < 0:
            raise WhatsappCannotConnect(
                "health endpoint returned an invalid client count"
            )

        capabilities = payload.get("capabilities")
        if not isinstance(capabilities, list) or not all(
            isinstance(capability, str) and capability for capability in capabilities
        ):
            raise WhatsappCannotConnect("health endpoint returned invalid capabilities")

        self._capabilities = frozenset(capabilities)
        return payload

    async def async_check_number(self, data: dict[str, Any]) -> dict[str, Any]:
        """Check whether a phone number is registered with WhatsApp."""
        jid = normalize_phone_target(data[ATTR_TO])

        if (
            self._capabilities is not None
            and CAPABILITY_CHECK_NUMBER not in self._capabilities
        ):
            raise WhatsappUnsupportedCapability(
                "the add-on does not advertise number lookup support",
                code="unsupported_capability",
            )

        response = await self._request(
            "POST",
            "onWhatsApp",
            json={**data, ATTR_TO: jid},
        )
        if response.status >= 400:
            try:
                await self._raise_for_error(response, "check number")
            except WhatsappApiError as err:
                if err.status == 404 and err.code != "client_not_found":
                    raise WhatsappUnsupportedCapability(
                        "the add-on does not provide the number lookup endpoint",
                        status=err.status,
                        code="unsupported_capability",
                    ) from err
                raise

        payload = await self._read_json(response, "check number", WhatsappApiError)
        if not isinstance(payload, dict):
            raise WhatsappApiError(
                "check number returned an invalid response",
                status=response.status,
                code="invalid_response",
            )

        result_jid = payload.get("jid")
        exists = payload.get("exists")
        lid = payload.get("lid")
        if (
            not {"jid", "exists", "lid"}.issubset(payload)
            or result_jid != jid
            or type(exists) is not bool
            or (
                lid is not None
                and (not isinstance(lid, str) or _LID_PATTERN.fullmatch(lid) is None)
            )
            or (not exists and lid is not None)
        ):
            raise WhatsappApiError(
                "check number returned an invalid response",
                status=response.status,
                code="invalid_response",
            )

        return {"jid": result_jid, "exists": exists, "lid": lid}

    async def async_send_message(self, data: dict[str, Any]) -> dict[str, Any]:
        """Send a WhatsApp message."""
        response = await self._request("POST", "sendMessage", json=data)
        await self._raise_for_error(response, "send message")

        payload = await self._read_json(response, "send message", WhatsappApiError)
        if not isinstance(payload, dict):
            raise WhatsappApiError(
                "send message returned an invalid response",
                status=response.status,
                code="invalid_response",
            )
        return payload

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
        try:
            body = (await response.text()).strip()
        except ClientError as err:
            raise WhatsappCannotConnect(str(err)) from err
        if body != "OK":
            raise WhatsappApiError(
                f"{action} returned an unexpected response",
                status=response.status,
                code="invalid_response",
            )

    async def _request(
        self,
        method: str,
        endpoint: str,
        **kwargs: Any,
    ) -> ClientResponse:
        """Make an HTTP request to the add-on API."""
        url = f"{self._base_url}/{endpoint.lstrip('/')}"
        headers = dict(kwargs.pop("headers", {}))
        if self._api_token:
            headers["Authorization"] = f"Bearer {self._api_token}"
        if headers:
            kwargs["headers"] = headers

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
    async def _read_json(
        response: ClientResponse,
        action: str,
        error_type: type[WhatsappApiError],
    ) -> Any:
        """Read a JSON response and translate malformed response bodies."""
        try:
            return await response.json()
        except (ContentTypeError, ValueError) as err:
            raise error_type(
                f"{action} returned a non-JSON response",
                status=response.status,
                code="invalid_response",
            ) from err
        except ClientError as err:
            raise WhatsappCannotConnect(str(err)) from err

    @staticmethod
    async def _raise_for_error(response: ClientResponse, action: str) -> None:
        """Raise a structured API error for an unsuccessful response."""
        if response.status < 400:
            return

        payload: Any = None
        try:
            payload = await response.json()
        except (ContentTypeError, ValueError):
            pass
        except ClientError as err:
            raise WhatsappCannotConnect(str(err)) from err

        code: str | None = None
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict):
                error_code = error.get("code")
                if (
                    isinstance(error_code, str)
                    and _ERROR_CODE_PATTERN.fullmatch(error_code) is not None
                ):
                    code = error_code

        raise WhatsappApiError(
            f"{action} failed ({code or f'HTTP {response.status}'})",
            status=response.status,
            code=code,
        )
