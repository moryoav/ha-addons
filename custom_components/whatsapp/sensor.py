"""WhatsApp account session state sensors."""

from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import SESSION_STATES
from .coordinator import WhatsappStatusCoordinator
from .entity import WhatsappAccountEntity

PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Discover one session sensor for each configured account."""
    coordinator = entry.runtime_data.coordinator
    known_accounts: set[str] = set()

    @callback
    def async_add_accounts() -> None:
        if not coordinator.last_update_success or coordinator.data is None:
            return
        new_accounts = set(coordinator.data) - known_accounts
        known_accounts.update(new_accounts)
        entities = []
        for client_id in sorted(new_accounts):
            entity = WhatsappSessionState(coordinator, entry, client_id)
            entity.async_on_remove(
                lambda client_id=client_id: known_accounts.discard(client_id)
            )
            entities.append(entity)
        async_add_entities(entities)

    async_add_accounts()
    entry.async_on_unload(coordinator.async_add_listener(async_add_accounts))


class WhatsappSessionState(WhatsappAccountEntity, SensorEntity):
    """The local session state of one WhatsApp account."""

    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = list(SESSION_STATES)
    _attr_translation_key = "session_state"

    def __init__(
        self, coordinator: WhatsappStatusCoordinator, entry: ConfigEntry, client_id: str
    ) -> None:
        """Initialize the account session sensor."""
        super().__init__(coordinator, entry, client_id, "session_state")

    @property
    def native_value(self) -> str | None:
        """Return the account's current session state."""
        return (self.coordinator.data or {}).get(self.client_id)
