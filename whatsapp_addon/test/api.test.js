const assert = require("node:assert/strict");
const test = require("node:test");

const { API_CAPABILITIES, createApiApp } = require("../api");
const {
  WhatsappDisconnectedError,
  WhatsappProtocolError,
  WhatsappUpstreamError,
} = require("../whatsapp");

const FICTIONAL_NUMBER = "12025550123";
const FICTIONAL_JID = `${FICTIONAL_NUMBER}@s.whatsapp.net`;
const FICTIONAL_LID = "999999999999999@lid";

const listen = (app) =>
  new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });

const close = (server) =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );

const withApp = async (options, callback) => {
  const app = createApiApp(options);
  const server = await listen(app);
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await close(server);
  }
};

const request = async (baseUrl, endpoint, { body, headers, rawBody } = {}) => {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: body === undefined && rawBody === undefined ? "GET" : "POST",
    headers: {
      ...(rawBody === undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: rawBody === undefined ? JSON.stringify(body) : rawBody,
  });
  const text = await response.text();
  let payload = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // Existing successful mutation routes intentionally retain their OK body.
  }

  return { headers: response.headers, payload, status: response.status };
};

const createClient = (overrides = {}) => ({
  checkNumber: async () => ({
    jid: FICTIONAL_JID,
    exists: true,
    lid: FICTIONAL_LID,
  }),
  presenceSubscribe: async () => {},
  readMessages: async () => {},
  sendMessage: async () => ({ key: { id: "fictional-message-id" } }),
  sendPresenceUpdate: async () => {},
  setSendPresenceUpdateInterval: async () => {},
  updateProfileStatus: async () => {},
  ...overrides,
});

test("health identifies the API without exposing client IDs or CORS", async () => {
  let nativeHealthRequests = 0;
  await withApp(
    {
      clients: { default: createClient(), backup: createClient() },
      diagnostics: {
        recordNativeHealthProbe() {
          nativeHealthRequests += 1;
        },
      },
    },
    async (baseUrl) => {
      const response = await request(baseUrl, "/health");

      assert.equal(response.status, 200);
      assert.deepEqual(response.payload, {
        status: "ok",
        service: "ha-whatsapp-addon",
        api_version: 1,
        capabilities: [...API_CAPABILITIES],
        client_count: 2,
      });
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal(response.headers.get("x-powered-by"), null);
      assert.ok(!JSON.stringify(response.payload).includes("default"));

      const wrongMarker = await request(baseUrl, "/health", {
        headers: { "x-ha-healthcheck": "not-docker" },
      });
      const nativeProbe = await request(baseUrl, "/health", {
        headers: { "x-ha-healthcheck": "docker" },
      });
      assert.deepEqual(wrongMarker.payload, response.payload);
      assert.deepEqual(nativeProbe.payload, response.payload);
      assert.equal(nativeHealthRequests, 1);
    }
  );
});

test("paused clients remain healthy but reject API actions", async () => {
  await withApp(
    {
      clients: {},
      clientStates: {
        default: { state: "recovery_paused" },
        backup: { state: "recovery_paused" },
      },
    },
    async (baseUrl) => {
      const health = await request(baseUrl, "/health");
      assert.equal(health.status, 200);
      assert.equal(health.payload.status, "ok");
      assert.equal(health.payload.client_count, 2);

      const action = await request(baseUrl, "/sendMessage", {
        body: {
          clientId: "default",
          to: FICTIONAL_JID,
          body: { text: "Hello" },
        },
      });
      assert.equal(action.status, 503);
      assert.equal(action.payload.error.code, "client_recovery_paused");
    }
  );
});

test("API timing diagnostics stay aggregate and exclude health probes", async () => {
  let active = 0;
  let completed = 0;
  await withApp(
    {
      clients: { default: createClient() },
      diagnostics: {
        startApiRequest() {
          active += 1;
          return () => {
            active -= 1;
            completed += 1;
          };
        },
      },
    },
    async (baseUrl) => {
      assert.equal((await request(baseUrl, "/health")).status, 200);
      assert.equal(completed, 0);
      assert.equal(
        (
          await request(baseUrl, "/setStatus", {
            body: { clientId: "default", status: "Available" },
          })
        ).status,
        200
      );
      assert.equal(active, 0);
      assert.equal(completed, 1);
    }
  );
});

test("onWhatsApp returns stable registered and unregistered responses", async () => {
  let exists = true;
  const client = createClient({
    checkNumber: async (jid) => ({
      jid,
      exists,
      lid: exists ? FICTIONAL_LID : null,
    }),
  });

  await withApp({ clients: { default: client } }, async (baseUrl) => {
    let response = await request(baseUrl, "/onWhatsApp", {
      body: { clientId: "default", to: `+${FICTIONAL_NUMBER}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.payload, {
      jid: FICTIONAL_JID,
      exists: true,
      lid: FICTIONAL_LID,
    });

    exists = false;
    response = await request(baseUrl, "/onWhatsApp", {
      body: { clientId: "default", to: FICTIONAL_JID },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.payload, {
      jid: FICTIONAL_JID,
      exists: false,
      lid: null,
    });
  });
});

test("onWhatsApp rejects invalid recipients before calling Baileys", async () => {
  let calls = 0;
  const client = createClient({
    checkNumber: async () => {
      calls += 1;
    },
  });

  await withApp({ clients: { default: client } }, async (baseUrl) => {
    for (const to of [
      "120363000000000000@g.us",
      FICTIONAL_LID,
      "status@broadcast",
      `${FICTIONAL_NUMBER}:2@s.whatsapp.net`,
      "not-a-number",
    ]) {
      const response = await request(baseUrl, "/onWhatsApp", {
        body: { clientId: "default", to },
      });
      assert.equal(response.status, 400);
      assert.equal(response.payload.error.code, "invalid_request");
    }
    assert.equal(calls, 0);
  });
});

test("API validation and missing-client errors use one JSON contract", async () => {
  await withApp({ clients: { default: createClient() } }, async (baseUrl) => {
    let response = await request(baseUrl, "/sendMessage", { body: {} });
    assert.equal(response.status, 400);
    assert.deepEqual(Object.keys(response.payload.error).sort(), [
      "code",
      "message",
    ]);
    assert.equal(response.payload.error.code, "invalid_request");

    response = await request(baseUrl, "/sendMessage", {
      body: {
        clientId: "missing",
        to: FICTIONAL_JID,
        body: { text: "Hello" },
      },
    });
    assert.equal(response.status, 404);
    assert.equal(response.payload.error.code, "client_not_found");

    response = await request(baseUrl, "/onWhatsApp", {
      body: { clientId: "../escape", to: FICTIONAL_NUMBER },
    });
    assert.equal(response.status, 400);
    assert.equal(response.payload.error.code, "invalid_request");

    response = await request(baseUrl, "/not-an-endpoint", { body: {} });
    assert.equal(response.status, 404);
    assert.equal(response.payload.error.code, "not_found");
  });
});

test("optional bearer authentication protects POST routes but not health", async () => {
  const token = "fictional-long-api-token";
  await withApp(
    { clients: { default: createClient() }, sharedSecret: token },
    async (baseUrl) => {
      assert.equal((await request(baseUrl, "/health")).status, 200);

      let response = await request(baseUrl, "/onWhatsApp", {
        body: { clientId: "default", to: FICTIONAL_NUMBER },
      });
      assert.equal(response.status, 401);
      assert.equal(response.payload.error.code, "unauthorized");

      response = await request(baseUrl, "/onWhatsApp", {
        body: { clientId: "default", to: FICTIONAL_NUMBER },
        headers: { authorization: "Bearer wrong-token" },
      });
      assert.equal(response.status, 401);

      response = await request(baseUrl, "/onWhatsApp", {
        body: { clientId: "default", to: FICTIONAL_NUMBER },
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 200);
    }
  );
});

test("number lookups are rate limited per client", async () => {
  await withApp(
    {
      clients: { default: createClient() },
      lookupRateLimit: { limit: 2, windowMs: 60_000, now: () => 1_000 },
    },
    async (baseUrl) => {
      const invalid = await request(baseUrl, "/onWhatsApp", {
        body: { clientId: "default", to: "not-a-number" },
      });
      assert.equal(invalid.status, 400);

      for (let index = 0; index < 2; index += 1) {
        const response = await request(baseUrl, "/onWhatsApp", {
          body: { clientId: "default", to: FICTIONAL_NUMBER },
        });
        assert.equal(response.status, 200);
      }

      const response = await request(baseUrl, "/onWhatsApp", {
        body: { clientId: "default", to: FICTIONAL_NUMBER },
      });
      assert.equal(response.status, 429);
      assert.equal(response.payload.error.code, "rate_limited");
      assert.equal(response.headers.get("retry-after"), "60");
    }
  );
});

test("WhatsApp failures map to operational HTTP statuses", async () => {
  const cases = [
    [new WhatsappDisconnectedError(), 503, "client_disconnected"],
    [new WhatsappUpstreamError(), 502, "upstream_error"],
    [new WhatsappProtocolError(), 502, "upstream_error"],
  ];

  for (const [error, status, code] of cases) {
    await withApp(
      {
        clients: {
          default: createClient({
            checkNumber: async () => {
              throw error;
            },
          }),
        },
      },
      async (baseUrl) => {
        const response = await request(baseUrl, "/onWhatsApp", {
          body: { clientId: "default", to: FICTIONAL_NUMBER },
        });
        assert.equal(response.status, status);
        assert.equal(response.payload.error.code, code);
      }
    );
  }
});

test("malformed lookup results become upstream errors", async () => {
  for (const result of [
    { jid: FICTIONAL_JID, exists: true, lid: "malformed" },
    { jid: FICTIONAL_JID, exists: false, lid: FICTIONAL_LID },
  ]) {
    await withApp(
      {
        clients: {
          default: createClient({ checkNumber: async () => result }),
        },
      },
      async (baseUrl) => {
        const response = await request(baseUrl, "/onWhatsApp", {
          body: { clientId: "default", to: FICTIONAL_NUMBER },
        });
        assert.equal(response.status, 502);
        assert.equal(response.payload.error.code, "upstream_error");
      }
    );
  }
});

test("existing routes validate input and retain compatible success bodies", async () => {
  const calls = [];
  const client = createClient({
    presenceSubscribe: async (...args) => calls.push(["subscribe", ...args]),
    readMessages: async (...args) => calls.push(["read", ...args]),
    sendMessage: async (...args) => {
      calls.push(["send", ...args]);
      return { key: { id: "fictional-message-id" } };
    },
    sendPresenceUpdate: async (...args) => calls.push(["presence", ...args]),
    setSendPresenceUpdateInterval: async (...args) =>
      calls.push(["infinity", ...args]),
    updateProfileStatus: async (...args) => calls.push(["status", ...args]),
  });

  await withApp({ clients: { default: client } }, async (baseUrl) => {
    const cases = [
      [
        "/sendMessage",
        {
          clientId: "default",
          to: FICTIONAL_JID,
          body: { text: "Hello" },
        },
        200,
      ],
      ["/setStatus", { clientId: "default", status: "Available" }, 200],
      [
        "/presenceSubscribe",
        { clientId: "default", userId: FICTIONAL_JID },
        200,
      ],
      [
        "/sendPresenceUpdate",
        { clientId: "default", type: "available", to: FICTIONAL_JID },
        200,
      ],
      [
        "/sendInfinityPresenceUpdate",
        { clientId: "default", type: "available", to: FICTIONAL_JID },
        200,
      ],
      [
        "/readMessages",
        { clientId: "default", body: { keys: { id: "fictional-key" } } },
        200,
      ],
    ];

    for (const [endpoint, body, expectedStatus] of cases) {
      const response = await request(baseUrl, endpoint, { body });
      assert.equal(response.status, expectedStatus);
      if (endpoint !== "/sendMessage") assert.equal(response.payload, "OK");
    }
    assert.equal(calls.length, cases.length);

    const invalidPresence = await request(baseUrl, "/sendPresenceUpdate", {
      body: { clientId: "default", type: "not-valid" },
    });
    assert.equal(invalidPresence.status, 400);
    assert.equal(invalidPresence.payload.error.code, "invalid_request");
  });
});

test("malformed JSON and unexpected failures do not leak raw errors to logs", async () => {
  const logEntries = [];
  const sensitiveText = `private failure for ${FICTIONAL_JID}`;
  const logger = { warn: (...args) => logEntries.push(args) };
  await withApp(
    {
      clients: {
        default: createClient({
          checkNumber: async () => {
            throw new Error(sensitiveText);
          },
        }),
      },
      logger,
    },
    async (baseUrl) => {
      let response = await request(baseUrl, "/onWhatsApp", {
        body: { clientId: "default", to: FICTIONAL_NUMBER },
      });
      assert.equal(response.status, 500);
      assert.equal(response.payload.error.code, "internal_error");

      response = await request(baseUrl, "/sendMessage", {
        rawBody: "{not json",
        headers: { "content-type": "application/json" },
      });
      assert.equal(response.status, 400);
      assert.equal(response.payload.error.code, "invalid_request");
    }
  );

  const serializedLogs = JSON.stringify(logEntries);
  assert.ok(!serializedLogs.includes(sensitiveText));
  assert.ok(!serializedLogs.includes(FICTIONAL_NUMBER));
});
