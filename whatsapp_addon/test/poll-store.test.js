const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PollStore } = require("../poll-store");

// Every identity, secret and poll below is generated or fictional.
const OWNER = "12025550123:4@s.whatsapp.net";
const OWNER_PN = "12025550123@s.whatsapp.net";
const OWNER_LID = "999999999999991@lid";
const ME = { id: OWNER, lid: "999999999999991:4@lid" };
const VOTER_PN = "12025550124@s.whatsapp.net";
const VOTER_LID = "999999999999992@lid";
const CREATOR_PN = "12025550125@s.whatsapp.net";
const CREATOR_LID = "999999999999993@lid";
const GROUP = "120363000000000000@g.us";
const OPTIONS = ["Daily report", "Weekly report", "Monthly report"];
const DAY_MS = 24 * 60 * 60 * 1000;

const fixture = async (t, options = {}) => {
  const baileys = await import("@whiskeysockets/baileys");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-polls-"));
  const errors = [];
  const create = (extra = {}) =>
    new PollStore({ directory, onError: (...args) => errors.push(args), ...options, ...extra });
  const store = create();
  t.after(async () => {
    await store.flush();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const decode = (message, target = store, me = ME) => target.decode(message, { ...baileys, me });

  // Encrypts a vote the way a voter's phone does, independently of Baileys.
  const encryptVote = ({ secret, pollId, creator, voter, selected }) => {
    const info = Buffer.concat([pollId, creator, voter, "Poll Vote"].map((part) => Buffer.from(part)));
    const key = Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.alloc(32), info, 32));
    const encIv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, encIv);
    cipher.setAAD(Buffer.from(`${pollId}\u0000${voter}`));
    const plain = baileys.proto.Message.PollVoteMessage.encode({
      selectedOptions: selected.map((name) => crypto.createHash("sha256").update(name).digest()),
    }).finish();
    return { encPayload: Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]), encIv };
  };
  let sequence = 0;
  const vote = ({ poll, creator = OWNER_PN, voter = VOTER_PN, selected = [OPTIONS[1]], key = {}, creationKey = {},
    secret = poll.message.messageContextInfo.messageSecret }) => ({
    key: { id: `FICTIONALVOTE${sequence++}`, remoteJid: GROUP, fromMe: false, participant: voter, ...key },
    message: { pollUpdateMessage: {
      pollCreationMessageKey: { id: poll.key.id, remoteJid: GROUP, fromMe: poll.key.fromMe, ...creationKey },
      vote: encryptVote({ secret, pollId: poll.key.id, creator, voter, selected }),
    } },
  });
  return { baileys, create, decode, directory, errors, store, vote, file: path.join(directory, "poll-cache.json") };
};

const pollMessage = ({ id = "FICTIONALPOLL0", key = {}, options = OPTIONS, name = "Which report would you like?",
  secret = crypto.randomBytes(32), field = "pollCreationMessage" } = {}) => ({
  key: { id, remoteJid: GROUP, fromMe: true, ...key },
  message: {
    [field]: { name, options: options.map((optionName) => ({ optionName })) },
    messageContextInfo: { messageSecret: secret },
  },
});
const ready = (poll, selected) => ({
  status: "ready", poll_id: poll.key.id, poll_name: "Which report would you like?", selected_options: selected,
});
const failure = (poll, error) => ({ status: "error", error, poll_id: poll.key.id });

test("a vote on a remembered poll decodes to the voter's whole current selection", async (t) => {
  const { baileys, decode, store, vote } = await fixture(t);
  await store.load(OWNER);
  const poll = pollMessage();
  assert.equal(store.remember(poll, baileys), true);
  assert.deepEqual(decode(vote({ poll })), ready(poll, ["Weekly report"]));
  // Options are reported in the poll's own order.
  assert.deepEqual(decode(vote({ poll, selected: [OPTIONS[2], OPTIONS[0]] })),
    ready(poll, ["Daily report", "Monthly report"]));
  assert.deepEqual(decode(vote({ poll, selected: [] })), ready(poll, []));
  for (const other of [poll, { key: { id: "FICTIONALTEXT" }, message: { conversation: "Fictional text" } },
    { key: { id: "FICTIONALSTUB" } }, { key: { id: "FICTIONALEMPTYVOTE" }, message: { pollUpdateMessage: {
      pollCreationMessageKey: { id: poll.key.id } } } }, undefined]) {
    assert.equal(decode(other), undefined);
  }
});

test("the phone-number and LID forms of the creator and the voter are all tried", async (t) => {
  const { baileys, decode, store, vote } = await fixture(t);
  await store.load(OWNER);
  const mine = pollMessage();
  const theirs = pollMessage({ id: "FICTIONALPOLL1",
    key: { fromMe: false, participant: CREATOR_LID, participantPn: CREATOR_PN } });
  const direct = pollMessage({ id: "FICTIONALPOLL2", key: { remoteJid: VOTER_PN } });
  for (const poll of [mine, theirs, direct]) store.remember(poll, baileys);

  const voterKey = { participant: VOTER_LID, participantPn: `${VOTER_PN.split("@")[0]}:7@s.whatsapp.net` };
  for (const creator of [OWNER_PN, OWNER_LID]) {
    for (const voter of [VOTER_PN, VOTER_LID]) {
      assert.deepEqual(decode(vote({ poll: mine, creator, voter, key: voterKey })), ready(mine, ["Weekly report"]));
    }
  }
  // The voter's phone names another member's poll by that member's phone number.
  assert.deepEqual(decode(vote({ poll: theirs, creator: CREATOR_PN, creationKey: { participant: CREATOR_LID } })),
    ready(theirs, ["Weekly report"]));
  assert.deepEqual(decode(vote({ poll: theirs, creator: CREATOR_PN, creationKey: { participant: CREATOR_PN } }),
    undefined, {}), ready(theirs, ["Weekly report"]));
  // A direct chat reported as a phone number for the poll and as a LID for the vote.
  const directKey = { remoteJid: VOTER_LID, participant: undefined, senderPn: VOTER_PN };
  assert.deepEqual(decode(vote({ poll: direct, key: directKey, creationKey: { remoteJid: VOTER_LID } })),
    ready(direct, ["Weekly report"]));
  // A vote this account cast on the phone.
  assert.deepEqual(decode(vote({ poll: mine, creator: OWNER_LID, voter: OWNER_LID,
    key: { fromMe: true, participant: undefined } })), ready(mine, ["Weekly report"]));
});

test("votes that cannot be decoded say why and are never guessed", async (t) => {
  const { baileys, decode, store, vote } = await fixture(t);
  await store.load(OWNER);
  const poll = pollMessage();
  const unseen = pollMessage({ id: "FICTIONALPOLL1" });
  store.remember(poll, baileys);
  assert.deepEqual(decode(vote({ poll: unseen })), failure(unseen, "unknown_poll"));
  assert.deepEqual(decode(vote({ poll, secret: crypto.randomBytes(32) })), failure(poll, "decrypt_failed"));
  // Encrypted for an identity the message does not come from.
  assert.deepEqual(decode(vote({ poll, voter: CREATOR_PN, key: { participant: VOTER_PN } })),
    failure(poll, "decrypt_failed"));
  assert.deepEqual(decode(vote({ poll, creator: CREATOR_PN })), failure(poll, "decrypt_failed"));
  assert.deepEqual(decode(vote({ poll, selected: [OPTIONS[0], "Yearly report"] })), failure(poll, "unknown_option"));
  const noId = vote({ poll });
  delete noId.message.pollUpdateMessage.pollCreationMessageKey.id;
  assert.deepEqual(decode(noId), { status: "error", error: "unknown_poll" });
});

test("polls survive a restart, stay separate between accounts and are cleared with the session", async (t) => {
  const { baileys, create, decode, file, store, vote } = await fixture(t, { now: () => 1_000 });
  await store.load(OWNER);
  const secret = crypto.randomBytes(32);
  const poll = pollMessage({ secret });
  const theirs = pollMessage({ id: "FICTIONALPOLL1", key: { fromMe: false, participant: CREATOR_LID,
    participantPn: CREATOR_PN, extra: "Do not store" } });
  store.remember({ ...poll, pushName: "Do not store" }, baileys);
  store.remember(theirs, baileys);
  await store.flush();
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(saved, { version: 1, owner: OWNER_PN, polls: [
    ["FICTIONALPOLL0", { secret: secret.toString("base64"), name: "Which report would you like?",
      options: OPTIONS, chat: GROUP, mine: true, creators: [], expires: 1_000 + 30 * DAY_MS }],
    ["FICTIONALPOLL1", { secret: theirs.message.messageContextInfo.messageSecret.toString("base64"),
      name: "Which report would you like?", options: OPTIONS, chat: GROUP, mine: false,
      creators: [CREATOR_LID, CREATOR_PN], expires: 1_000 + 30 * DAY_MS }],
  ] });

  const restored = create();
  await restored.load("12025550123:9@s.whatsapp.net");
  assert.deepEqual(decode(vote({ poll }), restored), ready(poll, ["Weekly report"]));
  const different = create();
  await different.load("12025550126@s.whatsapp.net");
  assert.deepEqual(decode(vote({ poll }), different), failure(poll, "unknown_poll"));

  store.setOwner("12025550126@s.whatsapp.net");
  assert.deepEqual(decode(vote({ poll })), failure(poll, "unknown_poll"));
  await store.flush();
  store.setOwner(OWNER);
  store.remember(poll, baileys);
  store.clear();
  await store.flush();
  const empty = create();
  await empty.load(OWNER);
  assert.deepEqual(decode(vote({ poll }), empty), failure(poll, "unknown_poll"));
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).polls, []);
});

test("the newest 100 polls are kept for 30 days and expired ones leave the disk", async (t) => {
  let now = 1_000;
  const { baileys, create, decode, file, store, vote } = await fixture(t, { now: () => now });
  await store.load(OWNER);
  const polls = Array.from({ length: 101 }, (unused, index) => pollMessage({ id: `FICTIONALPOLL${index}` }));
  store.remember(polls[0], baileys);
  now += 10 * DAY_MS;
  for (const poll of polls.slice(1)) store.remember(poll, baileys);
  assert.deepEqual(decode(vote({ poll: polls[0] })), failure(polls[0], "unknown_poll"));
  assert.deepEqual(decode(vote({ poll: polls[1] })), ready(polls[1], ["Weekly report"]));
  assert.deepEqual(decode(vote({ poll: polls[100] })), ready(polls[100], ["Weekly report"]));

  now += 30 * DAY_MS - 1;
  assert.deepEqual(decode(vote({ poll: polls[100] })), ready(polls[100], ["Weekly report"]));
  await store.flush();
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).polls.length, 100);
  now += 1;
  await store.flush();
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).polls, []);
  assert.deepEqual(decode(vote({ poll: polls[100] })), failure(polls[100], "unknown_poll"));

  // A poll that expired while the add-on was stopped is not loaded again.
  store.remember(polls[5], baileys);
  await store.flush();
  now += 30 * DAY_MS;
  const restored = create();
  await restored.load(OWNER);
  assert.deepEqual(decode(vote({ poll: polls[5] }), restored), failure(polls[5], "unknown_poll"));
});

test("a replayed or forged poll never replaces the stored one or extends its lifetime", async (t) => {
  let now = 1_000;
  const { baileys, decode, store, vote } = await fixture(t, { now: () => now });
  await store.load(OWNER);
  const poll = pollMessage();
  const forged = pollMessage({ key: { remoteJid: CREATOR_PN, fromMe: false }, options: ["Yes", "No"] });
  assert.equal(store.remember(poll, baileys), true);
  now += 20 * DAY_MS;
  assert.equal(store.remember(forged, baileys), false);
  assert.equal(store.remember(poll, baileys), false);
  assert.deepEqual(decode(vote({ poll })), ready(poll, ["Weekly report"]));
  assert.deepEqual(decode(vote({ poll: forged, creator: CREATOR_PN, selected: ["Yes"] })),
    failure(poll, "decrypt_failed"));
  now += 10 * DAY_MS;
  assert.deepEqual(decode(vote({ poll })), failure(poll, "unknown_poll"));
});

test("polls built by the installed Baileys sender and wrapped polls are remembered", async (t) => {
  const { baileys, decode, store, vote } = await fixture(t);
  await store.load(OWNER);
  const sent = await baileys.generateWAMessage(GROUP,
    { poll: { name: "Which report would you like?", values: OPTIONS, selectableCount: 1 } }, { userJid: OWNER });
  assert.ok(sent.message.pollCreationMessageV3);
  assert.equal(store.remember(sent, baileys), true);
  assert.deepEqual(decode(vote({ poll: sent })), ready(sent, ["Weekly report"]));

  const inner = pollMessage({ id: "FICTIONALPOLL1", field: "pollCreationMessageV2" });
  const disappearing = { key: inner.key, message: { ephemeralMessage: { message: inner.message } } };
  const base = pollMessage({ id: "FICTIONALPOLL2" });
  const wrapped = { key: base.key, message: { pollCreationMessageV5: { message: {
    pollCreationMessage: base.message.pollCreationMessage } }, messageContextInfo: base.message.messageContextInfo } };
  for (const [message, poll] of [[disappearing, inner], [wrapped, base]]) {
    assert.equal(store.remember(message, baileys), true);
    assert.deepEqual(decode(vote({ poll })), ready(poll, ["Weekly report"]));
  }
});

test("malformed polls are not stored", async (t) => {
  const { baileys, decode, store, vote } = await fixture(t);
  await store.load(OWNER);
  const valid = pollMessage();
  const malformed = [
    pollMessage({ secret: crypto.randomBytes(31) }),
    pollMessage({ secret: crypto.randomBytes(32).toString("base64") }),
    pollMessage({ options: [] }),
    pollMessage({ options: ["Daily report", ""] }),
    pollMessage({ options: ["Daily report", 7] }),
    pollMessage({ options: ["x".repeat(17 * 1024)] }),
    pollMessage({ id: "" }),
    pollMessage({ id: "x".repeat(257) }),
    { key: valid.key, message: { pollCreationMessage: valid.message.pollCreationMessage } },
    { key: valid.key, message: { pollCreationMessageV5: { message: { conversation: "Fictional text" } },
      messageContextInfo: valid.message.messageContextInfo } },
    { key: valid.key, message: { conversation: "Fictional text", messageContextInfo: valid.message.messageContextInfo } },
    { key: valid.key },
    undefined,
  ];
  for (const message of malformed) assert.equal(store.remember(message, baileys), false);
  assert.deepEqual(decode(vote({ poll: valid })), failure(valid, "unknown_poll"));
});

test("corrupt, oversized or invalid saved data is ignored and errors never contain poll data", async (t) => {
  for (const content of ["not JSON", " ".repeat(2 * 1024 * 1024 + 1)]) {
    const { baileys, decode, errors, file, store, vote } = await fixture(t);
    await fs.writeFile(file, content);
    await store.load(OWNER);
    assert.deepEqual(errors, [[]]);
    const poll = pollMessage();
    store.remember(poll, baileys);
    assert.deepEqual(decode(vote({ poll })), ready(poll, ["Weekly report"]));
  }
  const { decode, errors, file, store, vote } = await fixture(t);
  const poll = pollMessage();
  const record = { secret: crypto.randomBytes(32).toString("base64"), name: "Which report would you like?",
    options: OPTIONS, chat: GROUP, mine: true, creators: [], expires: Date.now() + DAY_MS };
  const { chat, ...withoutChat } = record;
  await fs.writeFile(file, JSON.stringify({ version: 1, owner: OWNER_PN, polls: [
    ["FICTIONALPOLL1", { ...record, secret: "short" }], ["FICTIONALPOLL2", { ...record, options: "Daily report" }],
    ["FICTIONALPOLL3", { ...record, creators: ["not an identity"] }], ["FICTIONALPOLL4", { ...record, expires: "never" }],
    ["FICTIONALPOLL5", { ...record, mine: "yes" }], ["FICTIONALPOLL6", { ...record, expires: 1 }],
    ["FICTIONALPOLL7", { ...record, chat: 7 }], ["FICTIONALPOLL8", withoutChat],
    ["FICTIONALPOLL9", record], [10, record], "FICTIONALPOLL11", null,
  ] }));
  await store.load(OWNER);
  const saved = (index) => pollMessage({ id: `FICTIONALPOLL${index}`, secret: Buffer.from(record.secret, "base64") });
  for (let index = 1; index <= 8; index++) {
    assert.deepEqual(decode(vote({ poll: saved(index) })), failure(saved(index), "unknown_poll"));
  }
  // The one valid entry among them is restored.
  assert.deepEqual(decode(vote({ poll: saved(9) })), ready(saved(9), ["Weekly report"]));
  assert.deepEqual(decode(vote({ poll })), failure(poll, "unknown_poll"));
  assert.deepEqual(errors, []);
});

test("a vote is only accepted in the chat its poll was sent to", async (t) => {
  const { baileys, decode, store, vote } = await fixture(t);
  await store.load(OWNER);
  const inGroup = pollMessage();
  const direct = pollMessage({ id: "FICTIONALPOLL1", key: { remoteJid: VOTER_PN } });
  store.remember(inGroup, baileys);
  store.remember(direct, baileys);
  // A correctly encrypted vote from someone who has the poll, sent elsewhere.
  for (const remoteJid of [VOTER_PN, VOTER_LID, "120363000000000001@g.us", "status@broadcast", undefined]) {
    assert.deepEqual(decode(vote({ poll: inGroup, key: { remoteJid, participant: undefined, senderPn: VOTER_PN } })),
      failure(inGroup, "unknown_poll"));
  }
  assert.deepEqual(decode(vote({ poll: direct })), failure(direct, "unknown_poll"));
  assert.deepEqual(decode(vote({ poll: inGroup })), ready(inGroup, ["Weekly report"]));
  assert.deepEqual(decode(vote({ poll: direct, key: { remoteJid: VOTER_LID, participant: undefined, senderPn: VOTER_PN } })),
    ready(direct, ["Weekly report"]));
});

test("an interrupted or failed write never leaves a copy of the secrets behind", async (t) => {
  const { baileys, create, decode, errors, file, store, vote } = await fixture(t);
  const leftover = `${file}.tmp`;
  // Left by a write that was interrupted before its rename.
  await fs.writeFile(leftover, "Fictional interrupted snapshot");
  await create().load(undefined);
  await assert.rejects(fs.stat(leftover), { code: "ENOENT" });
  await fs.writeFile(leftover, "Fictional interrupted snapshot");
  await store.load(OWNER);
  await assert.rejects(fs.stat(leftover), { code: "ENOENT" });
  assert.deepEqual(errors, []);

  // The snapshot can be written, but not moved into place.
  const poll = pollMessage();
  store.remember(poll, baileys);
  await fs.mkdir(file);
  await store.flush();
  await assert.rejects(fs.stat(leftover), { code: "ENOENT" });
  assert.deepEqual(errors, [[]]);
  assert.deepEqual(decode(vote({ poll })), ready(poll, ["Weekly report"]));
  // The next flush retries the write.
  await fs.rmdir(file);
  await store.flush();
  const restored = create();
  await restored.load(OWNER);
  assert.deepEqual(decode(vote({ poll }), restored), ready(poll, ["Weekly report"]));
});

test("write failure preserves memory and never recreates a removed session directory", async (t) => {
  const { baileys, decode, directory, errors, store, vote } = await fixture(t);
  await store.load(OWNER);
  await fs.rm(directory, { recursive: true, force: true });
  const poll = pollMessage();
  store.remember(poll, baileys);
  await store.flush();
  assert.deepEqual(decode(vote({ poll })), ready(poll, ["Weekly report"]));
  assert.deepEqual(errors, [[]]);
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});
