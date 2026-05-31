"""Constants for the WhatsApp integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "whatsapp"

CONF_URL: Final = "url"
DEFAULT_URL: Final = "http://whatsapp_addon:3000"
DEFAULT_TIMEOUT: Final = 10

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
