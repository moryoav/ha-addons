"""The WhatsApp integration."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import voluptuous as vol
from homeassistant.components import persistent_notification
from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import (
    ConfigEntryError,
    HomeAssistantError,
    ServiceValidationError,
)
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.device_registry import DeviceEntry
from homeassistant.helpers.typing import ConfigType
from homeassistant.setup import async_setup_component

from .client import (
    WhatsappApiError,
    WhatsappCannotConnect,
    WhatsappClient,
    WhatsappUnsupportedCapability,
    normalize_group_target,
    normalize_phone_target,
    normalize_profile_target,
    normalize_voice_target,
    validate_call_reference,
)
from .const import (
    ATTR_BODY,
    ATTR_CALL_ID,
    ATTR_CLIENT_ID,
    ATTR_FROM,
    ATTR_MESSAGE,
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
    SERVICE_GET_CONTACTS,
    SERVICE_GET_GROUP_INFO,
    SERVICE_GET_PROFILE,
    SERVICE_HANG_UP,
    SERVICE_LIST_GROUPS,
    SERVICE_MAKE_CALL,
    SERVICE_PRESENCE_SUBSCRIBE,
    SERVICE_READ_MESSAGES,
    SERVICE_REJECT_CALL,
    SERVICE_SEND_INFINITY_PRESENCE_UPDATE,
    SERVICE_SEND_MESSAGE,
    SERVICE_SEND_PRESENCE_UPDATE,
    SERVICE_SET_STATUS,
)
from .coordinator import WhatsappStatusCoordinator
from .entity import app_device_identifier
from .inbox import WhatsappInbox
from .media import WhatsAppMediaView

PLATFORMS = [Platform.BINARY_SENSOR, Platform.SENSOR]


@dataclass(slots=True)
class WhatsappRuntimeData:
    """Runtime data for a WhatsApp config entry."""

    client: WhatsappClient
    coordinator: WhatsappStatusCoordinator | None = None
    inbox: WhatsappInbox | None = None


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

GET_GROUP_INFO_SCHEMA = vol.Schema(
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

GET_PROFILE_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CLIENT_ID): cv.string,
        vol.Required(ATTR_TO): cv.string,
    }
)

LIST_GROUPS_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CLIENT_ID): cv.string,
    }
)

GET_CONTACTS_SCHEMA = LIST_GROUPS_SCHEMA

MAKE_CALL_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CLIENT_ID): cv.string,
        vol.Required(ATTR_TO): cv.string,
        vol.Optional(ATTR_MESSAGE): vol.All(cv.string, vol.Length(min=1, max=300)),
    }
)

HANG_UP_SCHEMA = LIST_GROUPS_SCHEMA

REJECT_CALL_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CLIENT_ID): cv.string,
        vol.Required(ATTR_CALL_ID): cv.string,
        vol.Required(ATTR_FROM): cv.string,
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

    if not await async_setup_component(hass, "http", {}):
        return False
    hass.http.register_view(WhatsAppMediaView(hass))

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

    async def async_get_group_info(call: ServiceCall) -> dict[str, Any]:
        try:
            jid = normalize_group_target(call.data[ATTR_TO])
        except ValueError as err:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="invalid_group_target",
            ) from err

        return await _async_call_api(
            hass,
            SERVICE_GET_GROUP_INFO,
            {**call.data, ATTR_TO: jid},
            lambda client, data: client.async_get_group_info(data),
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

    async def async_get_profile(call: ServiceCall) -> dict[str, Any]:
        try:
            jid = normalize_profile_target(call.data[ATTR_TO])
        except ValueError as err:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="invalid_profile_target",
            ) from err

        return await _async_call_api(
            hass,
            SERVICE_GET_PROFILE,
            {**call.data, ATTR_TO: jid},
            lambda client, data: client.async_get_profile(data),
        )

    async def async_list_groups(call: ServiceCall) -> dict[str, Any]:
        return await _async_call_api(
            hass,
            SERVICE_LIST_GROUPS,
            call.data,
            lambda client, data: client.async_list_groups(data),
        )

    async def async_get_contacts(call: ServiceCall) -> dict[str, Any]:
        """Return saved contacts for the explicitly selected WhatsApp account."""
        return await _async_call_api(
            hass,
            SERVICE_GET_CONTACTS,
            call.data,
            lambda client, data: client.async_get_contacts(data),
        )

    async def async_reject_call(call: ServiceCall) -> None:
        try:
            validate_call_reference(call.data[ATTR_CALL_ID], call.data[ATTR_FROM])
        except ValueError as err:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="invalid_call_reference",
            ) from err

        await _async_call_api(
            hass,
            SERVICE_REJECT_CALL,
            call.data,
            lambda client, data: client.async_reject_call(data),
        )

    async def async_make_call(call: ServiceCall) -> dict[str, Any] | None:
        """Call one WhatsApp user, optionally announcing an automation message."""
        try:
            target = normalize_voice_target(call.data[ATTR_TO])
        except ValueError as err:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="invalid_voice_target",
            ) from err
        result = await _async_call_api(
            hass,
            SERVICE_MAKE_CALL,
            {**call.data, ATTR_TO: target},
            lambda client, data: client.async_make_call(data),
        )
        return result if call.return_response else None

    async def async_hang_up(call: ServiceCall) -> dict[str, Any] | None:
        """End the active voice call without touching messaging sessions."""
        result = await _async_call_api(
            hass,
            SERVICE_HANG_UP,
            call.data,
            lambda client, data: client.async_hang_up(data),
        )
        return result if call.return_response else None

    hass.services.async_register(
        DOMAIN,
        SERVICE_MAKE_CALL,
        async_make_call,
        schema=MAKE_CALL_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_HANG_UP,
        async_hang_up,
        schema=HANG_UP_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
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
        SERVICE_GET_GROUP_INFO,
        async_get_group_info,
        schema=GET_GROUP_INFO_SCHEMA,
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
    hass.services.async_register(
        DOMAIN,
        SERVICE_GET_PROFILE,
        async_get_profile,
        schema=GET_PROFILE_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_LIST_GROUPS,
        async_list_groups,
        schema=LIST_GROUPS_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_GET_CONTACTS,
        async_get_contacts,
        schema=GET_CONTACTS_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_REJECT_CALL,
        async_reject_call,
        schema=REJECT_CALL_SCHEMA,
    )

    async def inbox_action(call: ServiceCall) -> dict:
        runtime = next(
            (
                entry.runtime_data
                for entry in hass.config_entries.async_entries(DOMAIN)
                if isinstance(getattr(entry, "runtime_data", None), WhatsappRuntimeData)
            ),
            None,
        )
        worker = runtime.inbox if runtime else None
        if worker is None:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="inbox_disabled",
            )
        operations = {
            "get_inbox": "poll",
            "start_inbox_message": "start",
            "complete_inbox_message": "complete",
            "resolve_inbox_message": "resolve",
            "resolve_inbox_messages": "resolve_many",
            "recover_inbox": "recover",
        }
        data = (
            {"session": worker.session, "inspect": True}
            if call.service == "get_inbox"
            else dict(call.data)
        )
        if call.service == "resolve_inbox_messages":
            if not data.get("reason") and not data.get("clientId"):
                raise ServiceValidationError(
                    translation_domain=DOMAIN, translation_key="inbox_filter_required"
                )
            data["session"] = worker.session
        result = await _async_call_api(
            hass,
            call.service,
            data,
            lambda client, values: client.async_inbox(operations[call.service], values),
        )
        if call.service != "get_inbox":
            worker.wake()
        if call.service == "recover_inbox":
            persistent_notification.async_dismiss(hass, "whatsapp_inbox_storage")
        return result

    for action in [
        "get_inbox",
        "start_inbox_message",
        "complete_inbox_message",
        "resolve_inbox_message",
        "resolve_inbox_messages",
        "recover_inbox",
    ]:
        fields = (
            {}
            if action in {"get_inbox", "resolve_inbox_messages", "recover_inbox"}
            else {vol.Required("inbox"): dict}
        )
        if action == "resolve_inbox_message":
            fields[vol.Required("resolution")] = vol.In(["retry", "discard", "hold"])
        elif action == "resolve_inbox_messages":
            fields = {
                vol.Required("resolution"): vol.In(["retry", "discard"]),
                vol.Optional("reason"): vol.In(
                    [
                        "unclaimed",
                        "preparation_timeout",
                        "processing_timeout",
                        "preparation_interrupted",
                        "processing_interrupted",
                        "workflow_failed",
                        "account_disabled",
                    ]
                ),
                vol.Optional("clientId"): cv.string,
            }
        elif action == "recover_inbox":
            fields = {
                vol.Optional("mode", default="reload"): vol.In(["reload", "reset"])
            }
        hass.services.async_register(
            DOMAIN,
            action,
            inbox_action,
            schema=vol.Schema(fields),
            supports_response=SupportsResponse.ONLY
            if action
            in {
                "get_inbox",
                "start_inbox_message",
                "resolve_inbox_messages",
                "recover_inbox",
            }
            else SupportsResponse.OPTIONAL,
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

    coordinator = WhatsappStatusCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = WhatsappRuntimeData(client=client, coordinator=coordinator)
    dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, app_device_identifier(entry))},
        name="WhatsApp app",
        model="WhatsApp app",
        entry_type=dr.DeviceEntryType.SERVICE,
    )
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    if client.capabilities is not None and "message_inbox" in client.capabilities:
        inbox = WhatsappInbox(hass, client)
        entry.runtime_data.inbox = inbox
        entry.async_on_unload(inbox.stop)
        inbox.start()
    entry.async_on_unload(entry.add_update_listener(_async_update_entry))
    return True


async def _async_update_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Apply refreshed discovery credentials without user configuration."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a WhatsApp config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def async_remove_config_entry_device(
    hass: HomeAssistant, entry: ConfigEntry, device_entry: DeviceEntry
) -> bool:
    """Allow removal of accounts absent from a successful status snapshot."""
    coordinator = entry.runtime_data.coordinator
    if (
        coordinator is None
        or not coordinator.last_update_success
        or coordinator.data is None
    ):
        return False
    if (DOMAIN, app_device_identifier(entry)) in device_entry.identifiers:
        return False
    active_identifiers = {
        (DOMAIN, f"{entry.entry_id}_account_{client_id}")
        for client_id in coordinator.data
    }
    return not bool(device_entry.identifiers & active_identifiers)


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
