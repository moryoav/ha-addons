"""Shared account entity and device identity."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import WhatsappStatusCoordinator


def app_device_identifier(entry: ConfigEntry) -> str:
    """Return a stable identity for the shared app device."""
    return f"{entry.entry_id}_app"


class WhatsappAccountEntity(CoordinatorEntity[WhatsappStatusCoordinator]):
    """An entity belonging to one configured WhatsApp account."""

    _attr_has_entity_name = True
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(
        self,
        coordinator: WhatsappStatusCoordinator,
        entry: ConfigEntry,
        client_id: str,
        key: str,
    ) -> None:
        """Keep account devices stable across reconnects and re-pairing."""
        super().__init__(coordinator)
        self.client_id = client_id
        identifier = f"{entry.entry_id}_account_{client_id}"
        self._attr_unique_id = f"{identifier}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, identifier)},
            name=f"WhatsApp ({client_id})",
            model="WhatsApp account",
            entry_type=DeviceEntryType.SERVICE,
            via_device=(DOMAIN, app_device_identifier(entry)),
        )

    @property
    def available(self) -> bool:
        """Do not report a stale state when account status cannot be read."""
        return (
            super().available
            and self.coordinator.data is not None
            and self.client_id in self.coordinator.data
        )
