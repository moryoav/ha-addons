const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const test = require("node:test");

const PAGE_URL = "https://example.com/preview-fixture";

test("URL messages include page metadata and a JPEG preview", async (t) => {
  const { generateWAMessageContent, getUrlInfo } = await import(
    "@whiskeysockets/baileys"
  );
  const sharp = (await import("sharp")).default;
  const image = await sharp({
    create: {
      width: 320,
      height: 180,
      channels: 3,
      background: "#32649a",
    },
  }).png().toBuffer();
  const imageRequests = [];
  const server = http.createServer((request, response) => {
    imageRequests.push(request.url);
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(image);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const imageUrl = `http://127.0.0.1:${server.address().port}/preview.png`;
  const pageFetch = t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, PAGE_URL);
    const response = new Response(
      `<html><head><title>Preview fixture</title>
       <meta name="description" content="Fixture description">
       <meta property="og:image" content="${imageUrl}">
       </head></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
    Object.defineProperty(response, "url", { value: PAGE_URL });
    return response;
  });
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args), debug() {} };
  const text = `Check ${PAGE_URL}`;
  const message = await generateWAMessageContent(
    { text },
    {
      logger,
      getUrlInfo: (url) => getUrlInfo(url, {
        thumbnailWidth: 192,
        fetchOpts: { timeout: 3000 },
        logger,
      }),
    }
  );

  const preview = message.extendedTextMessage;
  assert.equal(preview.text, text);
  assert.equal(preview.matchedText, PAGE_URL);
  assert.equal(preview.title, "Preview fixture");
  assert.equal(preview.description, "Fixture description");
  assert.ok(preview.jpegThumbnail.length > 0);
  const thumbnail = await sharp(preview.jpegThumbnail).metadata();
  assert.equal(thumbnail.format, "jpeg");
  assert.equal(thumbnail.width, 192);
  assert.equal(pageFetch.mock.callCount(), 1);
  assert.deepEqual(imageRequests, ["/preview.png"]);
  assert.deepEqual(warnings, []);
});

test("an unavailable preview page preserves the outgoing message text", async (t) => {
  const { generateWAMessageContent, getUrlInfo } = await import(
    "@whiskeysockets/baileys"
  );
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Fixture page unavailable");
  });
  const warnings = [];
  const text = `Check ${PAGE_URL}`;
  const message = await generateWAMessageContent(
    { text },
    { getUrlInfo, logger: { warn: (...args) => warnings.push(args) } }
  );

  assert.equal(message.extendedTextMessage.text, text);
  assert.ok(!message.extendedTextMessage.title);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1], "url generation failed");
  assert.match(warnings[0][0].trace, /Fixture page unavailable/);
});
