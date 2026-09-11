# Send sensor charts

I use the workflow from my [sensor chart tutorial](https://smarthome.yoavmor.com/home-assistant/creating-images-of-graph-data-from-home-assistant-sensors/)
to attach a graph to a temperature alert: Home Assistant logs readings to
Google Sheets, a published chart provides an image URL, and WhatsApp sends that
image with the current reading.

## Record the sensor readings

Set up the [Google Sheets integration](https://www.home-assistant.io/integrations/google_sheets/).
In the action editor, choose **Google Sheets: Append sheet** and select your
configured spreadsheet. Switch to YAML and copy its `config_entry` value into
the automation below. This is a Home Assistant integration entry ID, not the
spreadsheet ID in the Google URL.

```yaml
- alias: Record temperature for a WhatsApp chart
  triggers:
    - trigger: time_pattern
      minutes: "/10"
  conditions:
    - condition: template
      value_template: "{{ is_number(states('sensor.fridge_temperature')) }}"
  actions:
    - action: google_sheets.append_sheet
      data:
        config_entry: REPLACE_WITH_GOOGLE_SHEETS_CONFIG_ENTRY
        worksheet: Sheet1
        add_created_column: true
        data:
          Temperature: "{{ states('sensor.fridge_temperature') | float }}"
  mode: single
```

The action adds a `created` timestamp column alongside `Temperature`. Invalid
or unavailable sensor readings are skipped. See the [append action reference](https://www.home-assistant.io/actions/google_sheets.append_sheet/).

## Publish the chart as an image

In that spreadsheet, select the timestamp and temperature columns, then use
**Insert > Chart**. Open the chart menu, choose **Publish chart**, select
**Image**, and copy the published URL. Enable automatic republishing. Use that
image URL in the next example, replacing the fictional file URL.

A published chart exposes its displayed data to anyone who has the link. Use
only data you intend to publish. The add-on must be able to download the image
without an interactive Google login. See [Google's publishing instructions](https://support.google.com/docs/answer/183965).

## Send the image when a threshold is crossed

Replace the sensor, recipient, chart URL, and threshold for your setup. This
example assumes the temperature sensor uses degrees Celsius.

```yaml
- alias: WhatsApp temperature alert with chart
  triggers:
    - trigger: numeric_state
      entity_id: sensor.fridge_temperature
      above: 8
      for: "00:05:00"
  actions:
    - variables:
        temperature: "{{ states('sensor.fridge_temperature') }}"
    - condition: template
      value_template: "{{ is_number(temperature) }}"
    - action: whatsapp.send_message
      data:
        clientId: default
        to: 120363000000000000@g.us
        body:
          image:
            url: "https://files.example.com/temperature-chart.png"
          caption: >-
            Fridge temperature is {{ temperature }} C.
            The chart shows the recent logged readings.
  mode: single
```

This sends once after the sensor crosses the threshold and stays above it for
five minutes. It can trigger again after the sensor drops below the threshold
and crosses it again. Google chart refreshes can lag behind new rows, so the
latest alert reading may not appear in the image immediately.

## Keep a rolling chart window

The blog also uses Google Apps Script to remove old readings. For a sheet
dedicated to this chart, open **Extensions > Apps Script** and add:

```javascript
function trimTemperatureHistory() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet1');
  const keepReadings = 144; // About one day when recording every 10 minutes.
  if (!sheet) return;
  const excessRows = sheet.getLastRow() - 1 - keepReadings;
  if (excessRows > 0) {
    sheet.deleteRows(2, excessRows); // Keep the header in row 1.
  }
}
```

Run it once to authorize access, then add a time-driven trigger for the function,
for example every ten minutes. It removes all excess rows in one pass while
preserving the header. These rows are deleted from the sheet, so choose the
retention period before enabling it. The chart should cover the full data
columns as new rows arrive. [Google's Sheet reference](https://developers.google.com/apps-script/reference/spreadsheet/sheet#deleteRows(Integer,Integer))
documents `deleteRows`.
