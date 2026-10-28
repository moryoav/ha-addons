"""Inbox HTTP delivery must preserve existing event automations."""

from copy import deepcopy
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from homeassistant.core import CoreState
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry, MockUser

from custom_components.whatsapp.inbox import WhatsAppInboxView

pytestmark = pytest.mark.enable_socket
URL = "/api/whatsapp/inbox"
MESSAGE = {
    "clientId": "default",
    "key": {
        "id": "fictional-id",
        "remoteJid": "12025550123@s.whatsapp.net",
        "fromMe": False,
    },
    "message": {"conversation": "Fictional private note"},
    "type": "conversation",
    "messageTimestamp": 1234567890,
}
BODY = {"id": "a" * 64, "message": MESSAGE}


@pytest.fixture
async def inbox_setup(hass, enable_custom_integrations):
    """Register the real authenticated receiver through normal integration setup."""
    entry = MockConfigEntry(domain="whatsapp", data={"url": "http://addon:3000"})
    entry.add_to_hass(hass)
    with patch(
        "custom_components.whatsapp.WhatsappClient.async_health",
        AsyncMock(return_value={"status": "ok"}),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        hass.state = CoreState.running
        yield entry


async def test_receiver_requires_authentication(hass_client_no_auth, inbox_setup):
    """A private delivery ID does not grant access to the event bus."""
    client = await hass_client_no_auth()
    assert (await client.get(URL)).status == 401
    assert (await client.post(URL, json=BODY)).status == 401


async def test_non_admin_cannot_inject_whatsapp_messages(
    hass, hass_client, inbox_setup
):
    """Match the standard event endpoint's administrator permission boundary."""
    hass_user = MockUser().add_to_hass(hass)
    assert not hass_user.is_admin
    refresh = await hass.auth.async_create_refresh_token(
        hass_user, client_id="http://example.com"
    )
    token = hass.auth.async_create_access_token(refresh)
    # Register the event API before the test server starts and freezes its routes.
    assert await async_setup_component(hass, "api", {})
    client = await hass_client(access_token=token)
    events = []
    hass.bus.async_listen(
        "new_whatsapp_message", lambda event: events.append(event.data)
    )
    assert (await client.get(URL)).status == 401
    assert (await client.post(URL, json=BODY)).status == 401
    assert (
        await client.post("/api/events/new_whatsapp_message", json=MESSAGE)
    ).status == 401
    await hass.async_block_till_done()
    assert not events


async def test_system_administrator_can_deliver_inbox_messages(
    hass, hass_client, hass_admin_user, inbox_setup
):
    """Keep the Supervisor's system-user authentication path working."""
    user = MockUser(system_generated=True, groups=hass_admin_user.groups).add_to_hass(
        hass
    )
    assert user.is_admin
    refresh = await hass.auth.async_create_refresh_token(user)
    client = await hass_client(
        access_token=hass.auth.async_create_access_token(refresh)
    )
    assert (await client.get(URL)).status == 200
    assert (await client.post(URL, json=BODY)).status == 200


@pytest.mark.parametrize(
    "state", [CoreState.not_running, CoreState.starting, CoreState.stopping]
)
async def test_receiver_waits_for_startup(hass, hass_client, inbox_setup, state):
    """Keep messages queued until startup completes, including during shutdown."""
    client = await hass_client()
    events = []
    hass.bus.async_listen(
        "new_whatsapp_message", lambda event: events.append(event.data)
    )
    hass.state = state
    assert (await client.get(URL)).status == 503
    assert (await client.post(URL, json=BODY)).status == 503
    assert not events
    hass.state = CoreState.running
    assert (await client.get(URL)).status == 200
    assert (await client.post(URL, json=BODY)).status == 200
    await hass.async_block_till_done()
    assert events == [MESSAGE]


async def test_unloaded_integration_keeps_messages_in_the_app(
    hass, hass_client, inbox_setup
):
    """A registered HTTP route cannot accept messages for an unloaded integration."""
    assert await hass.config_entries.async_unload(inbox_setup.entry_id)
    client = await hass_client()
    assert (await client.get(URL)).status == 503
    assert (await client.post(URL, json=BODY)).status == 503


@pytest.mark.parametrize(
    "message",
    [
        MESSAGE,
        {
            **MESSAGE,
            "type": "audioMessage",
            "message": {"audioMessage": {"ptt": False}},
            "media": {
                "status": "ready",
                "local_path": "/media/whatsapp/fictional/file.ogg",
            },
        },
        {
            **MESSAGE,
            "type": "imageMessage",
            "message": {"imageMessage": {"caption": "Example"}},
        },
        {
            **MESSAGE,
            "clientId": "other",
            "key": {
                **MESSAGE["key"],
                "remoteJid": "12025550123-1@g.us",
                "participant": "999999999999999@lid",
            },
        },
    ],
)
async def test_existing_automation_receives_original_events(
    hass, hass_client, inbox_setup, message
):
    """An ordinary event automation works unchanged, even after an HTTP retry."""
    received = []
    hass.bus.async_listen(
        "fictional_processed_message", lambda event: received.append(event.data)
    )
    assert await async_setup_component(
        hass,
        "automation",
        {
            "automation": [
                {
                    "alias": "Existing WhatsApp automation",
                    "triggers": [
                        {"trigger": "event", "event_type": "new_whatsapp_message"}
                    ],
                    "conditions": [
                        {
                            "condition": "template",
                            "value_template": "{{ trigger.event.data.clientId in ['default', 'other'] }}",
                        }
                    ],
                    "actions": [
                        {
                            "event": "fictional_processed_message",
                            "event_data": {"incoming": "{{ trigger.event.data }}"},
                        }
                    ],
                }
            ]
        },
    )
    client = await hass_client()
    body = {"id": "b" * 64, "message": message}
    for _ in range(2):
        response = await client.post(URL, json=body)
        assert response.status == 200
        assert await response.json() == {"delivered": body["id"]}
    await hass.async_block_till_done()
    assert received == [{"incoming": message}]


@pytest.mark.parametrize(
    "body",
    [
        None,
        [],
        {},
        {"id": [], "message": MESSAGE},
        {"id": "bad", "message": MESSAGE},
        {"id": "a" * 64, "message": []},
        {"id": "a" * 64, "message": {**MESSAGE, "clientId": "../bad"}},
        {"id": "a" * 64, "message": {**MESSAGE, "message": []}},
        {"id": "a" * 64, "message": {**MESSAGE, "key": {"fromMe": True}}},
    ],
)
async def test_invalid_delivery_is_rejected(hass, hass_client, inbox_setup, body):
    """Reject malformed envelopes without emitting events or exposing their contents."""
    client = await hass_client()
    response = await client.post(URL, json=body)
    assert response.status == 400
    assert "Fictional private" not in await response.text()
    assert (
        await client.post(
            URL, data="not-json", headers={"Content-Type": "application/json"}
        )
    ).status == 400


async def test_receipt_cache_is_bounded_and_does_not_persist_payloads(
    hass, hass_admin_user
):
    """Prevent retry duplicates with bounded memory, retaining only opaque IDs."""
    view = WhatsAppInboxView(hass)
    request = MagicMock()
    request.__getitem__.return_value = hass_admin_user
    request.json = AsyncMock()
    with patch.object(view, "get", AsyncMock()):
        for index in range(1002):
            body = deepcopy(BODY)
            body["id"] = f"{index:064x}"
            request.json.return_value = body
            await view.post(request)
    assert len(view._delivered) == 1000
    assert f"{0:064x}" not in view._delivered
    assert all(value is None for value in view._delivered.values())
