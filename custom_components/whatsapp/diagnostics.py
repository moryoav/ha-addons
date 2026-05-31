"""Diagnostics support for the WhatsApp integration."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from . import WhatsappRuntimeData
from .client import WhatsappApiError
from .const import CONF_URL


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant,
    entry: ConfigEntry,
) -> dict[str, Any]:
    """Return diagnostics for a config entry."""
    diagnostics: dict[str, Any] = {
        "entry": {
            "title": entry.title,
            "url_configured": bool(entry.data.get(CONF_URL)),
        },
        "addon": {
            "available": False,
        },
    }

    runtime_data = getattr(entry, "runtime_data", None)
    if not isinstance(runtime_data, WhatsappRuntimeData):
        return diagnostics

    try:
        health = await runtime_data.client.async_health()
    except WhatsappApiError as err:
        diagnostics["addon"]["error"] = err.__class__.__name__
        return diagnostics

    diagnostics["addon"] = {
        "available": True,
        "status": health.get("status"),
        "client_count": health.get("client_count"),
    }
    return diagnostics
