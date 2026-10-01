"""Constants for the WhatsApp integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "whatsapp"

CONF_URL: Final = "url"
CONF_API_TOKEN: Final = "api_token"
DEFAULT_TIMEOUT: Final = 10
ADDON_SERVICE: Final = "ha-whatsapp-addon"
ADDON_API_VERSION: Final = 1
ADDON_DISCOVERY_SERVICE: Final = DOMAIN
ADDON_PORT: Final = 3000
ADDON_FALLBACK_HOSTS: Final = (
    "ea396823-whatsapp-addon",
    "whatsapp-addon",
    "whatsapp_addon",
)

SERVICE_SEND_MESSAGE: Final = "send_message"
SERVICE_CHECK_NUMBER: Final = "check_number"
SERVICE_GET_GROUP_INFO: Final = "get_group_info"
SERVICE_SET_STATUS: Final = "set_status"
SERVICE_PRESENCE_SUBSCRIBE: Final = "presence_subscribe"
SERVICE_SEND_PRESENCE_UPDATE: Final = "send_presence_update"
SERVICE_SEND_INFINITY_PRESENCE_UPDATE: Final = "send_infinity_presence_update"
SERVICE_READ_MESSAGES: Final = "read_messages"
SERVICE_REJECT_CALL: Final = "reject_call"
SERVICE_GET_PROFILE: Final = "get_profile"
SERVICE_LIST_GROUPS: Final = "list_groups"

CAPABILITY_CHECK_NUMBER: Final = SERVICE_CHECK_NUMBER
CAPABILITY_GET_GROUP_INFO: Final = SERVICE_GET_GROUP_INFO
CAPABILITY_REJECT_CALL: Final = SERVICE_REJECT_CALL
CAPABILITY_GET_PROFILE: Final = SERVICE_GET_PROFILE
CAPABILITY_LIST_GROUPS: Final = SERVICE_LIST_GROUPS

ATTR_BODY: Final = "body"
ATTR_CALL_ID: Final = "callId"
ATTR_CLIENT_ID: Final = "clientId"
ATTR_FROM: Final = "from"
ATTR_OPTIONS: Final = "options"
ATTR_STATUS: Final = "status"
ATTR_TO: Final = "to"
ATTR_TYPE: Final = "type"
ATTR_USER_ID: Final = "userId"

PRESENCE_TYPES: Final = ("unavailable", "available", "composing", "recording", "paused")
