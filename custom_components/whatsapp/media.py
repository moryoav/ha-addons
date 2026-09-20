"""Authenticated access to temporary attachments saved by the WhatsApp add-on."""

from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import re

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant

from .const import DOMAIN

MEDIA_ROOT = Path("/media/whatsapp")
MEDIA_ID = re.compile(
    r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"
)
FILENAME = re.compile(r"file\.[a-z0-9]{1,16}")
MIME_TYPE = re.compile(r"[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+")


def _read_attachment(root: Path, media_id: str) -> tuple[Path, str]:
    """Read bounded metadata and reject expired files, traversal, and symlinks."""
    if not MEDIA_ID.fullmatch(media_id):
        raise web.HTTPNotFound
    directory = root / media_id
    metadata_path = directory / "metadata.json"
    try:
        if root.is_symlink() or directory.is_symlink() or metadata_path.is_symlink():
            raise web.HTTPNotFound
        with metadata_path.open("rb") as metadata_file:
            metadata = json.loads(metadata_file.read(4097))
        filename = metadata["filename"]
        mime_type = metadata["mime_type"]
        expires = datetime.fromisoformat(metadata["expires_at"])
        if not FILENAME.fullmatch(filename) or not MIME_TYPE.fullmatch(mime_type):
            raise web.HTTPNotFound
        if expires <= datetime.now(timezone.utc):
            raise web.HTTPGone
        file_path = directory / filename
        if file_path.is_symlink() or not file_path.is_file():
            raise web.HTTPNotFound
        if not file_path.resolve().is_relative_to(root.resolve()):
            raise web.HTTPNotFound
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise web.HTTPNotFound from None
    return file_path, mime_type


class WhatsAppMediaView(HomeAssistantView):
    """Serve all attachment types using Home Assistant authentication."""

    url = "/api/whatsapp/media/{media_id}"
    name = "api:whatsapp:media"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        """Keep Home Assistant for executor access and entry lifecycle checks."""
        self.hass = hass

    async def get(self, request: web.Request, media_id: str) -> web.FileResponse:
        """Return a completed attachment, never a partial download or metadata."""
        if not any(
            entry.state is ConfigEntryState.LOADED
            for entry in self.hass.config_entries.async_entries(DOMAIN)
        ):
            raise web.HTTPNotFound
        file_path, mime_type = await self.hass.async_add_executor_job(
            _read_attachment, MEDIA_ROOT, media_id
        )
        return web.FileResponse(
            file_path,
            headers={
                "Content-Type": mime_type,
                "Content-Disposition": f'attachment; filename="{file_path.name}"',
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "no-store",
            },
        )
