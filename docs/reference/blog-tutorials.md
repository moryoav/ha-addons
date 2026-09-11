# Blog tutorials and current examples

I keep the longer walkthroughs on [Dr. Smart Home](https://smarthome.yoavmor.com/)
and the current action examples in this knowledge base. This table maps the
WhatsApp tutorials and related workflows to their examples here.

| Blog tutorial | Current examples |
| --- | --- |
| [Part 1: Setup and notifications](https://smarthome.yoavmor.com/home-assistant/integrating-whatsapp-into-home-assistant-part-1-setup-and-notifications/) | [Current installation](https://github.com/moryoav/ha-addons#installation), [text messages](../examples/messages.md#send-a-text-message), and [agent replies](../examples/incoming-messages.md#reply-with-a-conversation-agent). |
| [Part 2: Messaging groups](https://smarthome.yoavmor.com/home-assistant/integrating-whatsapp-into-home-assistant-part-2-messaging-groups/) | [Discover a group JID and send to it](../examples/recipients.md#find-a-group-id-and-send-a-notification). |
| [Part 3: Images and audio](https://smarthome.yoavmor.com/home-assistant/integrating-whatsapp-into-home-assistant-part-3-sending-images-and-audio/) | [Images](../examples/messages.md#send-an-image), [voice messages](../examples/messages.md#send-a-voice-message), and [sensor charts](../examples/sensor-charts.md). |
| [Part 4: Stickers](https://smarthome.yoavmor.com/home-assistant/integrating-whatsapp-into-home-assistant-part-4-sending-stickers/) | [WebP stickers](../examples/messages.md#send-a-sticker) and [quoted sticker replies](../examples/messages.md#reply-to-a-notification-with-a-sticker). |
| [Advanced automations](https://smarthome.yoavmor.com/home-assistant/enhancing-the-whatsapp-addon-for-home-assistant-new-features-for-advanced-automations/) | [Send-result event collector](events.md#capture-a-send-result-event), [saved message keys](../examples/scripts.md#save-a-message-key-for-another-run), [editing](../examples/messages.md#edit-a-sent-text-message), [deleting](../examples/messages.md#delete-a-sent-message), and [read markers](../examples/automations.md#mark-incoming-messages-as-read). |
| [Presence updates](https://smarthome.yoavmor.com/home-assistant/enhancing-your-whatsapp-bot-in-home-assistant-with-presence-updates/) | [Typing and presence](../examples/presence.md). |
| [AI notifications](https://smarthome.yoavmor.com/home-assistant/adding-ai-to-your-home-assistant-notifications/) | [Rewrite a notification and fall back to its original text](../examples/ai-notifications.md). |
| [Conversation history](https://smarthome.yoavmor.com/home-assistant/adding-conversation-history-to-ai-assistants-in-home-assistant/) | [File setup, history-aware replies, and retention](../examples/conversation-history.md). |
| [Sensor graph images](https://smarthome.yoavmor.com/home-assistant/creating-images-of-graph-data-from-home-assistant-sensors/) | [Record readings, send the chart, and trim old rows](../examples/sensor-charts.md). |

## Using an older tutorial

I updated these details when adapting the 2024 and 2025 posts:

- Use this repository's installation guide. The original setup post used a
  different add-on and integration setup.
- Copy a complete group JID from an event; do not assume a fixed digit count.
  For direct chats, prefer an available LID as described in [recipients](../examples/recipients.md).
- Media URLs need to be downloadable by the add-on. A file under Home
  Assistant's `/config` is not automatically mounted inside that container.
- The older sticker post says polls are unavailable. [Poll creation and a
  returned vote event](../examples/messages.md#create-a-poll) have since been
  verified with a live test of this integration.
- Use a send action's response variable when a later step must refer to that
  exact message. An event collector that stores the last ID can be overwritten
  by another send.
- Conversation history depends on the selected agent and conversation ID.
  Do not reuse one global conversation ID or history file for unrelated chats.

The [dead-man switch article](https://smarthome.yoavmor.com/home-assistant/home-assistant-dead-man-switch/)
describes an external monitoring workflow. A monitor can use the documented
[webhook forwarding pattern](../examples/automations.md#forward-a-local-webhook-to-whatsapp)
while Home Assistant is reachable. To report a Home Assistant outage, the
monitor needs a notification route that works independently of Home Assistant.
