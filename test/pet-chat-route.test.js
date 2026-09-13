"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { Readable } = require("node:stream");
const { EventEmitter } = require("node:events");

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  ROUTING_NONCE_HEADER,
} = require("../hooks/server-config");
const {
  createPetPeerCapabilityRegistry,
} = require("../src/server-route-pet-peer");
const {
  handlePetChatReadPost,
  handlePetChatClearPost,
  handlePetChatCompletePost,
  validatePetChatReadPayload,
  validatePetChatClearPayload,
  validatePetChatCompletePayload,
  buildSanitizedChatProjection,
  resolvePetChatStore,
  MAX_PET_CHAT_BODY_BYTES,
  MAX_CHAT_RESPONSE_BYTES,
  MAX_ASSISTANT_TEXT_BYTES,
} = require("../src/server-route-pet-chat");
const {
  handlePetInboxPost,
} = require("../src/server-route-pet-inbox");
const initServer = require("../src/server");
const { createIngressRequestHandler } = require("../src/remote-ssh-ingress");

const rootRuntime = require(path.resolve(__dirname, "../../packages/runtime"));
const { createPetChatStore, derivePetId } = rootRuntime;

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function createMockReq({ method = "POST", url = "/pet-chat/read", headers = {}, body = "" } = {}) {
  const payloadBuffer = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  const stream = Readable.from([payloadBuffer]);
  stream.method = method;
  stream.url = url;
  stream.headers = { ...headers };
  return stream;
}

function createMockRes() {
  const result = {
    statusCode: null,
    headers: {},
    body: "",
  };
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(statusCode, headers = {}) {
      result.statusCode = statusCode;
      result.headers = headers;
      res.headersSent = true;
    },
    end(chunk = "") {
      result.body += (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      res.writableEnded = true;
      if (res._resolve) res._resolve(result);
    },
  };
  result.done = new Promise((resolve) => {
    res._resolve = resolve;
  });
  return { res, result };
}

describe("Pet Chat Route & Wiring Tests", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-chat-test-"));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Authentication & Authorization (/pet-chat/complete)", () => {
    test("rejects completion request with missing or malformed capabilityToken", async () => {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-chat/complete",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_complete",
          rawSessionId: "session_auth_1",
          capabilityToken: "not-a-valid-hex-token",
          commandId: "cmd_auth_1",
          assistantText: "hello",
        }),
      });

      handlePetChatCompletePost(req, res, {});
      await result.done;

      assert.equal(result.statusCode, 400);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "rejected");
      assert.match(body.reason, /capabilityToken/i);
    });

    test("rejects unauthenticated completion when capabilityToken is not registered in registry (403)", async () => {
      const registry = createPetPeerCapabilityRegistry();
      const store = createPetChatStore({ dataDir: tempDir });

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-chat/complete",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_complete",
          rawSessionId: "session_auth_2",
          capabilityToken: generateToken(),
          commandId: "cmd_auth_2",
          assistantText: "unauthorized reply",
        }),
      });

      handlePetChatCompletePost(req, res, {
        peerCapabilityRegistry: registry,
        petChatStore: store,
        derivePetId,
      });
      await result.done;

      assert.equal(result.statusCode, 403);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "rejected");
      assert.match(body.reason, /invalid or expired capability token/i);
    });

    test("rejects completion when capabilityToken was registered for different rawSessionId", async () => {
      const registry = createPetPeerCapabilityRegistry();
      const store = createPetChatStore({ dataDir: tempDir });
      const token = generateToken();

      registry.registerCapability({
        profileId: "local",
        agentId: "pi",
        rawSessionId: "session_registered",
        token,
      });

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-chat/complete",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_complete",
          rawSessionId: "session_different",
          capabilityToken: token,
          commandId: "cmd_auth_3",
          assistantText: "cross-session attempt",
        }),
      });

      handlePetChatCompletePost(req, res, {
        peerCapabilityRegistry: registry,
        petChatStore: store,
        derivePetId,
      });
      await result.done;

      assert.equal(result.statusCode, 403);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "rejected");
    });

    test("rejects completion when capabilityToken was revoked", async () => {
      const registry = createPetPeerCapabilityRegistry();
      const store = createPetChatStore({ dataDir: tempDir });
      const token = generateToken();

      registry.registerCapability({
        profileId: "local",
        agentId: "pi",
        rawSessionId: "session_revoked",
        token,
      });
      registry.revokeCapability({
        profileId: "local",
        agentId: "pi",
        rawSessionId: "session_revoked",
        token,
      });

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-chat/complete",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_complete",
          rawSessionId: "session_revoked",
          capabilityToken: token,
          commandId: "cmd_auth_4",
          assistantText: "after revocation",
        }),
      });

      handlePetChatCompletePost(req, res, {
        peerCapabilityRegistry: registry,
        petChatStore: store,
        derivePetId,
      });
      await result.done;

      assert.equal(result.statusCode, 403);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "rejected");
    });

    test("accepts completion with valid registered capabilityToken and derives petId correctly", async () => {
      const registry = createPetPeerCapabilityRegistry();
      const store = createPetChatStore({ dataDir: tempDir });
      const token = generateToken();
      const rawSessionId = "session_valid_complete";

      const callerPetId = derivePetId({
        profileId: "local",
        agentId: "pi",
        rawSessionId,
      });

      // Record a user turn first
      store.recordUserMessage({
        petId: callerPetId,
        commandId: "cmd_valid_1",
        text: "Please respond",
      });

      registry.registerCapability({
        profileId: "local",
        agentId: "pi",
        rawSessionId,
        token,
      });

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-chat/complete",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_complete",
          rawSessionId,
          capabilityToken: token,
          commandId: "cmd_valid_1",
          assistantText: "Here is the response",
        }),
      });

      handlePetChatCompletePost(req, res, {
        peerCapabilityRegistry: registry,
        petChatStore: store,
        derivePetId,
      });
      await result.done;

      assert.equal(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.equal(body.schemaVersion, "1");
      assert.equal(body.kind, "pet_chat_complete");
      assert.equal(body.status, "ok");

      // Verify turn in store was completed
      const chatResult = store.readChat({ petId: callerPetId });
      assert.equal(chatResult.ok, true);
      assert.equal(chatResult.chat.turns.length, 1);
      assert.equal(chatResult.chat.turns[0].assistantText, "Here is the response");
      assert.ok(typeof chatResult.chat.turns[0].completedAtMs === "number");
    });

    test("accepts remote completion when remoteProfile matches capability token", async () => {
      const registry = createPetPeerCapabilityRegistry();
      const store = createPetChatStore({ dataDir: tempDir });
      const token = generateToken();
      const rawSessionId = "session_remote_complete";
      const remoteProfile = { profileId: "remote-worker-node" };

      const callerPetId = derivePetId({
        profileId: "remote-worker-node",
        agentId: "pi",
        rawSessionId,
      });

      store.recordUserMessage({
        petId: callerPetId,
        commandId: "cmd_remote_1",
        text: "Remote user question",
      });

      registry.registerCapability({
        profileId: "remote-worker-node",
        agentId: "pi",
        rawSessionId,
        token,
      });

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-chat/complete",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_complete",
          rawSessionId,
          capabilityToken: token,
          commandId: "cmd_remote_1",
          assistantText: "Remote assistant answer",
        }),
      });

      handlePetChatCompletePost(req, res, {
        remoteProfile,
        peerCapabilityRegistry: registry,
        petChatStore: store,
        derivePetId,
      });
      await result.done;

      assert.equal(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "ok");

      const chatResult = store.readChat({ petId: callerPetId });
      assert.equal(chatResult.ok, true);
      assert.equal(chatResult.chat.turns[0].assistantText, "Remote assistant answer");
    });
  });

  describe("Local-Only Enforcement & Remote Ingress Filtering", () => {
    test("POST /pet-chat/read returns 403 when remoteProfile is non-null", async () => {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-chat/read",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_read",
          petId: "pet_local_123",
        }),
      });

      handlePetChatReadPost(req, res, {
        remoteProfile: { profileId: "remote-host" },
      });
      await result.done;

      assert.equal(result.statusCode, 403);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "rejected");
      assert.match(body.reason, /remote.*not allowed/i);
    });

    test("POST /pet-chat/clear returns 403 when remoteProfile is non-null", async () => {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-chat/clear",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_clear",
          petId: "pet_local_123",
        }),
      });

      handlePetChatClearPost(req, res, {
        remoteProfile: { profileId: "remote-host" },
      });
      await result.done;

      assert.equal(result.statusCode, 403);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "rejected");
      assert.match(body.reason, /remote.*not allowed/i);
    });

    test("Remote SSH ingress rejects POST /pet-chat/read with 404 even with valid routing nonce", () => {
      const validNonce = "a".repeat(32);
      const routed = [];
      const handler = createIngressRequestHandler({
        remoteProfile: { profileId: "remote-worker" },
        getAcceptedNonces: () => [validNonce],
        routeRequest: (req, res) => {
          routed.push(req.url);
          res.writeHead(200);
          res.end("ok");
        },
      });

      const req = {
        method: "POST",
        url: "/pet-chat/read",
        headers: { [ROUTING_NONCE_HEADER]: validNonce },
      };
      const resResult = { statusCode: null, body: "" };
      const res = {
        writeHead(code) { resResult.statusCode = code; },
        end(body) { resResult.body = body; },
      };

      handler(req, res);
      assert.equal(resResult.statusCode, 404);
      assert.equal(routed.length, 0);
    });

    test("Remote SSH ingress rejects POST /pet-chat/clear with 404 even with valid routing nonce", () => {
      const validNonce = "a".repeat(32);
      const routed = [];
      const handler = createIngressRequestHandler({
        remoteProfile: { profileId: "remote-worker" },
        getAcceptedNonces: () => [validNonce],
        routeRequest: (req, res) => {
          routed.push(req.url);
          res.writeHead(200);
          res.end("ok");
        },
      });

      const req = {
        method: "POST",
        url: "/pet-chat/clear",
        headers: { [ROUTING_NONCE_HEADER]: validNonce },
      };
      const resResult = { statusCode: null, body: "" };
      const res = {
        writeHead(code) { resResult.statusCode = code; },
        end(body) { resResult.body = body; },
      };

      handler(req, res);
      assert.equal(resResult.statusCode, 404);
      assert.equal(routed.length, 0);
    });

    test("Remote SSH ingress allows POST /pet-chat/complete with valid routing nonce", () => {
      const validNonce = "b".repeat(32);
      const routed = [];
      let passedProfile = null;
      const handler = createIngressRequestHandler({
        remoteProfile: { profileId: "remote-worker-complete" },
        getAcceptedNonces: () => [validNonce],
        routeRequest: (req, res, profile) => {
          routed.push(req.url);
          passedProfile = profile;
          res.writeHead(200);
          res.end("ok");
        },
      });

      const req = {
        method: "POST",
        url: "/pet-chat/complete",
        headers: { [ROUTING_NONCE_HEADER]: validNonce },
      };
      const resResult = { statusCode: null, body: "" };
      const res = {
        writeHead(code) { resResult.statusCode = code; },
        end(body) { resResult.body = body; },
      };

      handler(req, res);
      assert.equal(resResult.statusCode, 200);
      assert.deepEqual(routed, ["/pet-chat/complete"]);
      assert.equal(passedProfile.profileId, "remote-worker-complete");
    });
  });

  describe("Privacy & Sanitized Human Projection", () => {
    test("buildSanitizedChatProjection flattens turn pairs and strictly omits internal identifiers", () => {
      const chat = {
        schemaVersion: "1",
        petId: "pet_super_secret_id_123",
        revision: 4,
        updatedAtMs: 1757420000000,
        turns: [
          {
            commandId: "cmd_secret_1",
            userText: "What is the weather?",
            assistantText: "It is sunny.",
            createdAtMs: 1757419000000,
            completedAtMs: 1757419001000,
          },
          {
            commandId: "cmd_secret_2",
            userText: "Thank you!",
            assistantText: "You are welcome!",
            createdAtMs: 1757419100000,
            completedAtMs: 1757419101000,
          },
        ],
      };

      const projection = buildSanitizedChatProjection(chat);

      assert.equal(projection.revision, 4);
      assert.equal(projection.pending, false);
      assert.equal(projection.messages.length, 4);

      assert.deepEqual(projection.messages[0], {
        role: "user",
        text: "What is the weather?",
        createdAtMs: 1757419000000,
      });
      assert.deepEqual(projection.messages[1], {
        role: "assistant",
        text: "It is sunny.",
        createdAtMs: 1757419001000,
      });
      assert.deepEqual(projection.messages[2], {
        role: "user",
        text: "Thank you!",
        createdAtMs: 1757419100000,
      });
      assert.deepEqual(projection.messages[3], {
        role: "assistant",
        text: "You are welcome!",
        createdAtMs: 1757419101000,
      });

      // Verify privacy: absolutely no commandId, petId, token, path, or rawSessionId
      const serialized = JSON.stringify(projection);
      assert.equal(serialized.includes("cmd_secret_1"), false);
      assert.equal(serialized.includes("cmd_secret_2"), false);
      assert.equal(serialized.includes("pet_super_secret_id_123"), false);
      assert.equal(serialized.includes("commandId"), false);
      assert.equal(serialized.includes("petId"), false);
      assert.equal(serialized.includes("token"), false);
      assert.equal(serialized.includes("rawSessionId"), false);
    });

    test("buildSanitizedChatProjection sets pending:true and omits assistant message when assistantText is null", () => {
      const chat = {
        schemaVersion: "1",
        petId: "pet_in_flight",
        revision: 1,
        turns: [
          {
            commandId: "cmd_in_flight",
            userText: "Pending question?",
            assistantText: null,
            createdAtMs: 1757419000000,
            completedAtMs: null,
          },
        ],
      };

      const projection = buildSanitizedChatProjection(chat);
      assert.equal(projection.revision, 1);
      assert.equal(projection.pending, true);
      assert.equal(projection.messages.length, 1);
      assert.deepEqual(projection.messages[0], {
        role: "user",
        text: "Pending question?",
        createdAtMs: 1757419000000,
      });
    });

    test("POST /pet-chat/read returns sanitized projection envelope <= 64KiB", async () => {
      const store = createPetChatStore({ dataDir: tempDir });
      const petId = "pet_projection_test";

      store.recordUserMessage({
        petId,
        commandId: "cmd_proj_1",
        text: "Hello pet",
        createdAtMs: 1000,
      });
      store.completeTurn({
        petId,
        commandId: "cmd_proj_1",
        assistantText: "Hello human",
        completedAtMs: 1500,
      });
      store.recordUserMessage({
        petId,
        commandId: "cmd_proj_2",
        text: "Next pending question",
        createdAtMs: 2000,
      });

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-chat/read",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_read",
          petId,
        }),
      });

      handlePetChatReadPost(req, res, { petChatStore: store });
      await result.done;

      assert.equal(result.statusCode, 200);
      assert.equal(result.headers["Content-Type"], "application/json; charset=utf-8");
      assert.equal(result.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);

      const parsed = JSON.parse(result.body);
      assert.equal(parsed.schemaVersion, "1");
      assert.equal(parsed.kind, "pet_chat_read");
      assert.equal(parsed.status, "ok");

      assert.equal(parsed.chat.revision, 3);
      assert.equal(parsed.chat.pending, true);
      assert.equal(parsed.chat.messages.length, 3);
      assert.deepEqual(parsed.chat.messages[0], { role: "user", text: "Hello pet", createdAtMs: 1000 });
      assert.deepEqual(parsed.chat.messages[1], { role: "assistant", text: "Hello human", createdAtMs: 1500 });
      assert.deepEqual(parsed.chat.messages[2], { role: "user", text: "Next pending question", createdAtMs: 2000 });

      // Privacy check
      assert.equal(result.body.includes("cmd_proj_1"), false);
      assert.equal(result.body.includes("cmd_proj_2"), false);
      assert.equal(result.body.includes("pet_projection_test"), false);
      assert.ok(Buffer.byteLength(result.body, "utf8") <= MAX_CHAT_RESPONSE_BYTES);
    });

    test("POST /pet-chat/clear returns empty projection envelope", async () => {
      const store = createPetChatStore({ dataDir: tempDir });
      const petId = "pet_clear_test";

      store.recordUserMessage({ petId, commandId: "cmd_c1", text: "Turn to clear" });

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-chat/clear",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_clear",
          petId,
        }),
      });

      handlePetChatClearPost(req, res, { petChatStore: store });
      await result.done;

      assert.equal(result.statusCode, 200);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.schemaVersion, "1");
      assert.equal(parsed.kind, "pet_chat_clear");
      assert.equal(parsed.status, "ok");
      assert.deepEqual(parsed.chat, {
        revision: 0,
        messages: [],
        pending: false,
      });

      // Verify chat was cleared in store
      const readResult = store.readChat({ petId });
      assert.equal(readResult.ok, true);
      assert.equal(readResult.chat.turns.length, 0);
    });
  });

  describe("Dedup & Best-Effort Record Hook in /pet-inbox", () => {
    test("accepted queued inbox message records user turn in petChatStore", async () => {
      const store = createPetChatStore({ dataDir: tempDir });
      const petId = "pet_inbox_record";
      const commandId = "cmd_inbox_101";

      const stubReceipt = {
        schemaVersion: "1",
        commandId,
        petId,
        status: "queued",
        createdAtMs: 1757421000000,
      };

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-inbox",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "user_message",
          petId,
          text: "Message from inbox",
          commandId,
        }),
      });

      handlePetInboxPost(req, res, {
        petChatStore: store,
        enqueueUserMessage: () => stubReceipt,
      });
      await result.done;

      assert.equal(result.statusCode, 202);

      // Verify turn was recorded in chat store
      const chatResult = store.readChat({ petId });
      assert.equal(chatResult.ok, true);
      assert.equal(chatResult.chat.turns.length, 1);
      assert.equal(chatResult.chat.turns[0].commandId, commandId);
      assert.equal(chatResult.chat.turns[0].userText, "Message from inbox");
      assert.equal(chatResult.chat.turns[0].assistantText, null);
    });

    test("inbox dedup: multiple identical messages record idempotently without duplicate turns", async () => {
      const store = createPetChatStore({ dataDir: tempDir });
      const petId = "pet_inbox_dedup";
      const commandId = "cmd_dedup_102";

      const stubReceipt = {
        schemaVersion: "1",
        commandId,
        petId,
        status: "queued",
      };

      for (let i = 0; i < 3; i++) {
        const { res, result } = createMockRes();
        const req = createMockReq({
          url: "/pet-inbox",
          body: JSON.stringify({
            schemaVersion: "1",
            kind: "user_message",
            petId,
            text: "Same content",
            commandId,
          }),
        });

        handlePetInboxPost(req, res, {
          petChatStore: store,
          enqueueUserMessage: () => stubReceipt,
        });
        await result.done;
        assert.equal(result.statusCode, 202);
      }

      const chatResult = store.readChat({ petId });
      assert.equal(chatResult.ok, true);
      assert.equal(chatResult.chat.turns.length, 1);
    });

    test("best-effort chat recording: store failure or exception never alters inbox delivery outcome", async () => {
      const brokenStore = {
        recordUserMessage() {
          throw new Error("Disk corruption or database locked");
        },
      };

      const stubReceipt = {
        schemaVersion: "1",
        commandId: "cmd_fail_safe",
        petId: "pet_fail_safe",
        status: "queued",
      };

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-inbox",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "user_message",
          petId: "pet_fail_safe",
          text: "Delivery must not fail",
          commandId: "cmd_fail_safe",
        }),
      });

      handlePetInboxPost(req, res, {
        petChatStore: brokenStore,
        enqueueUserMessage: () => stubReceipt,
      });
      await result.done;

      // Delivery response MUST remain 202 accepted
      assert.equal(result.statusCode, 202);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "queued");
    });
  });

  describe("Corrupt Store, Turn Conflicts & Failure Handling", () => {
    test("POST /pet-chat/read returns 500 when persisted chat file is corrupt", async () => {
      const petId = "pet_corrupt_read";
      const chatDir = path.join(tempDir, "chat");
      fs.mkdirSync(chatDir, { recursive: true });
      fs.writeFileSync(path.join(chatDir, `chat-${petId}.json`), "{ corrupt json", "utf8");

      const store = createPetChatStore({ dataDir: tempDir });

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-chat/read",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_read",
          petId,
        }),
      });

      handlePetChatReadPost(req, res, { petChatStore: store });
      await result.done;

      assert.equal(result.statusCode, 500);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "failed");
      assert.match(body.reason, /failed to read chat file|corrupt/i);
    });

    test("POST /pet-chat/complete returns 404 when commandId turn is not found", async () => {
      const registry = createPetPeerCapabilityRegistry();
      const store = createPetChatStore({ dataDir: tempDir });
      const token = generateToken();
      const rawSessionId = "session_not_found";

      const callerPetId = derivePetId({
        profileId: "local",
        agentId: "pi",
        rawSessionId,
      });
      // Create empty chat
      store.recordUserMessage({ petId: callerPetId, commandId: "cmd_existing", text: "Other turn" });

      registry.registerCapability({
        profileId: "local",
        agentId: "pi",
        rawSessionId,
        token,
      });

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-chat/complete",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_complete",
          rawSessionId,
          capabilityToken: token,
          commandId: "cmd_non_existent",
          assistantText: "Answer to nothing",
        }),
      });

      handlePetChatCompletePost(req, res, {
        peerCapabilityRegistry: registry,
        petChatStore: store,
        derivePetId,
      });
      await result.done;

      assert.equal(result.statusCode, 404);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "rejected");
      assert.match(body.reason, /not found/i);
    });

    test("POST /pet-chat/complete returns 409 when completing already completed turn with different text", async () => {
      const registry = createPetPeerCapabilityRegistry();
      const store = createPetChatStore({ dataDir: tempDir });
      const token = generateToken();
      const rawSessionId = "session_conflict";

      const callerPetId = derivePetId({
        profileId: "local",
        agentId: "pi",
        rawSessionId,
      });

      store.recordUserMessage({ petId: callerPetId, commandId: "cmd_conf_1", text: "Question" });
      store.completeTurn({ petId: callerPetId, commandId: "cmd_conf_1", assistantText: "Original reply" });

      registry.registerCapability({
        profileId: "local",
        agentId: "pi",
        rawSessionId,
        token,
      });

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-chat/complete",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_complete",
          rawSessionId,
          capabilityToken: token,
          commandId: "cmd_conf_1",
          assistantText: "Conflicting reply",
        }),
      });

      handlePetChatCompletePost(req, res, {
        peerCapabilityRegistry: registry,
        petChatStore: store,
        derivePetId,
      });
      await result.done;

      assert.equal(result.statusCode, 409);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "rejected");
      assert.match(body.reason, /conflict|already completed/i);
    });

    test("POST /pet-chat/read returns 503 when pet chat store is unavailable", async () => {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-chat/read",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_read",
          petId: "pet_no_store",
        }),
      });

      handlePetChatReadPost(req, res, {
        env: {}, // No runtime configured
      });
      await result.done;

      assert.equal(result.statusCode, 503);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "failed");
    });
  });

  describe("Exact Payloads & Strict Controls Validation", () => {
    test("POST /pet-chat/complete accepts assistant text up to 8192 UTF-8 bytes and rejects 8193 bytes", async () => {
      const registry = createPetPeerCapabilityRegistry();
      const store = createPetChatStore({ dataDir: tempDir });
      const token = generateToken();
      const rawSessionId = "session_size_test";

      const callerPetId = derivePetId({
        profileId: "local",
        agentId: "pi",
        rawSessionId,
      });
      store.recordUserMessage({ petId: callerPetId, commandId: "cmd_size_1", text: "Size query" });

      registry.registerCapability({
        profileId: "local",
        agentId: "pi",
        rawSessionId,
        token,
      });

      // 8193 bytes
      const oversizedText = "x".repeat(MAX_ASSISTANT_TEXT_BYTES + 1);
      const { res: resOversized, result: resultOversized } = createMockRes();
      const reqOversized = createMockReq({
        url: "/pet-chat/complete",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_complete",
          rawSessionId,
          capabilityToken: token,
          commandId: "cmd_size_1",
          assistantText: oversizedText,
        }),
      });

      handlePetChatCompletePost(reqOversized, resOversized, {
        peerCapabilityRegistry: registry,
        petChatStore: store,
        derivePetId,
      });
      await resultOversized.done;
      assert.equal(resultOversized.statusCode, 400);
      assert.match(JSON.parse(resultOversized.body).reason, /exceeds maximum byte size/i);

      // Exactly 8192 bytes
      const exactText = "y".repeat(MAX_ASSISTANT_TEXT_BYTES);
      const { res: resExact, result: resultExact } = createMockRes();
      const reqExact = createMockReq({
        url: "/pet-chat/complete",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_complete",
          rawSessionId,
          capabilityToken: token,
          commandId: "cmd_size_1",
          assistantText: exactText,
        }),
      });

      handlePetChatCompletePost(reqExact, resExact, {
        peerCapabilityRegistry: registry,
        petChatStore: store,
        derivePetId,
      });
      await resultExact.done;
      assert.equal(resultExact.statusCode, 200);
    });

    test("POST /pet-chat/complete strictly rejects disallowed control characters in assistantText", async () => {
      const disallowedChars = ["\u0000", "\u0007", "\u001b", "\u0008", "\u007f", "\u009f"];

      for (const char of disallowedChars) {
        const { res, result } = createMockRes();
        const req = createMockReq({
          url: "/pet-chat/complete",
          body: JSON.stringify({
            schemaVersion: "1",
            kind: "pet_chat_complete",
            rawSessionId: "session_ctrl",
            capabilityToken: generateToken(),
            commandId: "cmd_ctrl",
            assistantText: `Disallowed ${char} control`,
          }),
        });

        handlePetChatCompletePost(req, res, {});
        await result.done;

        assert.equal(result.statusCode, 400);
        assert.match(JSON.parse(result.body).reason, /control characters/i);
      }
    });

    test("POST /pet-chat/read, clear, and complete reject unknown properties", async () => {
      // Read with unknown property
      {
        const { res, result } = createMockRes();
        const req = createMockReq({
          url: "/pet-chat/read",
          body: JSON.stringify({
            schemaVersion: "1",
            kind: "pet_chat_read",
            petId: "pet_test",
            extraField: "forbidden",
          }),
        });
        handlePetChatReadPost(req, res, {});
        await result.done;
        assert.equal(result.statusCode, 400);
        assert.match(JSON.parse(result.body).reason, /Unknown property: "extraField"/);
      }

      // Clear with unknown property
      {
        const { res, result } = createMockRes();
        const req = createMockReq({
          url: "/pet-chat/clear",
          body: JSON.stringify({
            schemaVersion: "1",
            kind: "pet_chat_clear",
            petId: "pet_test",
            extraField: "forbidden",
          }),
        });
        handlePetChatClearPost(req, res, {});
        await result.done;
        assert.equal(result.statusCode, 400);
        assert.match(JSON.parse(result.body).reason, /Unknown property: "extraField"/);
      }

      // Complete with unknown property
      {
        const { res, result } = createMockRes();
        const req = createMockReq({
          url: "/pet-chat/complete",
          body: JSON.stringify({
            schemaVersion: "1",
            kind: "pet_chat_complete",
            rawSessionId: "sess_1",
            capabilityToken: generateToken(),
            commandId: "cmd_1",
            assistantText: "test",
            extraField: "forbidden",
          }),
        });
        handlePetChatCompletePost(req, res, {});
        await result.done;
        assert.equal(result.statusCode, 400);
        assert.match(JSON.parse(result.body).reason, /Unknown property: "extraField"/);
      }
    });

    test("POST /pet-chat/read rejects oversized body (>16 KiB)", async () => {
      const oversizedPetId = "p".repeat(MAX_PET_CHAT_BODY_BYTES + 100);
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-chat/read",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "pet_chat_read",
          petId: oversizedPetId,
        }),
      });

      handlePetChatReadPost(req, res, {});
      await result.done;
      assert.equal(result.statusCode, 413);
    });

    test("POST /pet-chat/read rejects malformed JSON with 400", async () => {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-chat/read",
        body: "{ bad json",
      });

      handlePetChatReadPost(req, res, {});
      await result.done;
      assert.equal(result.statusCode, 400);
    });
  });

  describe("End-to-End Server Routing Wiring", () => {
    test("server routing dispatches /pet-chat/read, /pet-chat/complete, /pet-chat/clear through initServer", async () => {
      let capturedHandler = null;

      function fakeCreateHttpServer(handler) {
        capturedHandler = handler;
        const server = new EventEmitter();
        server.listen = function () { this.emit("listening"); };
        server.close = function () {};
        return server;
      }

      const store = createPetChatStore({ dataDir: tempDir });
      const rawSessionId = "session_e2e_server";
      const token = generateToken();

      const server = initServer({
        createHttpServer: fakeCreateHttpServer,
        setImmediate: () => {},
        getPortCandidates: () => [23334],
        readRuntimePort: () => 23334,
        clearRuntimeConfig: () => true,
        writeRuntimeConfig: () => true,
        isAgentEnabled: () => true,
        petChatStore: store,
        derivePetId,
        dataDir: tempDir,
        enqueueUserMessage: (args) => ({
          schemaVersion: "1",
          commandId: args.commandId || "cmd_e2e_turn_1",
          petId: args.petId,
          status: "queued",
        }),
      });

      server.startHttpServer();
      assert.ok(capturedHandler, "HTTP request handler should be registered");

      // Register capability on the server's petPeerCapabilityRegistry
      server.petPeerCapabilityRegistry.registerCapability({
        profileId: "local",
        agentId: "pi",
        rawSessionId,
        token,
      });

      const callerPetId = derivePetId({
        profileId: "local",
        agentId: "pi",
        rawSessionId,
      });

      // 1. Send user message via /pet-inbox
      {
        const { res, result } = createMockRes();
        const req = createMockReq({
          method: "POST",
          url: "/pet-inbox",
          body: JSON.stringify({
            schemaVersion: "1",
            kind: "user_message",
            petId: callerPetId,
            text: "Hello from E2E test",
            commandId: "cmd_e2e_turn_1",
          }),
        });

        capturedHandler(req, res);
        await result.done;
        assert.equal(result.statusCode, 202);
      }

      // 2. Read chat via /pet-chat/read -> should be pending: true
      {
        const { res, result } = createMockRes();
        const req = createMockReq({
          method: "POST",
          url: "/pet-chat/read",
          body: JSON.stringify({
            schemaVersion: "1",
            kind: "pet_chat_read",
            petId: callerPetId,
          }),
        });

        capturedHandler(req, res);
        await result.done;
        assert.equal(result.statusCode, 200);
        const parsed = JSON.parse(result.body);
        assert.equal(parsed.status, "ok");
        assert.equal(parsed.chat.pending, true);
        assert.equal(parsed.chat.messages.length, 1);
        assert.deepEqual(parsed.chat.messages[0].role, "user");
        assert.deepEqual(parsed.chat.messages[0].text, "Hello from E2E test");
      }

      // 3. Complete turn via /pet-chat/complete
      {
        const { res, result } = createMockRes();
        const req = createMockReq({
          method: "POST",
          url: "/pet-chat/complete",
          body: JSON.stringify({
            schemaVersion: "1",
            kind: "pet_chat_complete",
            rawSessionId,
            capabilityToken: token,
            commandId: "cmd_e2e_turn_1",
            assistantText: "E2E assistant reply",
          }),
        });

        capturedHandler(req, res);
        await result.done;
        assert.equal(result.statusCode, 200);
        const parsed = JSON.parse(result.body);
        assert.equal(parsed.status, "ok");
      }

      // 4. Read chat again -> should be pending: false, 2 messages
      {
        const { res, result } = createMockRes();
        const req = createMockReq({
          method: "POST",
          url: "/pet-chat/read",
          body: JSON.stringify({
            schemaVersion: "1",
            kind: "pet_chat_read",
            petId: callerPetId,
          }),
        });

        capturedHandler(req, res);
        await result.done;
        assert.equal(result.statusCode, 200);
        const parsed = JSON.parse(result.body);
        assert.equal(parsed.status, "ok");
        assert.equal(parsed.chat.pending, false);
        assert.equal(parsed.chat.messages.length, 2);
        assert.equal(parsed.chat.messages[0].role, "user");
        assert.equal(parsed.chat.messages[1].role, "assistant");
        assert.equal(parsed.chat.messages[1].text, "E2E assistant reply");
      }

      // 5. Clear chat via /pet-chat/clear
      {
        const { res, result } = createMockRes();
        const req = createMockReq({
          method: "POST",
          url: "/pet-chat/clear",
          body: JSON.stringify({
            schemaVersion: "1",
            kind: "pet_chat_clear",
            petId: callerPetId,
          }),
        });

        capturedHandler(req, res);
        await result.done;
        assert.equal(result.statusCode, 200);
        const parsed = JSON.parse(result.body);
        assert.equal(parsed.status, "ok");
        assert.deepEqual(parsed.chat.messages, []);
      }

      server.cleanup();
    });
  });
});
