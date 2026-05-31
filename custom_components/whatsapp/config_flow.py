"""Config flow for the WhatsApp integration."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import WhatsappCannotConnect, WhatsappClient
from .const import CONF_URL, DEFAULT_URL, DOMAIN


class InvalidUrl(Exception):
    """Raised when the add-on URL is invalid."""


class WhatsappConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for WhatsApp."""

    VERSION = 1

    async def async_step_user(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> FlowResult:
        """Handle the initial setup step."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        return await self._async_step_with_url("user", user_input)

    async def async_step_reconfigure(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> FlowResult:
        """Handle a reconfiguration flow."""
        return await self._async_step_with_url("reconfigure", user_input)

    async def _async_step_with_url(
        self,
        step_id: str,
        user_input: dict[str, Any] | None,
    ) -> FlowResult:
        """Handle setup steps that collect and validate an add-on URL."""
        errors: dict[str, str] = {}
        default_url = DEFAULT_URL

        if step_id == "reconfigure":
            default_url = self._get_reconfigure_entry().data[CONF_URL]

        if user_input is not None:
            try:
                url = _normalize_url(user_input[CONF_URL])
                await _async_validate_url(self.hass, url)
            except InvalidUrl:
                errors["base"] = "invalid_url"
            except WhatsappCannotConnect:
                errors["base"] = "cannot_connect"
            else:
                if step_id == "reconfigure":
                    return self.async_update_reload_and_abort(
                        self._get_reconfigure_entry(),
                        data_updates={CONF_URL: url},
                    )

                await self.async_set_unique_id(DOMAIN)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title="WhatsApp Add-on",
                    data={CONF_URL: url},
                )

        return self.async_show_form(
            step_id=step_id,
            data_schema=vol.Schema({vol.Required(CONF_URL, default=default_url): str}),
            errors=errors,
        )


def _normalize_url(url: str) -> str:
    """Normalize and validate a user-provided add-on URL."""
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise InvalidUrl
    return url.strip().rstrip("/")


async def _async_validate_url(hass: HomeAssistant, url: str) -> None:
    """Validate that the add-on URL is reachable."""
    client = WhatsappClient(async_get_clientsession(hass), url)
    await client.async_health()
