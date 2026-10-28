# Voice calls

Call your Home Assistant on WhatsApp and have a natural conversation with it.
Ask about your home, control exposed devices, or run exposed scripts. Automations
can also call you, for example when a water leak needs your attention.

Calls use the same linked device and account as messaging. No second WhatsApp
login, separate voice app, or additional integration is needed. Baileys keeps
handling authentication and messages; a native worker handles call audio.

## Set up calling

1. Install or update both the WhatsApp app and HACS integration.
2. Set up Home Assistant's **OpenAI Conversation** integration with a working API
   key and conversation agent. Give that agent access to the entities and
   scripts you want to use through Assist.
3. Open the WhatsApp app configuration and expand **Voice calls**.
4. Set **Calling account** to one of the account IDs already listed under
   **WhatsApp accounts**, such as `default`. Only this account can make or answer
   AI calls. Other configured accounts keep their messaging behavior.
5. Enter the agent's entity ID under **OpenAI conversation agent**, for example
   `conversation.openai_conversation`. Find it on the OpenAI integration's
   device page or under **Developer tools > States**.
6. Add the people who may call under **Allowed incoming callers**. Use their
   WhatsApp user JIDs, such as `12025550123@s.whatsapp.net` or a `@lid` returned
   by `whatsapp.check_number`. An empty list answers nobody. Configured phone
   JIDs are resolved to LIDs through the selected account. A failed or missing
   lookup leaves the caller unanswered.
7. Save and restart the WhatsApp app. Open its web UI, select the calling
   account, and open **Calls** to check its readiness.

The app uses the API key belonging to the selected OpenAI conversation agent.
It resolves that key from Home Assistant's configuration through a read-only
mount. You do not enter another API key. The key needs access to GPT-Live;
API usage is billed separately from a ChatGPT subscription. Home requests go
through the standard `conversation.process` action using the selected agent.

Leave **Calling account** and **OpenAI conversation agent** empty to use
messaging without voice. Setting an agent does not expose extra devices or
scripts; the agent's existing Assist permissions determine what it can do.

Only one direct audio call can run at a time. Video and group calls are not
supported. The caller allowlist applies to incoming calls; an automation
explicitly chooses the recipient of an outgoing call.

## Use the account workspace

Select **Open Web UI** on the WhatsApp app page. The account list shows each
connection state. **Connection**, **Calls**, and **Recordings** share the same
navigation on desktop and phone.

An account that needs pairing shows its current QR code in **Connection**.
The code updates as WhatsApp provides a new one. To pair without scanning,
select **Link with code**, enter the account's phone number with its country
code, and request a one-time code. Enter it in WhatsApp under **Linked devices >
Link a device > Link with phone number instead**. Select **Scan QR code** to
return to QR pairing.

Under the configured calling account, open **Calls**, enter a phone number
with its country code or a WhatsApp user ID, and select **Call**. You can add
an optional opening message for that call. The Home Assistant agent handles
the conversation. The active-call bar names the calling account and keeps
**Hang up** available while you change views or accounts and scroll through
recordings. Other accounts continue to support messaging through Home
Assistant actions and automations.

Existing `/voice/` links open the Calls view in this shared workspace. Voice
and recording settings remain in the app's **Configuration** page.

## Make a call from Home Assistant

Use `whatsapp.make_call` with the selected calling account and a WhatsApp phone
number, phone JID, or LID. This starts a call; success does not mean the person
has answered. Optional response data contains `status: calling`.

```yaml
action: whatsapp.make_call
data:
  clientId: default
  to: "12025550123@s.whatsapp.net"
```

Set `message` to say why you are calling once the person answers. It overrides
the normal greeting for this call only and accepts up to 300 characters.

```yaml
alias: Call about a water leak
triggers:
  - trigger: state
    entity_id: binary_sensor.kitchen_water_leak
    to: "on"
actions:
  - action: whatsapp.make_call
    data:
      clientId: default
      to: "12025550123@s.whatsapp.net"
      message: >-
        A water leak was detected in the kitchen. How would you like to proceed?
mode: single
```

After that opening message you can ask follow-up questions and use the same
Home Assistant agent. Keep another notification path for urgent alerts: a call
may fail, go unanswered, or be limited by network or API availability.

To end the selected account's active call:

```yaml
action: whatsapp.hang_up
data:
  clientId: default
```

Optional response data contains `status: ended`. Ending an already idle account
is harmless. An account ID other than **Calling account** is rejected.

## Voice and conversation settings

| Setting | Behavior |
| --- | --- |
| Assistant voice | Choose from 22 GPT-Live voices. The default is Gleam. Changes apply to new calls. |
| Maximum call length | Defaults to 300 seconds, including setup, with a range of 60-900 seconds. |
| Opening greeting | Random short greetings by default. Choose Fixed for your own text or Disabled to wait for the caller. |
| Fixed greeting text | Up to 300 characters, used when Fixed is selected. |
| End calls after goodbye | Enabled by default. A contextual detector disconnects immediately after recognizing a clear final goodbye or request to hang up. |

Greetings wait until the WhatsApp audio connection is established, including
when you start an outgoing call. Random greetings avoid consecutive repeats
while the app runs. Goodbye detection uses a separate small OpenAI model and
adds API usage. A confirmed hang-up does not wait for a spoken farewell.

## Audio settings

**Advanced voice settings** contains two options:

- **Call audio codec:** Opus is the tested default. MLOW is Meta's speech codec
  for low-bandwidth connections. Try either if your device or connection sounds
  better with it.
- **Initial playback buffer:** 180 ms by default, adjustable from 120 to 1500 ms.
  Playback adapts to timing and delivery gaps during the call. A larger initial
  buffer adds delay and does not repair every kind of packet loss.

## Record calls

**Record calls** is disabled by default. Enable it to save both sides of answered
calls as one mono, 16 kHz, 16-bit WAV file. Recording uses a bounded queue and a
background writer. Slow or failed storage stops recording without waiting in
the live audio path. Calls that are never answered are not recorded.

Open the app web UI, select the calling account, and use **Recordings** to
search by date, play, seek, or download completed files and see their expiry.
The library includes older files if the selected calling account has changed.
Existing recording metadata does not identify the account or contact, so the
UI does not attribute those files to the current account. They are also in
Home Assistant's Media folder under
`whatsapp/call-recordings`. A minute is about 1.9 MB. Filenames contain a
timestamp and random ID, without caller names or phone numbers.

Retention defaults to **30 days** and accepts 1-365 days. Cleanup runs at startup
and hourly, including when recording is off. Changing retention affects existing
recordings too. Download any file you want to keep longer. Shared media access
and Home Assistant backups also apply to these files.

The file contains the audio received and sent by the app. It cannot capture
packet loss or speaker problems that occur later on the phone. Audio is not
included in logs, diagnostics, or numeric call reports.

## Upgrade from 2.x

Update both the app and the HACS integration. The app keeps its installation
identity, account IDs, and saved WhatsApp sessions. Existing linked accounts do
not need to pair again. Calling starts only after you select an account and
agent; messaging continues without that setup.

The internal API credential is now created and managed automatically. Existing
credentials are retained and supplied to the integration through Supervisor
discovery. The old API token configuration field is no longer needed.
Supplemental own-device LID delivery receipts are always enabled. Detailed
decryption tracing is off. Their old configuration switches have been removed.

## Troubleshooting

- **Calling is unconfigured:** select an existing account and an OpenAI
  conversation entity, save, and restart the app.
- **Incoming calls are ignored:** check the caller's exact JID and that the
  selected account is connected. An empty allowlist deliberately answers nobody.
- **The call ends during setup:** check that the selected agent and its API key
  work, the key has GPT-Live access, and the conversation entity is available.
- **The assistant cannot control something:** check what the selected agent can
  access through Assist, including the script or entity in question.
- **Audio cuts out:** compare codecs and the initial playback buffer. Collect
  privacy-safe app diagnostics if the issue continues.
- **The new actions are missing:** update the HACS integration as well as the
  app and restart Home Assistant after the integration update.
