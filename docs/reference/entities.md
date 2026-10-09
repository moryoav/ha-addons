# Devices and sensors

The integration creates one shared **WhatsApp app** device and a
separate **WhatsApp (account ID)** device for every account configured in the
app's `clients` option. Account IDs come from that option, not phone numbers.

## Entities

| Device | Entity | Type | Meaning |
| --- | --- | --- | --- |
| WhatsApp app | App connection | Binary sensor | Connected when the local app health probe succeeds; disconnected when the app cannot be reached or identified. |
| Each account | WhatsApp connection | Binary sensor | Connected when that account's WhatsApp session is connected; disconnected in every other known session state. |
| Each account | Session state | Sensor | The account's current session state, listed below. |

All three entity types are diagnostic entities and enabled by default. Their
names include their device name, so each account's entities are distinct.

## Session states

| State | Displayed name | Meaning |
| --- | --- | --- |
| `connecting` | Connecting | The app is starting the account connection. |
| `connected` | Connected | The account is connected to WhatsApp. |
| `disconnected` | Disconnected | The account connection has stopped. |
| `logged_out` | Logged out | WhatsApp has logged the account out. |
| `pairing` | Pairing required | Scan the QR code in the app to pair this account. |
| `reconnecting` | Reconnecting | The app is attempting to reconnect this account. |
| `restarting` | Restarting | The app is restarting this account's connection. |
| `recovery_paused` | Paused for recovery | The app paused connections after repeated encryption errors. Use the app web UI to review recovery. |

The sensor's raw state is the value in the first column. Use that value in
automation conditions; Home Assistant displays the translated name.

## Updates and availability

One coordinator refreshes all devices every 30 seconds. It reads the local
health probe and the account status API. These requests
read the app's existing state and make no extra WhatsApp network requests.
Message, receipt, call, and presence events continue to arrive through push.

App connection describes the local app, so it can stay connected while one or
all WhatsApp accounts are disconnected. It does not confirm message delivery.
When the app is unreachable, App connection shows disconnected and account
entities become unavailable. A failed account status request, such as an
authentication error, leaves App connection connected but makes account
entities unavailable until status can be read again.

## Account devices

Accounts still waiting for pairing have their own devices. Newly configured
accounts are discovered on the next successful refresh after the app restarts.
An account's device and entity identities remain stable across Home Assistant
and app restarts, reconnects, and re-pairing while its configured account ID
stays the same. Renaming that ID creates a new device; renaming the device in
Home Assistant does not change its identity.

Removing an account from the app configuration makes its entities unavailable.
After the integration receives a successful status snapshot without that
account, its device can be deleted from the integration's device page. Active
account devices and the shared app device cannot be deleted this way. Devices
are not automatically deleted during outages.

## Notify through another channel when an account disconnects

I use a Home Assistant mobile notification for this alert, so it can arrive
while WhatsApp is disconnected. Select your account's WhatsApp connection
entity and your own notification action before using the example.

```yaml
- alias: WhatsApp account connection alert
  triggers:
    - trigger: state
      entity_id: binary_sensor.whatsapp_personal_whatsapp_connection
      to: "off"
      for: "00:02:00"
    - trigger: state
      entity_id: binary_sensor.whatsapp_personal_whatsapp_connection
      to: "unavailable"
      for: "00:02:00"
  actions:
    - action: notify.mobile_app_your_phone
      data:
        message: "The personal WhatsApp account is disconnected or unavailable."
```

Entity IDs above are examples. Home Assistant generates them from the device
and entity names, and you can change them in the entity settings.
