"""Build WhatsApp send payloads from action data."""

from collections.abc import Mapping
from typing import Any

import voluptuous as vol
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv

from .const import (
    ATTR_BODY,
    ATTR_CLIENT_ID,
    ATTR_MESSAGE,
    ATTR_OPTIONS,
    ATTR_TO,
    DOMAIN,
)

_ATTR_REPLY_TO = "reply_to"

SEND_MESSAGE_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CLIENT_ID): cv.string,
        vol.Required(ATTR_TO): cv.string,
        vol.Exclusive(ATTR_BODY, "message_content"): dict,
        vol.Exclusive(ATTR_MESSAGE, "message_content"): dict,
        vol.Optional(ATTR_OPTIONS): dict,
        vol.Optional(_ATTR_REPLY_TO): vol.Any(dict, None),
    }
)

_NONEMPTY_TEXT = vol.All(str, vol.Length(min=1))
_MEDIA_URL = {vol.Required("url"): _NONEMPTY_TEXT}
_CAPTION = {vol.Optional("caption"): str}
_IMAGE_VIDEO = vol.Schema({**_MEDIA_URL, **_CAPTION})
_MEDIA_SCHEMAS = {
    "Image": _IMAGE_VIDEO,
    "Video": _IMAGE_VIDEO,
    "Sticker": vol.Schema(_MEDIA_URL),
    "Audio": vol.Schema({**_MEDIA_URL, vol.Optional("ptt"): bool}),
    "Document": vol.Schema(
        {
            **_MEDIA_URL,
            **_CAPTION,
            vol.Required("file_name"): _NONEMPTY_TEXT,
            vol.Optional("mimetype"): str,
        }
    ),
}
_CONTENT_SCHEMAS = {
    "Text": _NONEMPTY_TEXT,
    "Location": vol.Schema(
        {
            vol.Required("latitude"): vol.All(
                vol.Coerce(float), vol.Range(min=-90, max=90)
            ),
            vol.Required("longitude"): vol.All(
                vol.Coerce(float), vol.Range(min=-180, max=180)
            ),
        }
    ),
    "Poll": vol.Schema(
        {
            vol.Required("name"): _NONEMPTY_TEXT,
            vol.Required("values"): vol.All([_NONEMPTY_TEXT], vol.Length(min=2)),
        }
    ),
    "Custom YAML": vol.Schema(dict),
    **_MEDIA_SCHEMAS,
}


def _message_body(message: dict[str, Any]) -> dict[str, Any]:
    """Convert only the active Home Assistant choice to a Baileys body."""
    choice = message.get("active_choice")
    if (
        not isinstance(choice, str)
        or choice not in _CONTENT_SCHEMAS
        or choice not in message
    ):
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="send_message_content_required",
        )

    try:
        content = _CONTENT_SCHEMAS[choice](message[choice])
    except vol.Invalid as err:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="send_message_invalid_content",
            translation_placeholders={"error": str(err)},
        ) from err

    if choice == "Custom YAML":
        return content
    kind = choice.lower()
    if choice == "Location":
        return {
            kind: {
                "degreesLatitude": content["latitude"],
                "degreesLongitude": content["longitude"],
            }
        }
    if choice in _MEDIA_SCHEMAS:
        url = content.pop("url")
        if choice == "Document":
            content["fileName"] = content.pop("file_name")
        return {kind: {"url": url}, **content}
    return {kind: content}


def prepare_send_message(data: Mapping[str, Any]) -> dict[str, Any]:
    """Keep the add-on payload and result event compatible with YAML calls."""
    payload = dict(data)
    if ATTR_MESSAGE in payload:
        payload[ATTR_BODY] = _message_body(payload.pop(ATTR_MESSAGE))
    if ATTR_BODY not in payload:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="send_message_content_required",
        )

    if _ATTR_REPLY_TO in payload:
        quote = payload.pop(_ATTR_REPLY_TO)
        if (
            not isinstance(quote, dict)
            or not isinstance(quote.get("key"), dict)
            or not quote["key"].get("id")
            or not isinstance(quote.get("message"), dict)
            or not quote["message"]
        ):
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="send_message_invalid_quote",
            )
        payload[ATTR_OPTIONS] = {**payload.get(ATTR_OPTIONS, {}), "quoted": quote}
    return payload
