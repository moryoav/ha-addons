"""Tests for the WhatsApp config flow."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from homeassistant import config_entries
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.whatsapp.client import WhatsappCannotConnect
from custom_components.whatsapp.config_flow import (
    _addon_info_urls,
    _async_detect_addon_url,
    _async_validate_url,
    _candidate_urls,
    _is_whatsapp_addon,
    _normalize_url,
    _url_from_discovery_config,
)
from custom_components.whatsapp.const import CONF_URL, DOMAIN

pytestmark = pytest.mark.enable_socket


async def test_user_flow_success(hass, enable_custom_integrations) -> None:
    """Test a successful user flow with automatic add-on detection."""
    with patch(
        "custom_components.whatsapp.config_flow._async_detect_addon_url",
        AsyncMock(return_value="http://detected-addon:3000"),
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN,
            context={"source": config_entries.SOURCE_USER},
        )

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "WhatsApp Add-on"
    assert result["data"] == {CONF_URL: "http://detected-addon:3000"}


async def test_user_flow_cannot_connect(hass, enable_custom_integrations) -> None:
    """Test that connection failures keep the no-input form open."""
    with patch(
        "custom_components.whatsapp.config_flow._async_detect_addon_url",
        AsyncMock(side_effect=WhatsappCannotConnect),
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN,
            context={"source": config_entries.SOURCE_USER},
        )

        assert result["type"] is FlowResultType.FORM
        assert result["errors"] == {}

        result = await hass.config_entries.flow.async_configure(result["flow_id"], {})

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}


async def test_user_flow_single_instance(hass, enable_custom_integrations) -> None:
    """Test that only one config entry is allowed."""
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_URL: "http://one:3000"})
    entry.add_to_hass(hass)

    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": config_entries.SOURCE_USER},
    )

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"


async def test_import_flow_success(hass, enable_custom_integrations) -> None:
    """Test YAML import discovers the add-on automatically."""
    with patch(
        "custom_components.whatsapp.config_flow._async_detect_addon_url",
        AsyncMock(return_value="http://detected-addon:3000"),
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN,
            context={"source": config_entries.SOURCE_IMPORT},
            data={},
        )

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {CONF_URL: "http://detected-addon:3000"}


async def test_import_flow_cannot_connect(hass, enable_custom_integrations) -> None:
    """Test YAML import aborts if the add-on cannot be detected."""
    with patch(
        "custom_components.whatsapp.config_flow._async_detect_addon_url",
        AsyncMock(side_effect=WhatsappCannotConnect),
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN,
            context={"source": config_entries.SOURCE_IMPORT},
            data={},
        )

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "cannot_connect"


async def test_hassio_flow_success(hass, enable_custom_integrations) -> None:
    """Test Supervisor discovery creates an entry without a URL prompt."""
    discovery_info = type(
        "DiscoveryInfo",
        (),
        {
            "config": {CONF_HOST: "supervisor-addon", CONF_PORT: 3000},
            "name": "WhatsappV2",
        },
    )()

    with patch(
        "custom_components.whatsapp.config_flow._async_detect_addon_url",
        AsyncMock(return_value="http://supervisor-addon:3000"),
    ) as detect:
        result = await hass.config_entries.flow.async_init(
            DOMAIN,
            context={"source": config_entries.SOURCE_HASSIO},
            data=discovery_info,
        )

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "WhatsappV2"
    assert result["data"] == {CONF_URL: "http://supervisor-addon:3000"}
    detect.assert_awaited_once_with(hass, ["http://supervisor-addon:3000"])


async def test_hassio_flow_updates_existing_entry(
    hass,
    enable_custom_integrations,
) -> None:
    """Test Supervisor discovery refreshes an existing entry URL."""
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_URL: "http://old:3000"})
    entry.add_to_hass(hass)
    discovery_info = type(
        "DiscoveryInfo",
        (),
        {"config": {CONF_URL: "http://new:3000"}, "name": "WhatsappV2"},
    )()

    with patch(
        "custom_components.whatsapp.config_flow._async_detect_addon_url",
        AsyncMock(return_value="http://new:3000"),
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN,
            context={"source": config_entries.SOURCE_HASSIO},
            data=discovery_info,
        )

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    assert entry.data == {CONF_URL: "http://new:3000"}


async def test_hassio_flow_cannot_connect(hass, enable_custom_integrations) -> None:
    """Test Supervisor discovery aborts if validation fails."""
    discovery_info = type(
        "DiscoveryInfo",
        (),
        {"config": {CONF_URL: "http://new:3000"}, "name": "WhatsappV2"},
    )()

    with patch(
        "custom_components.whatsapp.config_flow._async_detect_addon_url",
        AsyncMock(side_effect=WhatsappCannotConnect),
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN,
            context={"source": config_entries.SOURCE_HASSIO},
            data=discovery_info,
        )

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "cannot_connect"


async def test_reconfigure_flow(hass, enable_custom_integrations) -> None:
    """Test reconfigure rediscoveres the add-on."""
    flow = await hass.config_entries.flow.async_create_flow(
        DOMAIN,
        context={"source": "reconfigure"},
        data=None,
    )
    flow._get_reconfigure_entry = lambda: MockConfigEntry(
        domain=DOMAIN,
        data={CONF_URL: "http://old-addon:3000"},
    )
    flow.async_update_reload_and_abort = lambda entry, data_updates: {
        "type": FlowResultType.ABORT,
        "data_updates": data_updates,
    }

    with patch(
        "custom_components.whatsapp.config_flow._async_detect_addon_url",
        AsyncMock(return_value="http://new-addon:3000"),
    ):
        result = await flow.async_step_reconfigure({})

    assert result["type"] is FlowResultType.ABORT
    assert result["data_updates"] == {CONF_URL: "http://new-addon:3000"}


async def test_reconfigure_flow_cannot_connect(hass, enable_custom_integrations) -> None:
    """Test failed reconfigure keeps the form open."""
    flow = await hass.config_entries.flow.async_create_flow(
        DOMAIN,
        context={"source": "reconfigure"},
        data=None,
    )

    with patch(
        "custom_components.whatsapp.config_flow._async_detect_addon_url",
        AsyncMock(side_effect=WhatsappCannotConnect),
    ):
        result = await flow.async_step_reconfigure(None)
        assert result["type"] is FlowResultType.FORM
        assert result["errors"] == {}

        result = await flow.async_step_reconfigure({})

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}


async def test_detect_addon_url_uses_first_working_candidate(
    hass,
    enable_custom_integrations,
) -> None:
    """Test add-on URL detection checks candidates in order."""
    attempts = []

    async def validate(hass, url):
        attempts.append(url)
        if url == "http://bad:3000":
            raise WhatsappCannotConnect

    with patch(
        "custom_components.whatsapp.config_flow._candidate_urls",
        return_value=["http://bad:3000", "http://good:3000"],
    ), patch(
        "custom_components.whatsapp.config_flow._async_validate_url",
        side_effect=validate,
    ):
        assert await _async_detect_addon_url(hass) == "http://good:3000"

    assert attempts == ["http://bad:3000", "http://good:3000"]


async def test_detect_addon_url_raises_after_all_fail(
    hass,
    enable_custom_integrations,
) -> None:
    """Test add-on URL detection failure."""
    with patch(
        "custom_components.whatsapp.config_flow._candidate_urls",
        return_value=["http://bad:3000"],
    ), patch(
        "custom_components.whatsapp.config_flow._async_validate_url",
        AsyncMock(side_effect=WhatsappCannotConnect),
    ):
        with pytest.raises(WhatsappCannotConnect):
            await _async_detect_addon_url(hass)


async def test_validate_url_uses_client(hass, enable_custom_integrations) -> None:
    """Test URL validation checks add-on health."""
    with patch(
        "custom_components.whatsapp.config_flow.WhatsappClient.async_health",
        AsyncMock(return_value={"status": "ok"}),
    ) as health:
        await _async_validate_url(hass, "http://addon:3000")

    health.assert_awaited_once()


def test_candidate_urls_from_hassio_metadata(hass) -> None:
    """Test candidate URL generation from Supervisor metadata."""
    hass.data["hassio_addons_info"] = {
        "ea396823_whatsapp_addon": {
            "name": "WhatsappV2",
            "hostname": "ea396823-whatsapp-addon",
            "slug": "ea396823_whatsapp_addon",
        }
    }

    urls = _candidate_urls(hass, ["http://preferred:3000"])

    assert urls[:3] == [
        "http://preferred:3000",
        "http://ea396823-whatsapp-addon:3000",
        "http://ea396823_whatsapp_addon:3000",
    ]


def test_candidate_urls_fallback(hass) -> None:
    """Test fallback URL candidates."""
    urls = _candidate_urls(hass, [])

    assert "http://ea396823-whatsapp-addon:3000" in urls
    assert "http://whatsapp-addon:3000" in urls


@pytest.mark.parametrize(
    ("slug", "addon"),
    [
        ("ea396823_whatsapp_addon", {}),
        ("slug", {"hostname": "ea396823-whatsapp-addon"}),
        ("slug", {"name": "WhatsappV2"}),
        ("slug", {"repository": "https://github.com/moryoav/ha-addons"}),
    ],
)
def test_is_whatsapp_addon(slug, addon) -> None:
    """Test matching WhatsApp add-on metadata."""
    assert _is_whatsapp_addon(slug, addon)


def test_is_not_whatsapp_addon() -> None:
    """Test unrelated add-on metadata."""
    assert not _is_whatsapp_addon("other", {"name": "Other"})


def test_addon_info_urls() -> None:
    """Test add-on metadata URL expansion."""
    urls = _addon_info_urls(
        "ea396823_whatsapp_addon",
        {"hostname": "ea396823-whatsapp-addon", "slug": "ea396823_whatsapp_addon"},
    )

    assert "http://ea396823-whatsapp-addon:3000" in urls
    assert "http://ea396823_whatsapp_addon:3000" in urls


def test_url_from_discovery_config() -> None:
    """Test discovery config URL construction."""
    assert _url_from_discovery_config({CONF_URL: " http://addon:3000/ "}) == (
        "http://addon:3000"
    )
    assert _url_from_discovery_config({CONF_HOST: "addon", CONF_PORT: 3000}) == (
        "http://addon:3000"
    )
    assert _url_from_discovery_config({}) is None


def test_normalize_url() -> None:
    """Test URL normalization."""
    assert _normalize_url(" http://addon:3000/ ") == "http://addon:3000"
