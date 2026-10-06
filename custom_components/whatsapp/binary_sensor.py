"""App and WhatsApp account connectivity sensors."""

from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import WhatsappStatusCoordinator
from .entity import WhatsappAccountEntity, app_device_identifier

PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Create the shared app sensor and discover account sensors."""
    coordinator = entry.runtime_data.coordinator
    async_add_entities([WhatsappAppConnection(coordinator, entry)])
    known_accounts: set[str] = set()

    @callback
    def async_add_accounts() -> None:
        if not coordinator.last_update_success or coordinator.data is None:
            return
        new_accounts = set(coordinator.data) - known_accounts
        known_accounts.update(new_accounts)
        entities = []
        for client_id in sorted(new_accounts):
            entity = WhatsappAccountConnection(coordinator, entry, client_id)
            entity.async_on_remove(
                lambda client_id=client_id: known_accounts.discard(client_id)
            )
            entities.append(entity)
        async_add_entities(entities)

    async_add_accounts()
    entry.async_on_unload(coordinator.async_add_listener(async_add_accounts))


class WhatsappAppConnection(
    CoordinatorEntity[WhatsappStatusCoordinator], BinarySensorEntity
):
    """Connectivity to the shared local WhatsApp app."""

    _attr_has_entity_name = True
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_translation_key = "app_connection"

    def __init__(
        self, coordinator: WhatsappStatusCoordinator, entry: ConfigEntry
    ) -> None:
        """Initialize the shared app device."""
        super().__init__(coordinator)
        identifier = app_device_identifier(entry)
        self._attr_unique_id = f"{identifier}_connection"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, identifier)},
            name="WhatsApp app",
            model="WhatsApp app",
            entry_type=DeviceEntryType.SERVICE,
        )

    @property
    def available(self) -> bool:
        """Keep the connectivity result visible during an app outage."""
        return True

    @property
    def is_on(self) -> bool:
        """Return whether the latest app health request succeeded."""
        return self.coordinator.last_update_success


class WhatsappAccountConnection(WhatsappAccountEntity, BinarySensorEntity):
    """Connectivity of one account to WhatsApp."""

    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_translation_key = "whatsapp_connection"

    def __init__(
        self, coordinator: WhatsappStatusCoordinator, entry: ConfigEntry, client_id: str
    ) -> None:
        """Initialize the account connection sensor."""
        super().__init__(coordinator, entry, client_id, "connection")

    @property
    def is_on(self) -> bool:
        """Return whether this account is connected to WhatsApp."""
        return (self.coordinator.data or {}).get(self.client_id) == "connected"
