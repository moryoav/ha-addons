"""Deliver durable inbox messages after HA has started; require explicit acknowledgements."""

from __future__ import annotations

import asyncio
import logging
from uuid import uuid4

from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import HomeAssistant, callback

from .client import WhatsappApiError, WhatsappClient

_LOGGER = logging.getLogger(__name__)
POLL_SECONDS = 10


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
        self._interrupted: str | None = None

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

    async def _run(self) -> None:
        opened = False
        unavailable = False
        while True:
            self._wake.clear()
            try:
                if not opened:
                    await self.client.async_inbox("open", {"session": self.session})
                    opened = True
                result = await self.poll()
                unavailable = False
                if result["status"] == "pending":
                    # Until the automation passes the atomic start gate, an event
                    # may be redelivered. Only one start request can succeed.
                    self.hass.bus.async_fire("new_whatsapp_message", result["message"])
                    self._interrupted = None
                elif result["status"] == "interrupted":
                    reference = result["inbox"]
                    if self._interrupted != reference["id"]:
                        self._interrupted = reference["id"]
                        self.hass.bus.async_fire(
                            "whatsapp_inbox_interrupted", {"inbox": reference}
                        )
                        _LOGGER.warning(
                            "WhatsApp inbox paused for an interrupted message; inspect get_inbox and resolve it explicitly"
                        )
            except WhatsappApiError as err:
                if err.code == "inbox_session_changed":
                    _LOGGER.warning(
                        "WhatsApp inbox consumer was replaced; reload this integration only if it should own delivery"
                    )
                    return
                if not unavailable:
                    _LOGGER.warning(
                        "WhatsApp inbox is temporarily unavailable; pending messages remain in the app"
                    )
                unavailable = True
            try:
                await asyncio.wait_for(self._wake.wait(), POLL_SECONDS)
            except TimeoutError:
                pass
