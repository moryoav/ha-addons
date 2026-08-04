"""The WhatsApp integration."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, SOURCE_IMPORT
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import (
    ConfigEntryError,
    ConfigEntryNotReady,
    HomeAssistantError,
    ServiceValidationError,
)
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from .client import (
    WhatsappApiError,
    WhatsappCannotConnect,
    WhatsappClient,
    WhatsappUnsupportedCapability,
    normalize_phone_target,
)
from .const import (
    ATTR_BODY,
    ATTR_CLIENT_ID,
    ATTR_OPTIONS,
    ATTR_STATUS,
    ATTR_TO,
    ATTR_TYPE,
    ATTR_USER_ID,
    CONF_API_TOKEN,
    CONF_URL,
    DOMAIN,
    PRESENCE_TYPES,
    SERVICE_CHECK_NUMBER,
    SERVICE_PRESENCE_SUBSCRIBE,
    SERVICE_READ_MESSAGES,
    SERVICE_SEND_INFINITY_PRESENCE_UPDATE,
    SERVICE_SEND_MESSAGE,
    SERVICE_SEND_PRESENCE_UPDATE,
    SERVICE_SET_STATUS,
)


@dataclass(slots=True)
class WhatsappRuntimeData:
    """Runtime data for a WhatsApp config entry."""

    client: WhatsappClient


SEND_MESSAGE_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CLIENT_ID): cv.string,
        vol.Required(ATTR_TO): cv.string,
        vol.Required(ATTR_BODY): dict,
        vol.Optional(ATTR_OPTIONS): dict,
    }
)

CHECK_NUMBER_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CLIENT_ID): cv.string,
        vol.Required(ATTR_TO): cv.string,
    }
)

SET_STATUS_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CLIENT_ID): cv.string,
        vol.Required(ATTR_STATUS): cv.string,
    }
)

PRESENCE_SUBSCRIBE_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CLIENT_ID): cv.string,
        vol.Required(ATTR_USER_ID): cv.string,
    }
)

SEND_PRESENCE_UPDATE_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CLIENT_ID): cv.string,
        vol.Required(ATTR_TYPE): vol.In(PRESENCE_TYPES),
        vol.Optional(ATTR_TO): cv.string,
    }
)

READ_MESSAGES_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CLIENT_ID): cv.string,
        vol.Required(ATTR_BODY): dict,
    }
)

ServiceHandler = Callable[[WhatsappClient, dict[str, Any]], Awaitable[Any]]

CONFIG_SCHEMA = cv.empty_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the WhatsApp integration and register service actions."""
    if DOMAIN in config and not hass.config_entries.async_entries(DOMAIN):
        hass.async_create_task(
            hass.config_entries.flow.async_init(
                DOMAIN,
                context={"source": SOURCE_IMPORT},
                data={},
            )
        )

    if hass.services.has_service(DOMAIN, SERVICE_SEND_MESSAGE):
        return True

    async def async_send_message(call: ServiceCall) -> dict[str, Any] | None:
        result = await _async_call_api(
            hass,
            SERVICE_SEND_MESSAGE,
            call.data,
            lambda client, data: client.async_send_message(data),
        )

        event_data = {
            "client_id": call.data[ATTR_CLIENT_ID],
            "to": call.data[ATTR_TO],
            "body": call.data[ATTR_BODY],
            "sent_message": result,
        }

        hass.bus.async_fire("whatsapp_send_message_result", event_data)

        if call.return_response:
            message_key = result.get("key")
            return {
                **event_data,
                "message_id": message_key.get("id")
                if isinstance(message_key, dict)
                else None,
            }
        return None

    async def async_check_number(call: ServiceCall) -> dict[str, Any]:
        try:
            jid = normalize_phone_target(call.data[ATTR_TO])
        except ValueError as err:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="invalid_phone_target",
            ) from err

        return await _async_call_api(
            hass,
            SERVICE_CHECK_NUMBER,
            {**call.data, ATTR_TO: jid},
            lambda client, data: client.async_check_number(data),
        )

    async def async_set_status(call: ServiceCall) -> None:
        await _async_call_api(
            hass,
            SERVICE_SET_STATUS,
            call.data,
            lambda client, data: client.async_set_status(data),
        )

    async def async_presence_subscribe(call: ServiceCall) -> None:
        await _async_call_api(
            hass,
            SERVICE_PRESENCE_SUBSCRIBE,
            call.data,
            lambda client, data: client.async_presence_subscribe(data),
        )

    async def async_send_presence_update(call: ServiceCall) -> None:
        await _async_call_api(
            hass,
            SERVICE_SEND_PRESENCE_UPDATE,
            call.data,
            lambda client, data: client.async_send_presence_update(data),
        )

    async def async_send_infinity_presence_update(call: ServiceCall) -> None:
        await _async_call_api(
            hass,
            SERVICE_SEND_INFINITY_PRESENCE_UPDATE,
            call.data,
            lambda client, data: client.async_send_infinity_presence_update(data),
        )

    async def async_read_messages(call: ServiceCall) -> None:
        await _async_call_api(
            hass,
            SERVICE_READ_MESSAGES,
            call.data,
            lambda client, data: client.async_read_messages(data),
        )

    hass.services.async_register(
        DOMAIN,
        SERVICE_SEND_MESSAGE,
        async_send_message,
        schema=SEND_MESSAGE_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_CHECK_NUMBER,
        async_check_number,
        schema=CHECK_NUMBER_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_STATUS,
        async_set_status,
        schema=SET_STATUS_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_PRESENCE_SUBSCRIBE,
        async_presence_subscribe,
        schema=PRESENCE_SUBSCRIBE_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_SEND_PRESENCE_UPDATE,
        async_send_presence_update,
        schema=SEND_PRESENCE_UPDATE_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_SEND_INFINITY_PRESENCE_UPDATE,
        async_send_infinity_presence_update,
        schema=SEND_PRESENCE_UPDATE_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_READ_MESSAGES,
        async_read_messages,
        schema=READ_MESSAGES_SCHEMA,
    )

    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up WhatsApp from a config entry."""
    try:
        client = WhatsappClient(
            async_get_clientsession(hass),
            entry.data[CONF_URL],
            api_token=entry.data.get(CONF_API_TOKEN),
        )
    except ValueError as err:
        raise ConfigEntryError(
            translation_domain=DOMAIN,
            translation_key="invalid_api_token_config",
        ) from err

    try:
        await client.async_health()
    except WhatsappCannotConnect as err:
        raise ConfigEntryNotReady("Could not connect to the WhatsApp add-on") from err

    entry.runtime_data = WhatsappRuntimeData(client=client)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a WhatsApp config entry."""
    return True


def _get_client(hass: HomeAssistant) -> WhatsappClient:
    """Return the loaded WhatsApp client."""
    for entry in hass.config_entries.async_entries(DOMAIN):
        runtime_data = getattr(entry, "runtime_data", None)
        if isinstance(runtime_data, WhatsappRuntimeData):
            return runtime_data.client

    raise ServiceValidationError(
        translation_domain=DOMAIN,
        translation_key="not_configured",
    )


async def _async_call_api(
    hass: HomeAssistant,
    action: str,
    data: dict[str, Any],
    handler: ServiceHandler,
) -> Any:
    """Call the add-on API and translate failures for Home Assistant."""
    client = _get_client(hass)

    try:
        return await handler(client, data)
    except WhatsappUnsupportedCapability as err:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="addon_too_old",
        ) from err
    except WhatsappCannotConnect as err:
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="cannot_connect",
            translation_placeholders={"action": action},
        ) from err
    except WhatsappApiError as err:
        if err.code in {"invalid_request", "client_not_found", "number_not_found"}:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key=err.code,
            ) from err

        translated_api_errors = {
            "unauthorized": "unauthorized",
            "client_disconnected": "client_disconnected",
            "rate_limited": "rate_limited",
            "upstream_error": "upstream_error",
        }
        translation_key = translated_api_errors.get(err.code, "api_request_failed")
        error_code = err.code or (
            f"http_{err.status}" if err.status is not None else "unknown"
        )
        if err.code == "rate_limited":
            translation_placeholders = {}
        elif err.code in translated_api_errors:
            translation_placeholders = {"action": action}
        else:
            translation_placeholders = {
                "action": action,
                "error_code": error_code,
            }
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key=translation_key,
            translation_placeholders=translation_placeholders,
        ) from err
