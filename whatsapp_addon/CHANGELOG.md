## 1.4.21

- Fixed inbound dedupe for media messages delivered twice during LID migration when WhatsApp keeps the same message id but changes wrapper-only media fields such as thumbnails, CDN paths, scan sidecars, or media key timestamp representation.
- Kept the collision guard for same-id messages whose stable media/content identity differs.

## 1.4.20

- Updated the runtime Baileys package pin to `@whiskeysockets/baileys@6.7.23`.
- Ensured the Docker image uses the freshly built Baileys package after copying add-on source files.
- Added receive-path diagnostics for `messages.upsert`, ignored inbound messages, and successful/failed `new_whatsapp_message` event firing without logging message bodies or full chat ids.
- Processed every Baileys message in each `messages.upsert` batch instead of only the first message.

## 1.4.19

- Updated repository metadata and documentation for the `moryoav/ha-addons` fork.
- Documented fork-only changes since the original add-on, including LID ids, inbound dedupe, send response data, read receipts, Baileys updates, and libsignal log filtering.
- Bumped the add-on version so Home Assistant can detect this documentation release.

## 1.4.18

- Suppressed known recoverable libsignal `Bad MAC` and session lifecycle console noise.
- Added compact periodic summary logging for filtered libsignal messages without stack traces, message bodies, or session objects.
- Added tests for the libsignal log filter.

## 1.4.17

- Added inbound message deduplication before firing `new_whatsapp_message` into Home Assistant.
- Deduplicates the same WhatsApp message id, direction, detected type, and normalized payload hash while ignoring `remoteJid`, which can differ between phone-number JIDs and LID JIDs.
- Logs dropped duplicate metadata and allows/logs same-key collisions when the payload differs.
- Added tests for duplicate, collision, missing id, different id, and TTL expiry behavior.

## 1.4.16

- Added support for direct `@lid` WhatsApp identifiers alongside `@s.whatsapp.net`, `@g.us`, and `@broadcast` ids.
- Kept direct JIDs from being rewritten as phone-number JIDs.

## 1.4.15

- Pinned the add-on build to `@whiskeysockets/baileys@6.7.18`.
- Cleaned up the Baileys build stage and runtime Docker image setup.

## 1.4.14

- Added service response data for `whatsapp.send_message` when called from Home Assistant with `response_variable`.
- Continued firing `whatsapp_send_message_result` for compatibility with existing automations.

## 1.4.1a - 1.4.13

- Moved active add-on metadata to the `moryoav/ha-addons` fork and the `WhatsappV2` add-on name.
- Added `whatsapp.read_messages` support to mark received messages as read.
- Added the add-on HTTP `readMessages` route and Baileys read receipt bridge.
- Updated package, Docker, and runtime setup across the fork maintenance releases.

## 1.4.1

- Bug QR-Code fixed

## 1.4.0

- Updated whatsapp library
- Changed session saving method
- Special functions such as sending buttons, sending lists, etc., are no longer available.

## 1.3.5

- Revert [(Pull request)](https://github.com/giuseppecastaldo/ha-addons/pull/33)

## 1.3.4

- Bug fixed [(Pull request)](https://github.com/giuseppecastaldo/ha-addons/pull/33)
- Bug fixed [(Pull request)](https://github.com/giuseppecastaldo/ha-addons/pull/55)

## 1.3.3

- Added donation button.

## 1.3.2

- Bug fixed.

## 1.3.0

- Bug fixed.

## 1.2.4

- Bug fixed.
- Added patch for receive button on iOS (Attention! iOS receive buttons only if app is open (it seems to be a iOS app bug))

## 1.2.2

- Added the ability to always be online or offline. This could lead to not receiving notifications on other devices. (**Restard required**)
- Bug fixed.

## 1.2.1

- Fixed bug that did not allow the reception of push notifications on other devices.
- Added event presence update.
- Added two more services like subscribe presence and send presence update.

## 1.2.0

- **Changed radically command and events. Please refer to doc and developer tools for change your automations.**
- **Performance boost! (Required re-authentication)**
- Bug fixed on send location.
- Bug fixed on send mulitple buttons.

## 1.1.2

- Bug fixed.
- Performance improvements.

## 1.1.1

- Migration from Home Assistant base image to Debian image

## 1.1.0

- Added the ability to manage multiple whatsapp sessions (re-authentication required)
- Buttons bug fixed (better visibility on android devices)
- Message options bug fixed
- Bug fixed.

**NOTE:** If you have problems with the custom components being updated, please follow this steps:

- Remove Whatsapp configuration in _configuration.yaml_
- Restart Home Assistant
- Add Whatsapp configuration in _configuration.yaml_
- Restart Home Assistant

## 1.0.2

- Addedd message revoke event.
- Added buttons message type (view documentation) (may not work properly on some devices)
- Added set status service (for sets the current user's status message)
- Bug fixed.

## 1.0.1

- Initial release
