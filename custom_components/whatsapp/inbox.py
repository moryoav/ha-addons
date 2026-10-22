"""Deliver durable inbox messages after HA has started; require explicit acknowledgements."""

from __future__ import annotations

import asyncio
import logging
from time import monotonic
from uuid import uuid4

from homeassistant.components import persistent_notification
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import HomeAssistant, callback

from .client import WhatsappApiError, WhatsappClient

_LOGGER = logging.getLogger(__name__)
POLL_SECONDS = 10
REDELIVERY_SECONDS = 20
MAX_DELIVERIES = 3


class WhatsappInbox:
    """One consumer session per loaded integration; no private payloads in logs."""

    def __init__(self, hass: HomeAssistant, client: WhatsappClient) -> None:
        self.hass = hass
        self.client = client
        self.session = uuid4().hex
        self._task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._remove_started = None
        self._remove_updated = None
        self._announced: set[tuple[str, str, str]] = set()
        self._deliveries: dict[tuple[str, str], tuple[int, float]] = {}
        self._attention_count: int | None = None

    @callback
    def start(self) -> None:
        """Wait for automations and the rest of HA before emitting incoming events."""
        self._remove_updated = self.hass.bus.async_listen(
            "whatsapp_inbox_updated", self.wake
        )
        if self.hass.is_running:
            self._start_task()
        else:
            self._remove_started = self.hass.bus.async_listen_once(
                EVENT_HOMEASSISTANT_STARTED, self._start_task
            )

    @callback
    def _start_task(self, event=None) -> None:
        if self._task is None:
            self._task = self.hass.async_create_background_task(
                self._run(), "whatsapp message inbox"
            )

    @callback
    def wake(self, event=None) -> None:
        self._wake.set()

    @callback
    def stop(self) -> None:
        if self._remove_started:
            self._remove_started()
            self._remove_started = None
        if self._remove_updated:
            self._remove_updated()
            self._remove_updated = None
        if self._task:
            self._task.cancel()

    async def poll(self) -> dict:
        return await self.client.async_inbox("poll", {"session": self.session})

    @callback
    def _handle_result(self, result: dict) -> None:
        """Bound event redelivery and report held messages without private content."""
        attention = result.get("attention", [])
        initial = self._attention_count is None
        new_count = 0
        announced = set()
        for item in attention:
            reference = item["inbox"]
            identity = (reference["id"], reference["receipt"], item["reason"])
            announced.add(identity)
            self._deliveries.pop(identity[:2], None)
            # The initial snapshot is a backlog reminder, not a new transition.
            # Keep its notification without replaying per-message automations.
            if not initial and identity not in self._announced:
                new_count += 1
                self.hass.bus.async_fire("whatsapp_inbox_attention", item)
                if item["status"] == "interrupted":
                    self.hass.bus.async_fire(
                        "whatsapp_inbox_interrupted", {"inbox": reference}
                    )
        self._announced = announced
        if (initial and attention) or new_count:
            _LOGGER.warning(
                "%s WhatsApp inbox message(s) need review; inspect get_inbox and resolve them explicitly",
                len(attention) if initial else new_count,
            )
        if len(attention) != self._attention_count:
            self._attention_count = len(attention)
            if attention:
                persistent_notification.async_create(
                    self.hass,
                    f"{len(attention)} WhatsApp inbox message(s) need review. "
                    "Use WhatsApp: Get message inbox in Developer Tools > Actions. "
                    "Inspect the attention list and use Resolve inbox message, or Resolve held inbox messages with account/reason filters. "
                    "Other messages can continue. Check whether actions already ran before retrying.",
                    title="WhatsApp message inbox needs attention",
                    notification_id="whatsapp_inbox_attention",
                )
            else:
                persistent_notification.async_dismiss(
                    self.hass, "whatsapp_inbox_attention"
                )
        if result["status"] == "pending":
            message = result["message"]
            reference = message["inbox"]
            identity = (reference["id"], reference["receipt"])
            attempts, last = self._deliveries.get(identity, (0, float("-inf")))
            if attempts < MAX_DELIVERIES and monotonic() - last >= REDELIVERY_SECONDS:
                self.hass.bus.async_fire("new_whatsapp_message", message)
                self._deliveries[identity] = (attempts + 1, monotonic())
            # The app has at most 1,000 unfinished entries. Keep this cache bounded
            # even if an operator continually discards and adds messages.
            while len(self._deliveries) > 1000:
                self._deliveries.pop(next(iter(self._deliveries)))
        elif result["status"] == "empty":
            self._deliveries.clear()

    async def _run(self) -> None:
        opened = False
        unavailable = False
        healthy = False
        while True:
            self._wake.clear()
            try:
                if not opened:
                    await self.client.async_inbox("open", {"session": self.session})
                    opened = True
                result = await self.poll()
                if unavailable or not healthy:
                    persistent_notification.async_dismiss(
                        self.hass, "whatsapp_inbox_connection"
                    )
                unavailable = False
                healthy = True
                self._handle_result(result)
            except WhatsappApiError as err:
                if err.code == "unsupported_capability":
                    persistent_notification.async_dismiss(
                        self.hass, "whatsapp_inbox_connection"
                    )
                    persistent_notification.async_dismiss(
                        self.hass, "whatsapp_inbox_attention"
                    )
                    _LOGGER.info(
                        "WhatsApp inbox support is disabled; reload the integration after enabling it"
                    )
                    return
                if err.code == "inbox_session_changed":
                    # A restored app snapshot may contain an older HA session.
                    # Reopen after the normal backoff; only one HA consumer is supported.
                    opened = False
                if not unavailable:
                    _LOGGER.warning(
                        "WhatsApp inbox is unavailable; delivery will retry automatically. Check the app connection and inbox storage"
                    )
                    persistent_notification.async_create(
                        self.hass,
                        "Message inbox delivery is unavailable. The integration will retry "
                        "automatically. Use WhatsApp: Recover message inbox in Developer Tools > Actions "
                        "to reload storage or reset unreadable state while preserving an archive. "
                        "If inbox storage failed, new messages use live delivery without restart recovery.",
                        title="WhatsApp message inbox unavailable",
                        notification_id="whatsapp_inbox_connection",
                    )
                unavailable = True
            try:
                await asyncio.wait_for(self._wake.wait(), POLL_SECONDS)
            except TimeoutError:
                pass
