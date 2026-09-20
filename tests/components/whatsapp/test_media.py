"""Tests for authenticated, expiring WhatsApp attachment downloads."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

from aiohttp import web
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.whatsapp import async_setup
from custom_components.whatsapp.const import CONF_URL, DOMAIN
from custom_components.whatsapp.media import _read_attachment

pytestmark = pytest.mark.enable_socket

MEDIA_ID = "12345678-1234-4123-8123-123456789abc"
URL = f"/api/whatsapp/media/{MEDIA_ID}"
DATA = b"Fictional PDF attachment"


def _save(root: Path, **overrides) -> Path:
    """Create the on-disk contract produced by the add-on."""
    directory = root / MEDIA_ID
    directory.mkdir(exist_ok=True)
    metadata = {
        "filename": "file.pdf",
        "mime_type": "application/pdf",
        "size": len(DATA),
        "expires_at": (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(),
        **overrides,
    }
    (directory / "metadata.json").write_text(json.dumps(metadata))
    (directory / "file.pdf").write_bytes(DATA)
    return directory


@pytest.fixture
async def media_setup(hass, enable_custom_integrations, tmp_path):
    """Load the integration with a reachable add-on and a shared media directory."""
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_URL: "http://addon:3000"})
    entry.add_to_hass(hass)
    with (
        patch("custom_components.whatsapp.media.MEDIA_ROOT", tmp_path),
        patch(
            "custom_components.whatsapp.WhatsappClient.async_health",
            AsyncMock(return_value={"status": "ok"}),
        ),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        yield entry


async def test_authenticated_document_download(
    hass, hass_client, media_setup, tmp_path
):
    """Documents are available without putting private files under www."""
    _save(tmp_path)
    client = await hass_client()
    response = await client.get(URL)
    assert response.status == 200
    assert await response.read() == DATA
    assert response.headers["Content-Type"] == "application/pdf"
    assert response.headers["Content-Disposition"] == 'attachment; filename="file.pdf"'
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-Content-Type-Options"] == "nosniff"


async def test_unauthenticated_download_is_rejected(
    hass, hass_client_no_auth, media_setup, tmp_path
):
    """Knowing a file ID alone does not authorize a download."""
    _save(tmp_path)
    client = await hass_client_no_auth()
    response = await client.get(URL)
    assert response.status == 401
    assert DATA not in await response.read()


async def test_expiry_is_enforced_before_background_cleanup(
    hass_client, media_setup, tmp_path
):
    """An expired file still on disk is no longer downloadable."""
    _save(tmp_path, expires_at="2020-01-01T00:00:00Z")
    client = await hass_client()
    response = await client.get(URL)
    assert response.status == 410


async def test_unloaded_integration_does_not_serve_media(
    hass, hass_client, media_setup, tmp_path
):
    """The HTTP view remains registered but respects entry unload."""
    _save(tmp_path)
    assert await hass.config_entries.async_unload(media_setup.entry_id)
    client = await hass_client()
    assert (await client.get(URL)).status == 404


@pytest.mark.parametrize(
    "media_id", ["../secret", "metadata.json", ".partial-" + MEDIA_ID, "not-a-uuid"]
)
def test_invalid_identifiers(tmp_path, media_id):
    """Only generated attachment IDs can address storage."""
    with pytest.raises(web.HTTPNotFound):
        _read_attachment(tmp_path, media_id)


@pytest.mark.parametrize(
    "overrides",
    [
        {"filename": "../../secret.txt"},
        {"filename": "/etc/passwd"},
        {"filename": "metadata.json"},
        {"filename": None},
        {"mime_type": "text/plain\r\nX-Injected: true"},
        {"mime_type": None},
        {"expires_at": "not a date"},
        {"expires_at": "2099-01-01T00:00:00"},
    ],
)
def test_invalid_metadata(tmp_path, overrides):
    """Invalid paths, HTTP headers, and timezone-less expiry cannot be used."""
    _save(tmp_path, **overrides)
    with pytest.raises(web.HTTPNotFound):
        _read_attachment(tmp_path, MEDIA_ID)


@pytest.mark.parametrize(
    "metadata", ["not-json", "{}", "null", "[]", '"string"', " " * 4097 + "{}"]
)
def test_corrupt_or_oversized_metadata(tmp_path, metadata):
    """Malformed metadata cannot escape the file-serving contract."""
    directory = _save(tmp_path)
    (directory / "metadata.json").write_text(metadata)
    with pytest.raises(web.HTTPNotFound):
        _read_attachment(tmp_path, MEDIA_ID)


def test_missing_or_incomplete_file(tmp_path):
    """An attachment must exist and be fully published."""
    with pytest.raises(web.HTTPNotFound):
        _read_attachment(tmp_path, MEDIA_ID)
    directory = _save(tmp_path)
    (directory / "file.pdf").unlink()
    with pytest.raises(web.HTTPNotFound):
        _read_attachment(tmp_path, MEDIA_ID)


@pytest.mark.parametrize("target", ["root", "directory", "metadata", "file"])
def test_symlinks_are_rejected(tmp_path, target):
    """A symlink cannot expose another directory or file."""
    root = tmp_path / "media"
    root.mkdir()
    directory = _save(root)
    source = {
        "root": root,
        "directory": directory,
        "metadata": directory / "metadata.json",
        "file": directory / "file.pdf",
    }[target]
    destination = tmp_path / "outside"
    source.rename(destination)
    source.symlink_to(destination, target_is_directory=destination.is_dir())
    with pytest.raises(web.HTTPNotFound):
        _read_attachment(root, MEDIA_ID)


async def test_http_setup_failure_does_not_register_partial_integration(hass):
    """HTTP is required for attachment access."""
    with patch("custom_components.whatsapp.async_setup_component", return_value=False):
        assert not await async_setup(hass, {})
