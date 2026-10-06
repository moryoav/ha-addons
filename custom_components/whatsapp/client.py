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
    ATTR_CALL_ID,
    ATTR_FROM,
    ATTR_TO,
    CAPABILITY_CHECK_NUMBER,
    CAPABILITY_GET_GROUP_INFO,
    CAPABILITY_GET_PROFILE,
    CAPABILITY_GET_STATUS,
    CAPABILITY_LIST_GROUPS,
    CAPABILITY_REJECT_CALL,
    DEFAULT_TIMEOUT,
    SESSION_STATES,
)

_PHONE_NUMBER_PATTERN = re.compile(r"^\+?([1-9][0-9]{4,14})$")
_PHONE_JID_PATTERN = re.compile(r"^([1-9][0-9]{4,14})@s\.whatsapp\.net$")
_LID_PATTERN = re.compile(r"^[1-9][0-9]{4,30}@lid$")
_GROUP_JID_PATTERN = re.compile(r"^[0-9][0-9-]{3,62}[0-9]@g\.us$")
_CALL_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_CALLER_JID_PATTERN = re.compile(
    r"^(?:[1-9][0-9]{4,14}(?::[0-9]{1,4})?@s\.whatsapp\.net"
    r"|[1-9][0-9]{4,30}(?::[0-9]{1,4})?@lid)$"
)
_HTTPS_URL_PATTERN = re.compile(r"^https://\S{1,2048}$")
_ISO_TIMESTAMP_PATTERN = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$"
)
_GROUP_ADMIN_ROLES = frozenset({"admin", "superadmin"})
_API_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9._~+/-]+=*$")
_ERROR_CODE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_CLIENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


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


def normalize_group_target(value: str) -> str:
    """Validate a WhatsApp group JID and return it unchanged."""
    if _GROUP_JID_PATTERN.fullmatch(value):
        return value
    raise ValueError("target is not a valid WhatsApp group JID")


def normalize_profile_target(value: str) -> str:
    """Validate a profile target and return its canonical JID.

    Phone numbers become phone JIDs; phone JIDs, LIDs, and group JIDs are
    returned unchanged.
    """
    if match := _PHONE_NUMBER_PATTERN.fullmatch(value):
        return f"{match.group(1)}@s.whatsapp.net"
    if (
        _PHONE_JID_PATTERN.fullmatch(value)
        or _LID_PATTERN.fullmatch(value)
        or _GROUP_JID_PATTERN.fullmatch(value)
    ):
        return value
    raise ValueError("target is not a phone number, phone JID, LID, or group JID")


def validate_call_reference(call_id: str, caller: str) -> None:
    """Validate the callId and from fields of a whatsapp_call_update event."""
    if not _CALL_ID_PATTERN.fullmatch(call_id):
        raise ValueError("call ID is not a valid WhatsApp call ID")
    if not _CALLER_JID_PATTERN.fullmatch(caller):
        raise ValueError("caller is not a valid WhatsApp phone JID or LID")


def _is_none_or(value: Any, predicate: Any) -> bool:
    """Return True when value is None or satisfies the predicate."""
    return value is None or predicate(value)


def _matches(pattern: re.Pattern[str]) -> Any:
    """Return a predicate that checks a string against a pattern."""
    return lambda value: isinstance(value, str) and pattern.fullmatch(value) is not None


def _is_user_or_lid_jid(value: Any) -> bool:
    """Return True for a phone-number JID or a LID."""
    return _matches(_PHONE_JID_PATTERN)(value) or _matches(_LID_PATTERN)(value)


def _validate_group_participant(participant: Any) -> dict[str, Any] | None:
    """Return the documented participant fields, or None when malformed."""
    if (
        not isinstance(participant, dict)
        or not {"jid", "lid", "admin"}.issubset(participant)
        or not _is_none_or(participant["jid"], _matches(_PHONE_JID_PATTERN))
        or not _is_none_or(participant["lid"], _matches(_LID_PATTERN))
        or not (
            participant["admin"] is None or participant["admin"] in _GROUP_ADMIN_ROLES
        )
    ):
        return None
    return {
        "jid": participant["jid"],
        "lid": participant["lid"],
        "admin": participant["admin"],
    }


_GROUP_INFO_KEYS = frozenset(
    {
        "jid",
        "subject",
        "description",
        "owner",
        "created_at",
        "size",
        "announce_only",
        "admins_only_settings",
        "is_community",
        "parent_community",
        "participants",
    }
)


def _validate_group_info(payload: Any, jid: str) -> dict[str, Any] | None:
    """Return the documented group fields, or None when the payload is malformed."""
    if (
        not isinstance(payload, dict)
        or not _GROUP_INFO_KEYS.issubset(payload)
        or payload["jid"] != jid
        or not isinstance(payload["subject"], str)
        or not _is_none_or(payload["description"], lambda v: isinstance(v, str))
        or not _is_none_or(payload["owner"], _is_user_or_lid_jid)
        or not _is_none_or(payload["created_at"], _matches(_ISO_TIMESTAMP_PATTERN))
        or type(payload["size"]) is not int
        or payload["size"] < 0
        or type(payload["announce_only"]) is not bool
        or type(payload["admins_only_settings"]) is not bool
        or type(payload["is_community"]) is not bool
        or not _is_none_or(payload["parent_community"], _matches(_GROUP_JID_PATTERN))
        or not isinstance(payload["participants"], list)
    ):
        return None

    participants = [
        _validate_group_participant(participant)
        for participant in payload["participants"]
    ]
    if any(participant is None for participant in participants):
        return None

    return {
        "jid": payload["jid"],
        "subject": payload["subject"],
        "description": payload["description"],
        "owner": payload["owner"],
        "created_at": payload["created_at"],
        "size": payload["size"],
        "announce_only": payload["announce_only"],
        "admins_only_settings": payload["admins_only_settings"],
        "is_community": payload["is_community"],
        "parent_community": payload["parent_community"],
        "participants": participants,
    }


_PROFILE_KEYS = frozenset({"jid", "picture_url", "about", "about_set_at", "business"})
_BUSINESS_KEYS = frozenset({"description", "category", "email", "website", "address"})


def _validate_business(business: Any) -> dict[str, Any] | None | bool:
    """Return the documented business fields, None, or False when malformed."""
    if business is None:
        return None
    if (
        not isinstance(business, dict)
        or not _BUSINESS_KEYS.issubset(business)
        or not all(
            _is_none_or(business[key], lambda v: isinstance(v, str))
            for key in ("description", "category", "email", "address")
        )
        or not isinstance(business["website"], list)
        or not all(isinstance(site, str) for site in business["website"])
    ):
        return False
    return {key: business[key] for key in sorted(_BUSINESS_KEYS)}


def _validate_profile(payload: Any, jid: str) -> dict[str, Any] | None:
    """Return the documented profile fields, or None when malformed."""
    if (
        not isinstance(payload, dict)
        or not _PROFILE_KEYS.issubset(payload)
        or payload["jid"] != jid
        or not _is_none_or(payload["picture_url"], _matches(_HTTPS_URL_PATTERN))
        or not _is_none_or(payload["about"], lambda v: isinstance(v, str))
        or not _is_none_or(payload["about_set_at"], _matches(_ISO_TIMESTAMP_PATTERN))
    ):
        return None
    business = _validate_business(payload["business"])
    if business is False:
        return None
    return {
        "jid": payload["jid"],
        "picture_url": payload["picture_url"],
        "about": payload["about"],
        "about_set_at": payload["about_set_at"],
        "business": business,
    }


def _validate_group_list(payload: Any) -> list[dict[str, Any]] | None:
    """Return the documented group summaries, or None when malformed."""
    if not isinstance(payload, dict) or not isinstance(payload.get("groups"), list):
        return None
    groups = []
    for group in payload["groups"]:
        if not isinstance(group, dict):
            return None
        summary = _validate_group_info({**group, "participants": []}, group.get("jid"))
        if summary is None:
            return None
        del summary["participants"]
        groups.append(summary)
    return groups


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

    async def async_get_group_info(self, data: dict[str, Any]) -> dict[str, Any]:
        """Return the name and metadata of a WhatsApp group the account belongs to."""
        jid = normalize_group_target(data[ATTR_TO])

        if (
            self._capabilities is not None
            and CAPABILITY_GET_GROUP_INFO not in self._capabilities
        ):
            raise WhatsappUnsupportedCapability(
                "the add-on does not advertise group lookup support",
                code="unsupported_capability",
            )

        response = await self._request(
            "POST",
            "groupMetadata",
            json={**data, ATTR_TO: jid},
        )
        if response.status >= 400:
            try:
                await self._raise_for_error(response, "get group info")
            except WhatsappApiError as err:
                if err.status == 404 and err.code != "client_not_found":
                    raise WhatsappUnsupportedCapability(
                        "the add-on does not provide the group lookup endpoint",
                        status=err.status,
                        code="unsupported_capability",
                    ) from err
                raise

        payload = await self._read_json(response, "get group info", WhatsappApiError)
        result = _validate_group_info(payload, jid)
        if result is None:
            raise WhatsappApiError(
                "get group info returned an invalid response",
                status=response.status,
                code="invalid_response",
            )
        return result

    async def async_get_profile(self, data: dict[str, Any]) -> dict[str, Any]:
        """Return the picture, about text, and business profile of a contact or group."""
        jid = normalize_profile_target(data[ATTR_TO])
        payload = await self._post_lookup(
            "profile",
            {**data, ATTR_TO: jid},
            "get profile",
            CAPABILITY_GET_PROFILE,
        )
        result = _validate_profile(payload, jid)
        if result is None:
            raise WhatsappApiError(
                "get profile returned an invalid response",
                code="invalid_response",
            )
        return result

    async def async_list_groups(self, data: dict[str, Any]) -> dict[str, Any]:
        """Return every group the linked account belongs to."""
        payload = await self._post_lookup(
            "groups", data, "list groups", CAPABILITY_LIST_GROUPS
        )
        groups = _validate_group_list(payload)
        if groups is None:
            raise WhatsappApiError(
                "list groups returned an invalid response",
                code="invalid_response",
            )
        return {"groups": groups}

    async def _post_lookup(
        self,
        endpoint: str,
        data: dict[str, Any],
        action: str,
        capability: str,
    ) -> Any:
        """Post a lookup that needs an add-on capability and return its JSON."""
        if self._capabilities is not None and capability not in self._capabilities:
            raise WhatsappUnsupportedCapability(
                f"the add-on does not advertise {action} support",
                code="unsupported_capability",
            )

        response = await self._request("POST", endpoint, json=data)
        if response.status >= 400:
            try:
                await self._raise_for_error(response, action)
            except WhatsappApiError as err:
                if err.status == 404 and err.code != "client_not_found":
                    raise WhatsappUnsupportedCapability(
                        f"the add-on does not provide the {action} endpoint",
                        status=err.status,
                        code="unsupported_capability",
                    ) from err
                raise
        return await self._read_json(response, action, WhatsappApiError)

    async def async_status(self) -> dict[str, str]:
        """Return account states without retaining other session information."""
        if (
            self._capabilities is not None
            and CAPABILITY_GET_STATUS not in self._capabilities
        ):
            raise WhatsappUnsupportedCapability(
                "the app does not advertise account status support",
                code="unsupported_capability",
            )

        response = await self._request("GET", "status")
        await self._raise_for_error(response, "account status")
        payload = await self._read_json(response, "account status", WhatsappApiError)
        if (
            not isinstance(payload, dict)
            or payload.get("service") != ADDON_SERVICE
            or type(payload.get("api_version")) is not int
            or payload["api_version"] != ADDON_API_VERSION
            or not isinstance(payload.get("clients"), list)
        ):
            raise WhatsappApiError(
                "invalid account status response", code="invalid_response"
            )

        accounts: dict[str, str] = {}
        for account in payload["clients"]:
            if (
                not isinstance(account, dict)
                or not isinstance(client_id := account.get("id"), str)
                or _CLIENT_ID_PATTERN.fullmatch(client_id) is None
                or client_id in accounts
                or not isinstance(state := account.get("state"), str)
                or state not in SESSION_STATES
            ):
                raise WhatsappApiError(
                    "invalid account status response", code="invalid_response"
                )
            accounts[client_id] = state
        return accounts

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

    async def async_reject_call(self, data: dict[str, Any]) -> None:
        """Reject an incoming WhatsApp call."""
        validate_call_reference(data[ATTR_CALL_ID], data[ATTR_FROM])

        if (
            self._capabilities is not None
            and CAPABILITY_REJECT_CALL not in self._capabilities
        ):
            raise WhatsappUnsupportedCapability(
                "the add-on does not advertise call rejection support",
                code="unsupported_capability",
            )

        try:
            await self._post_ok("rejectCall", data, "reject call")
        except WhatsappApiError as err:
            if err.status == 404 and err.code != "client_not_found":
                raise WhatsappUnsupportedCapability(
                    "the add-on does not provide the call rejection endpoint",
                    status=err.status,
                    code="unsupported_capability",
                ) from err
            raise

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
