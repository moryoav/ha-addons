---
version: 1
slug: "whatsapp-addon-webui-workspace-html"
primary_target: "whatsapp_addon/webui/workspace.html"
related_targets: ["whatsapp_addon/webui/workspace.css","whatsapp_addon/webui/workspace.js","whatsapp_addon/webui.js","whatsapp_addon/voice/routes.js"]
---

# WhatsApp account workspace

## Scope

- Primary target: `whatsapp_addon/webui/workspace.html`.
- Related targets: `whatsapp_addon/webui/workspace.css`, `whatsapp_addon/webui/workspace.js`, `whatsapp_addon/webui.js`, `whatsapp_addon/voice/routes.js`.
- Visitor mode: Operate.
- Audience and job: Home Assistant operators checking account health, pairing, calling through an agent, and retrieving saved audio on desktop or phone.
- Primary actions: link the selected account, start a call on the configured account, end the active call, or play/download a completed WAV.

## Direction contract

THESIS: One account source list and a shared Connection, Calls, and Recordings workspace keep identity and task context clear without a dashboard of unrelated metrics.

OWN-WORLD: Cool neutral light and dark surfaces, forest-green actions, platform UI sans, slim dividers, curved controls, round initials, and timed media rows form one restrained communications interface.

STORY: Scan connection health, select an account, inspect its connection or call capability, and browse saved audio. The owning account and Hang up stay visible while views or accounts change.

FIRST VIEWPORT: A compact top bar sits above the account rail and selected-account workspace. The account heading and status precede the sticky active-call strip and three task tabs. Connection shows current status or QR pairing; Calls places its form beside readiness facts and recent recordings. Phone layouts move the account selector above the content and stack the forms.

FORM: Audio-library workspace, grounded list position 3, seed f40a1a2a. The signature interaction keeps the active call actionable across navigation.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Behavior and truth boundaries

- The UI renders runtime account states and QR data. Link with code is disabled with Coming later; no future-flow preview ships.
- Only the configured calling account can start the one supported call. The agent handles the conversation.
- The shared recording store has no account or contact attribution. Show date, duration, size, and expiry without inventing identity.
- Retain native audio elements across polling and filtering so playback and seeking are not reset.
- Recovery retry and reset remain guarded by the global paused state. Reset requires the exact account ID.
- Settings direct the operator to add-on Configuration. Messaging continues through existing Home Assistant actions and events.

## Verification boundary

Review uses the production templates and routes with synthetic identities, QR data, and WAV media. It covers phone and desktop layouts, light and dark appearances, call persistence, playback, and recovery. Those fixtures do not demonstrate a live WhatsApp call or a physical Home Assistant device session.
