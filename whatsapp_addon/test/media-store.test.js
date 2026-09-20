const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable, PassThrough } = require("node:stream");
const test = require("node:test");
const { MediaStore, parseMediaOptions } = require("../media-store");

const DATA = Buffer.from("Fictional attachment bytes");
const HASH = crypto.createHash("sha256").update(DATA).digest();
const content = (extra = {}) => ({
  mimetype: "audio/ogg; codecs=opus",
  fileSha256: HASH,
  ...extra,
});
const client = (extra = {}) => ({
  getMediaContent: () => content(),
  downloadMedia: async () => Readable.from([DATA]),
  ...extra,
});
const harness = async (t, options = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-media-test-"));
  const store = new MediaStore({ root, enabled: true, logger: {}, ...options });
  await store.start();
  t.after(async () => {
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return store;
};

test("media options are opt-in, bounded, and reserve enough storage for a file", () => {
  assert.equal(parseMediaOptions({}).enabled, false);
  assert.equal(parseMediaOptions({ download_media: true }).enabled, true);
  for (const options of [
    { download_media: "true" },
    { download_media: null },
    { media_retention_hours: null },
    { media_retention_hours: 0 },
    { media_max_file_mb: 1025 },
    { media_max_storage_mb: 0.5 },
    { media_retention_hours: "24" },
    { media_retention_hours: 721 },
    { media_max_file_mb: 20, media_max_storage_mb: 10 },
  ])
    assert.throws(() => parseMediaOptions(options));
});

test("simultaneous messages and repeated original filenames produce distinct complete files", async (t) => {
  const store = await harness(t);
  const fake = client({
    getMediaContent: () =>
      content({ mimetype: "application/pdf", fileName: "../report.pdf" }),
  });
  const results = await Promise.all([
    store.enrich({}, fake),
    store.enrich({}, fake),
  ]);
  assert.equal(results[0].status, "ready");
  assert.equal(results[1].status, "ready");
  assert.notEqual(results[0].id, results[1].id);
  for (const result of results) {
    assert.deepEqual(await fs.readFile(result.local_path), DATA);
    assert.equal(result.mime_type, "application/pdf");
    assert.equal(result.filename, "file.pdf");
    assert.equal(result.original_filename, "../report.pdf");
    assert.equal(result.url, `/api/whatsapp/media/${result.id}`);
    assert.equal(result.size, DATA.length);
    assert.ok(
      !JSON.stringify(
        await fs.readFile(
          path.join(store.root, result.id, "metadata.json"),
          "utf8",
        ),
      ).includes("fileSha256"),
    );
  }
  assert.equal(store.usedBytes, DATA.length * 2);
  assert.equal(store.reservedBytes, 0);
});

test("download completion is required before publishing a ready attachment", async (t) => {
  const store = await harness(t);
  const stream = new PassThrough();
  let started;
  const downloading = new Promise((resolve) => {
    started = resolve;
  });
  let done = false;
  const result = store.enrich(
    {},
    client({
      downloadMedia: async () => {
        started();
        return stream;
      },
    }),
  );
  void result.then(() => {
    done = true;
  });
  await downloading;
  stream.write(DATA);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  assert.ok(
    (await fs.readdir(store.root)).every((name) =>
      name.startsWith(".partial-"),
    ),
  );
  stream.end();
  assert.equal((await result).status, "ready");
});

test("disabled downloads and ordinary text do no downloading", async (t) => {
  const store = await harness(t, { enabled: false });
  assert.equal(await store.enrich({}, {}), undefined);
  store.enabled = true;
  assert.equal(
    await store.enrich({}, client({ getMediaContent: () => undefined })),
    undefined,
  );
});

test("malformed metadata, failed streams, oversized files, and corrupt content never publish a file", async (t) => {
  const store = await harness(t, { maxFileBytes: DATA.length - 1 });
  const cases = [
    [client(), "file_too_large"],
    [
      client({ getMediaContent: () => content({ fileSha256: undefined }) }),
      "invalid_metadata",
    ],
    [
      client({
        getMediaContent: () => {
          throw new Error("private metadata");
        },
      }),
      "invalid_metadata",
    ],
    [
      client({
        downloadMedia: async () => {
          throw new Error("private URL and key");
        },
      }),
      "download_failed",
    ],
    [
      client({
        downloadMedia: async () =>
          Readable.from(
            (async function* () {
              yield Buffer.from("part");
              throw new Error("private stream error");
            })(),
          ),
      }),
      "download_failed",
    ],
    [
      client({
        downloadMedia: async () => Readable.from([Buffer.from("wrong")]),
      }),
      "checksum_mismatch",
    ],
    [
      client({
        downloadMedia: async () => {
          throw Object.assign(new Error(), { code: "ENOSPC" });
        },
      }),
      "storage_full",
    ],
  ];
  for (const [fake, error] of cases) {
    assert.deepEqual(await store.enrich({}, fake), { status: "error", error });
    assert.deepEqual(await fs.readdir(store.root), []);
    assert.equal(store.reservedBytes, 0);
  }
});

test("unknown MIME types get safe binary filenames and original names remain bounded metadata", async (t) => {
  const store = await harness(t);
  for (const mimetype of [
    undefined,
    "bad\r\nheader",
    "application/x-fictional",
  ]) {
    const result = await store.enrich(
      {},
      client({
        getMediaContent: () =>
          content({ mimetype, fileName: "a".repeat(300) + "\r\n" }),
      }),
    );
    assert.equal(result.status, "ready");
    assert.equal(result.filename, "file.bin");
    assert.equal(result.original_filename.length, 255);
    assert.ok(!result.mime_type.includes("\r"));
  }
});

test("retention survives restarts, expires old files, and leaves unrelated directories alone", async (t) => {
  let now = Date.now();
  const store = await harness(t, { now: () => now, retentionMs: 1000 });
  const first = await store.enrich({}, client());
  await fs.mkdir(path.join(store.root, "user-folder"));
  await fs.writeFile(path.join(store.root, "user-folder", "keep.txt"), "keep");
  const partial = `.partial-${crypto.randomUUID()}`;
  await fs.mkdir(path.join(store.root, partial));
  await fs.writeFile(path.join(store.root, partial, "file.ogg"), DATA);
  await store.close();
  const restarted = new MediaStore({
    root: store.root,
    enabled: false,
    now: () => now,
    logger: {},
  });
  t.after(() => restarted.close());
  await restarted.start();
  assert.equal(restarted.usedBytes, DATA.length);
  assert.deepEqual(await fs.readFile(first.local_path), DATA);
  assert.ok(!(await fs.readdir(store.root)).includes(partial));
  now += 1001;
  await restarted.cleanup();
  assert.equal(restarted.usedBytes, 0);
  assert.deepEqual(await fs.readdir(store.root), ["user-folder"]);
});

test("quota rejects new files without evicting existing unexpired attachments", async (t) => {
  const store = await harness(t, {
    maxFileBytes: DATA.length,
    maxStorageBytes: DATA.length,
  });
  const first = await store.enrich({}, client());
  assert.deepEqual(await store.enrich({}, client()), {
    status: "error",
    error: "storage_full",
  });
  assert.deepEqual(await fs.readFile(first.local_path), DATA);
  assert.equal(store.usedBytes, DATA.length);
});

test("concurrent reservations cannot overrun the storage quota", async (t) => {
  const store = await harness(t, {
    maxFileBytes: DATA.length,
    maxStorageBytes: DATA.length,
  });
  const results = await Promise.all([
    store.enrich({}, client()),
    store.enrich({}, client()),
  ]);
  assert.equal(results.filter((r) => r.status === "ready").length, 1);
  assert.equal(results.filter((r) => r.error === "storage_full").length, 1);
});

test("small attachments cannot exhaust storage with unlimited metadata directories", async (t) => {
  const store = await harness(t, { maxFiles: 1 });
  const first = await store.enrich({}, client());
  assert.equal(first.status, "ready");
  assert.deepEqual(await store.enrich({}, client()), {
    status: "error",
    error: "storage_full",
  });
  assert.deepEqual(await fs.readFile(first.local_path), DATA);
});

test("queue limits, queue cancellation and stream timeout leave no partial files or reservations", async (t) => {
  const store = await harness(t, {
    concurrency: 1,
    maxPending: 2,
    timeoutMs: 100,
  });
  const blocked = client({ downloadMedia: async () => new PassThrough() });
  const first = store.enrich({}, blocked);
  const second = store.enrich({}, blocked);
  assert.deepEqual(await store.enrich({}, blocked), {
    status: "error",
    error: "queue_full",
  });
  assert.deepEqual(await first, { status: "error", error: "timeout" });
  assert.deepEqual(await second, { status: "error", error: "timeout" });
  assert.equal(store.active, 0);
  assert.equal(store.waiters.length, 0);
  assert.equal(store.reservedBytes, 0);
  assert.deepEqual(await fs.readdir(store.root), []);
});

test("shutdown cancels queued and active downloads and preserves completed files", async (t) => {
  const store = await harness(t, { concurrency: 1 });
  const ready = await store.enrich({}, client());
  let started;
  const downloading = new Promise((resolve) => {
    started = resolve;
  });
  const first = store.enrich(
    {},
    client({
      downloadMedia: async () => {
        started();
        return new PassThrough();
      },
    }),
  );
  const second = store.enrich({}, client());
  await downloading;
  await store.close();
  assert.deepEqual(await first, { status: "error", error: "stopped" });
  assert.deepEqual(await second, { status: "error", error: "stopped" });
  assert.deepEqual(await fs.readdir(store.root), [ready.id]);
  assert.deepEqual(await store.enrich({}, client()), {
    status: "error",
    error: "stopped",
  });
});

test("storage failures preserve ordinary messaging and can recover on cleanup", async (t) => {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), "whatsapp-media-test-"),
  );
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "storage");
  await fs.writeFile(root, "not a directory");
  const store = new MediaStore({ root, enabled: true, logger: {} });
  t.after(() => store.close());
  await store.start();
  assert.deepEqual(await store.enrich({}, client()), {
    status: "error",
    error: "storage_unavailable",
  });
  await fs.unlink(root);
  await store.cleanup();
  assert.equal((await store.enrich({}, client())).status, "ready");
});

for (const mediaType of ["image", "audio", "video", "document", "sticker"]) {
  test(`installed Baileys decrypts ${mediaType} bytes before the store publishes a file`, async (t) => {
    const baileys = await import("@whiskeysockets/baileys");
    const mediaKey = crypto.randomBytes(32);
    const { cipherKey, iv, macKey } = await baileys.getMediaKeys(
      mediaKey,
      mediaType,
    );
    const cipher = crypto.createCipheriv("aes-256-cbc", cipherKey, iv);
    const ciphertext = Buffer.concat([cipher.update(DATA), cipher.final()]);
    const mac = crypto
      .createHmac("sha256", macKey)
      .update(iv)
      .update(ciphertext)
      .digest()
      .subarray(0, 10);
    const encrypted = Buffer.concat([ciphertext, mac]);
    const message = {
      key: { id: "fictional", fromMe: false },
      message: {
        [`${mediaType}Message`]: {
          ...content(),
          mediaKey,
          url: "https://mmg.whatsapp.net/fictional.enc",
        },
      },
    };
    const store = await harness(t);
    const result = await store.enrich(
      message,
      client({
        downloadMedia: (value, { signal }) =>
          baileys.downloadMediaMessage(value, "stream", {
            options: {
              signal,
              adapter: async (config) => ({
                status: 200,
                statusText: "OK",
                headers: {},
                config,
                data: Readable.from([
                  encrypted.subarray(0, 7),
                  encrypted.subarray(7),
                ]),
              }),
            },
          }),
      }),
    );
    assert.equal(result.status, "ready");
    assert.deepEqual(await fs.readFile(result.local_path), DATA);
  });
}
