# Decrypt incoming media

Version 2.0.0 brings incoming WhatsApp attachments directly into Home Assistant
automations. Images, voice notes, audio, videos, documents, and stickers can be
downloaded, decrypted, and saved automatically. Each attachment gets its own
temporary file and an authenticated download link in `new_whatsapp_message`.

This opens up workflows such as extracting text from photos and PDFs,
transcribing voice messages, classifying documents, or passing a received
image to an automation. OCR, transcription, conversion, and AI processing are
handled by whichever Home Assistant integration or service the automation uses.
The WhatsApp add-on only downloads, decrypts, verifies, and stores the file.

## Enable incoming media

1. Update **both** the WhatsApp add-on and HACS integration to **2.0.0 or newer**.
2. Restart Home Assistant after updating the integration.
3. Enable **Download incoming media** in the add-on configuration, then save
   and restart the add-on.

The option is off by default, so existing installations do not start saving
private attachments unexpectedly. Enabling it applies to incoming media across
all configured WhatsApp sessions and chats. Automation filters determine which
files to process afterwards, not which files are downloaded.

```yaml
download_media: true
media_retention_hours: 24
media_max_file_mb: 64
media_max_storage_mb: 1024
```

| Option | Default | Meaning |
| --- | --- | --- |
| `download_media` | `false` | Automatically save incoming attachments. |
| `media_retention_hours` | `24` | Keep each completed file for 1-720 hours. |
| `media_max_file_mb` | `64` | Maximum attachment size, 1-1024 MiB. |
| `media_max_storage_mb` | `1024` | Attachment-content budget, 1-102400 MiB; at least the maximum file size. |

Home Assistant OS shares `/media` with the add-on. Files are stored under
`/media/whatsapp/<unique-id>/file.<extension>`. The integration serves those
same files. A custom container deployment must mount the same storage at
`/media` in both containers. Installing only the add-on provides the files and
event metadata; the 2.0.0 integration provides authenticated HTTP access.

## Event data

The event keeps its original `clientId`, `type`, `key`, and `message` fields.
A successful media download adds the following object (example values):

```yaml
media:
  status: ready
  id: "12345678-1234-4123-8123-123456789abc"
  filename: "file.pdf"
  original_filename: "report.pdf"
  mime_type: "application/pdf"
  size: 48219
  local_path: "/media/whatsapp/12345678-1234-4123-8123-123456789abc/file.pdf"
  url: "/api/whatsapp/media/12345678-1234-4123-8123-123456789abc"
  expires_at: "2026-09-21T12:00:00.000Z"
```

`original_filename` is present only if WhatsApp supplied a filename. `size`
is the actual decrypted size in bytes. Unknown MIME types use `file.bin`;
the original name is metadata and never determines the storage path.

The event fires **after the complete file has been saved and its SHA-256
checked against the message**. Two messages with the same filename get
different directories. Text messages and outgoing `whatsapp_message_sent`
events are unchanged and have no new media object. Wrapped attachments are
detected, including document captions and view-once wrappers when the linked
session receives downloadable media. Quoted attachments are not downloaded
merely because a text message quotes them.

Media events wait for their own download. Other messages continue immediately,
so a later text message or smaller attachment can arrive in Home Assistant
before an earlier large attachment. Existing duplicate-message checks run
before downloading. The feature does not backfill history or create a second
"media ready" event.

## Use the file in an automation

This example forwards ready attachments to a processing script. Create
`script.process_whatsapp_attachment` separately using the OCR, transcription,
or document integration of your choice. It is a user-defined script, not an
action supplied by this project.

```yaml
- alias: Process a received WhatsApp attachment
  triggers:
    - trigger: event
      event_type: new_whatsapp_message
      event_data:
        clientId: default
  conditions:
    - condition: template
      value_template: >-
        {{ trigger.event.data.get('media', {}).get('status') == 'ready' }}
  actions:
    - action: script.process_whatsapp_attachment
      data:
        file_path: "{{ trigger.event.data.media.local_path }}"
        file_url: "{{ trigger.event.data.media.url }}"
        mime_type: "{{ trigger.event.data.media.mime_type }}"
        expires_at: "{{ trigger.event.data.media.expires_at }}"
  mode: parallel
  max: 10
```

Use `local_path` for a processor running inside Home Assistant that accepts
local files. Some integrations require the folder in
`allowlist_external_dirs`; follow that integration's file-access requirements.
Another add-on needs the same `/media` mount to read that path.

Use `url` for authenticated HTTP access. It is relative to the Home Assistant
base URL and requires a Home Assistant login session or an
`Authorization: Bearer <Home Assistant access token>` header. The add-on's
optional API token does not authenticate this URL. The endpoint supports
documents as well as images, audio, and video and serves them as downloads.

A cloud OCR or AI provider generally cannot fetch a private Home Assistant
URL. Its Home Assistant integration should read the local file and upload the
bytes, or otherwise handle authenticated fetching. This feature does not
publish files anonymously or create signed public links.

## Retention and failures

Each file's retention starts when its download completes. The expiry is saved
with the file and survives restarts. Changing the retention setting affects
new downloads; existing files keep their advertised expiry. Cleanup runs at
startup and every five minutes, including while `download_media` is disabled.
HTTP access ends at expiry immediately, even before cleanup removes the file.
Cleanup cannot run while the add-on is stopped; it catches up on startup.

To keep a file permanently or process it after expiry, copy it into a separate
folder before `expires_at`. Do not use `/media/whatsapp` for user-managed files.
The storage budget counts attachment bytes; filesystem metadata consumes some
additional disk space. Each active download reserves the maximum file size,
so new downloads may be rejected before the remaining free budget reaches zero.
There is also a limit of 10,000 retained or reserved attachments to bound
metadata and directory growth even for very small files.
Reducing the budget never deletes an unexpired attachment to make room.

Two downloads can run at once, with up to 32 pending attachments including
active downloads. Each has a 60-second deadline, including queue time.
Unavailable media can request a reupload through the linked WhatsApp session,
but that depends on another device still having the file.

If downloading fails, the incoming message event still fires:

```yaml
media:
  status: error
  error: timeout
```

| Error | Meaning |
| --- | --- |
| `timeout` | The download, reupload request, or queue wait exceeded its deadline. |
| `queue_full` | The pending-attachment limit was reached. |
| `file_too_large` | Decrypted bytes exceeded the per-file limit. |
| `storage_full` | The storage budget, retained-file limit, or available disk space was exhausted. |
| `storage_unavailable` | The shared media directory could not be initialized. |
| `invalid_metadata` | Required media metadata, including its checksum, was missing or invalid. |
| `checksum_mismatch` | The decrypted file did not match the message's checksum. |
| `download_failed` | Downloading or saving failed for another reason. |
| `stopped` | The add-on stopped before the file was ready. |

Error events do not include a file path or download link. Incomplete files are
removed, and interrupted-download leftovers are cleaned on startup. There is
no separate automatic retry action after an error event.

For a missing link, check that both components are updated, the integration is
loaded, and both containers see the same `/media` directory. HTTP `401` means
authentication is required, `404` means the file or integration is unavailable,
and `410` means the attachment has expired.

Saved files, original filenames, and automation traces may contain private
information. Retention removes the add-on's saved copies, not copies kept by
downstream processors, backups, or Home Assistant traces.
