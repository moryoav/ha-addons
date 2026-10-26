# WhatsApp for Home Assistant

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Home Assistant operators managing their own WhatsApp accounts. Desktop and phone use are equally important.

## Product Purpose

Connect WhatsApp accounts to Home Assistant, manage connection and pairing status, make and end agent-handled voice calls, and browse completed recordings in one workspace.

## Operating Context

The add-on Web UI opens through Home Assistant ingress. The custom integration supplies messaging actions and incoming-message events. Account, conversation-agent, and recording settings are configured in the add-on Configuration.

## Capabilities and Constraints

- Multiple accounts can connect for messaging. Their connection and QR-pairing states are shown independently.
- Voice calling uses one configured account and supports one direct audio call at a time. A Home Assistant conversation agent handles the conversation.
- The browser does not supply the call microphone. The UI does not provide a conversation inbox, contact directory, transcripts, or live audio monitoring.
- Connection shows the current runtime QR code while pairing. Link with code remains disabled and marked Coming later; no future pairing flow is active.
- Recording is optional. Completed WAV files support native browser playback, seeking, download, and configurable retention.
- The recording library is shared by the add-on. Its metadata has date, duration, size, and expiry, without account or contact identity. Older files can belong to a previously configured calling account.
- An active call belongs to the configured calling account. Its Hang up control remains available across account and view changes.
- Retry and session reset are available during the global recovery pause. Reset requires the exact selected account ID, removes that account's saved pairing, and restarts the connections.

## Product Principles

- Show account health and the selected account clearly.
- Keep an ongoing call actionable while navigating.
- Make pairing, unavailable capabilities, and recovery understandable in context.
- Preserve recording playback across routine status refreshes.
- Treat phone and desktop as primary layouts.

## Evidence on Hand

The implemented interface is in `whatsapp_addon/webui/workspace.html`, `workspace.css`, and `workspace.js`. The ingress and voice routes supply real account, call, and recording state. Design previews and test fixtures use synthetic data and do not establish a live WhatsApp or Home Assistant session.
