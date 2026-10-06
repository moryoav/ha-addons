"""Coordinated local app and account status updates."""

from __future__ import annotations

import logging
from datetime import timedelta

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .client import WhatsappApiError, WhatsappClient
from .const import CAPABILITY_GET_STATUS

_LOGGER = logging.getLogger(__name__)
UPDATE_INTERVAL = timedelta(seconds=30)


class WhatsappStatusCoordinator(DataUpdateCoordinator[dict[str, str] | None]):
    """Fetch one snapshot for all account entities."""

    def __init__(
        self, hass: HomeAssistant, entry: ConfigEntry, client: WhatsappClient
    ) -> None:
        """Initialize status monitoring."""
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name="WhatsApp app connection",
            update_interval=UPDATE_INTERVAL,
            always_update=False,
        )
        self.client = client
        self._status_unavailable = False

    async def _async_update_data(self) -> dict[str, str] | None:
        """Probe app reachability independently of account status."""
        try:
            await self.client.async_health()
        except WhatsappApiError:
            # Coordinator debug logs include tracebacks; suppress raw API errors.
            raise UpdateFailed("Could not reach the WhatsApp app") from None

        capabilities = self.client.capabilities
        if capabilities is None or CAPABILITY_GET_STATUS not in capabilities:
            return None

        try:
            accounts = await self.client.async_status()
        except WhatsappApiError:
            if not self._status_unavailable:
                _LOGGER.warning("WhatsApp account status is unavailable")
            self._status_unavailable = True
            return None

        if self._status_unavailable:
            _LOGGER.info("WhatsApp account status is available again")
        self._status_unavailable = False
        return accounts
