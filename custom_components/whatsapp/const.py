"""Constants for the WhatsApp integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "whatsapp"

CONF_URL: Final = "url"
DEFAULT_TIMEOUT: Final = 10
ADDON_DISCOVERY_SERVICE: Final = DOMAIN
ADDON_PORT: Final = 3000
ADDON_FALLBACK_HOSTS: Final = (
    "ea396823-whatsapp-addon",
    "whatsapp-addon",
    "whatsapp_addon",
)

SERVICE_SEND_MESSAGE: Final = "send_message"
SERVICE_SET_STATUS: Final = "set_status"
SERVICE_PRESENCE_SUBSCRIBE: Final = "presence_subscribe"
SERVICE_SEND_PRESENCE_UPDATE: Final = "send_presence_update"
SERVICE_SEND_INFINITY_PRESENCE_UPDATE: Final = "send_infinity_presence_update"
SERVICE_READ_MESSAGES: Final = "read_messages"

ATTR_BODY: Final = "body"
ATTR_CLIENT_ID: Final = "clientId"
ATTR_OPTIONS: Final = "options"
ATTR_STATUS: Final = "status"
ATTR_TO: Final = "to"
ATTR_TYPE: Final = "type"
ATTR_USER_ID: Final = "userId"

PRESENCE_TYPES: Final = ("unavailable", "available", "composing", "recording", "paused")
