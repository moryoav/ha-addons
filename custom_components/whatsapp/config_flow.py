"""Config flow for the WhatsApp integration."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any
from urllib.parse import urlparse

import voluptuous as vol

from homeassistant import config_entries
try:
    from homeassistant.components.hassio import HassioServiceInfo, get_addons_info
except ImportError:  # pragma: no cover - Home Assistant installations provide hassio.
    HassioServiceInfo = Any
    get_addons_info = None
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import WhatsappCannotConnect, WhatsappClient
from .const import (
    ADDON_FALLBACK_HOSTS,
    ADDON_PORT,
    CONF_URL,
    DOMAIN,
)


class InvalidUrl(Exception):
    """Raised when the add-on URL is invalid."""


class WhatsappConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for WhatsApp."""

    VERSION = 1

    async def async_step_user(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> FlowResult:
        """Handle a user-initiated setup attempt."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        try:
            url = await _async_detect_addon_url(self.hass)
        except WhatsappCannotConnect:
            return self.async_show_form(
                step_id="user",
                data_schema=vol.Schema({}),
                errors={"base": "cannot_connect"} if user_input is not None else {},
            )

        return await self._async_create_or_update_entry(url)

    async def async_step_import(self, user_input: dict[str, Any]) -> FlowResult:
        """Handle YAML import by discovering the local add-on."""
        try:
            url = await _async_detect_addon_url(self.hass)
        except WhatsappCannotConnect:
            return self.async_abort(reason="cannot_connect")

        return await self._async_create_or_update_entry(url)

    async def async_step_hassio(self, discovery_info: HassioServiceInfo) -> FlowResult:
        """Handle Supervisor add-on discovery."""
        urls = []
        if url := _url_from_discovery_config(discovery_info.config):
            urls.append(url)

        try:
            url = await _async_detect_addon_url(self.hass, urls)
        except WhatsappCannotConnect:
            return self.async_abort(reason="cannot_connect")

        return await self._async_create_or_update_entry(
            url,
            title=getattr(discovery_info, "name", "WhatsApp Add-on"),
        )

    async def async_step_reconfigure(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> FlowResult:
        """Handle reconfiguration by rediscovering the add-on URL."""
        try:
            url = await _async_detect_addon_url(self.hass)
        except WhatsappCannotConnect:
            return self.async_show_form(
                step_id="reconfigure",
                data_schema=vol.Schema({}),
                errors={"base": "cannot_connect"} if user_input is not None else {},
            )

        return self._update_entry_and_abort(self._get_reconfigure_entry(), url)

    async def _async_create_or_update_entry(
        self,
        url: str,
        *,
        title: str = "WhatsApp Add-on",
    ) -> FlowResult:
        """Create the single config entry or update the existing one."""
        await self.async_set_unique_id(DOMAIN)

        for entry in self._async_current_entries():
            self.hass.config_entries.async_update_entry(
                entry,
                data={**entry.data, CONF_URL: url},
            )
            return self.async_abort(reason="already_configured")

        return self.async_create_entry(title=title, data={CONF_URL: url})

    def _update_entry_and_abort(self, entry: config_entries.ConfigEntry, url: str):
        """Update an entry and abort, supporting older Home Assistant test cores."""
        if hasattr(self, "async_update_reload_and_abort"):
            return self.async_update_reload_and_abort(
                entry,
                data_updates={CONF_URL: url},
            )

        self.hass.config_entries.async_update_entry(
            entry,
            data={**entry.data, CONF_URL: url},
        )
        return self.async_abort(reason="reconfigure_successful")


def _url_from_discovery_config(config: dict[str, Any]) -> str | None:
    """Build an add-on URL from Supervisor discovery config."""
    if url := config.get(CONF_URL):
        return _normalize_url(url)

    host = config.get(CONF_HOST)
    port = config.get(CONF_PORT, ADDON_PORT)
    if host:
        return _normalize_url(f"http://{host}:{port}")

    return None


def _normalize_url(url: str) -> str:
    """Normalize and validate an add-on URL."""
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise InvalidUrl
    return url.strip().rstrip("/")


async def _async_detect_addon_url(
    hass: HomeAssistant,
    preferred_urls: Iterable[str] = (),
) -> str:
    """Detect the local WhatsApp add-on URL."""
    for url in _candidate_urls(hass, preferred_urls):
        try:
            await _async_validate_url(hass, url)
        except WhatsappCannotConnect:
            continue
        return url

    raise WhatsappCannotConnect("Could not detect the WhatsApp add-on")


def _candidate_urls(hass: HomeAssistant, preferred_urls: Iterable[str]) -> list[str]:
    """Return ordered candidate add-on URLs."""
    candidates: list[str] = []
    candidates.extend(preferred_urls)

    if get_addons_info is not None and (addons_info := get_addons_info(hass)):
        for slug, addon in addons_info.items():
            if _is_whatsapp_addon(slug, addon):
                candidates.extend(_addon_info_urls(slug, addon))

    candidates.extend(f"http://{host}:{ADDON_PORT}" for host in ADDON_FALLBACK_HOSTS)
    return _dedupe_urls(candidates)


def _is_whatsapp_addon(slug: str, addon: dict[str, Any]) -> bool:
    """Return whether Supervisor add-on metadata looks like this add-on."""
    slug_value = _clean(addon.get("slug", slug))
    hostname = _clean(addon.get("hostname"))
    name = _clean(addon.get("name"))
    repository = _clean(addon.get("repository"))
    url = _clean(addon.get("url"))

    return (
        "whatsapp_addon" in slug_value
        or "whatsapp-addon" in slug_value
        or "whatsapp_addon" in hostname
        or "whatsapp-addon" in hostname
        or name in {"whatsapp", "whatsappv2", "whatsapp addon", "whatsappv2 addon"}
        or "moryoav/ha-addons" in repository
        or "moryoav/ha-addons" in url
    )


def _addon_info_urls(slug: str, addon: dict[str, Any]) -> list[str]:
    """Return possible internal URLs from Supervisor add-on metadata."""
    hosts = [
        addon.get("hostname"),
        addon.get("host"),
        addon.get("slug", slug),
        slug,
    ]

    normalized_hosts = []
    for host in hosts:
        if not host:
            continue
        host = str(host)
        normalized_hosts.append(host)
        normalized_hosts.append(host.replace("_", "-"))

    return [f"http://{host}:{ADDON_PORT}" for host in normalized_hosts]


def _dedupe_urls(urls: Iterable[str]) -> list[str]:
    """Return normalized URLs in insertion order."""
    deduped: list[str] = []
    for url in urls:
        try:
            normalized = _normalize_url(url)
        except InvalidUrl:
            continue
        if normalized not in deduped:
            deduped.append(normalized)
    return deduped


def _clean(value: Any) -> str:
    """Normalize metadata for matching."""
    return str(value or "").casefold()


async def _async_validate_url(hass: HomeAssistant, url: str) -> None:
    """Validate that the add-on URL is reachable."""
    client = WhatsappClient(async_get_clientsession(hass), url)
    await client.async_health()
