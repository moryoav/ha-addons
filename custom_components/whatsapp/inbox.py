"""Accept app-owned inbox deliveries through the existing message event."""

import re
from collections import OrderedDict

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.components.http.decorators import require_admin
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import CoreState, HomeAssistant

from .const import DOMAIN


class WhatsAppInboxView(HomeAssistantView):
    """Wait for startup and acknowledge event delivery without automation changes."""

    url = "/api/whatsapp/inbox"
    name = "api:whatsapp:inbox"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        """Keep a bounded receipt cache for HTTP response-loss retries."""
        self.hass = hass
        self._delivered: OrderedDict[str, None] = OrderedDict()

    @require_admin
    async def get(self, request: web.Request) -> web.Response:
        """Let the app wait before downloading media while HA is unavailable."""
        if self.hass.state is not CoreState.running or not any(
            entry.state is ConfigEntryState.LOADED
            for entry in self.hass.config_entries.async_entries(DOMAIN)
        ):
            raise web.HTTPServiceUnavailable
        return self.json({"ready": True})

    @require_admin
    async def post(self, request: web.Request) -> web.Response:
        """Fire one ordinary message event and return its transport receipt."""
        try:
            body = await request.json()
            identity, message = body["id"], body["message"]
            if (
                not isinstance(identity, str)
                or not re.fullmatch(r"[a-f0-9]{64}", identity)
                or not isinstance(message, dict)
                or not isinstance(message.get("clientId"), str)
                or not re.fullmatch(
                    r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", message["clientId"]
                )
                or not isinstance(message.get("message"), dict)
                or not isinstance(message.get("key"), dict)
                or message["key"].get("fromMe") is not False
                or any(
                    not isinstance(message["key"].get(key), str)
                    or not message["key"][key]
                    for key in ("id", "remoteJid")
                )
            ):
                raise ValueError
        except (ValueError, KeyError, TypeError):
            raise web.HTTPBadRequest from None
        await self.get(request)
        # No await between readiness, event scheduling and caching its receipt.
        if identity not in self._delivered:
            self.hass.bus.async_fire("new_whatsapp_message", message)
            self._delivered[identity] = None
            if len(self._delivered) > 1000:
                self._delivered.popitem(last=False)
        return self.json({"delivered": identity})
