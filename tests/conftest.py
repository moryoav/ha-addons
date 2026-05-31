"""Test configuration for the WhatsApp integration."""

from __future__ import annotations

import asyncio

import pytest

pytest_plugins = "pytest_homeassistant_custom_component"


def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line("markers", "enable_socket: allow socket access")


@pytest.fixture
def event_loop(socket_enabled):
    """Create the Home Assistant test loop after pytest-socket is enabled."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()
