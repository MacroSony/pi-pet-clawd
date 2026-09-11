"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");
const {
  ROUTING_NONCE_HEADER,
  createIngressRequestHandler,
} = require("../src/remote-ssh-ingress");
const initServer = require("../src/server");
const {
  handlePetInboxPost,
  MAX_PET_INBOX_BODY_BYTES,
  validatePetInboxPayload,
} = require("../src/server-route-pet-inbox");

function resolveRootRuntimeModule() {
  const candidates = [
    path.resolve(__dirname, "../../packages/runtime/index.js"),
    path.resolve(__dirname, "../../../packages/runtime/index.js"),
    path.resolve(process.cwd(), "packages/runtime/index.js"),
    path.resolve(process.cwd(), "../packages/runtime/index.js"),
    path.resolve(__dirname, "../../packages/runtime"),
    path.resolve(__dirname, "../../../packages/runtime"),
    path.resolve(process.cwd(), "packages/runtime"),
    path.resolve(process.cwd(), "../packages/runtime"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        const indexPath = path.join(candidate, "index.js");
        if (fs.existsSync(indexPath)) return indexPath;
      } else if (stat.isFile()) {
        return candidate;
      }
    }
  }
  return null;
}

function createMockReq({ method = "POST", url = "/pet-inbox", headers = {}, body = "" } = {}) {
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
    writeHead(statusCode, headers = {}) {
      result.statusCode = statusCode;
      result.headers = headers;
    },
    end(chunk = "") {
      result.body += (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      if (res._resolve) res._resolve(result);
    },
  };
  result.done = new Promise((resolve) => {
    res._resolve = resolve;
  });
  return { res, result };
}

function dispatchSync(handler, { method = "POST", path: reqPath = "/pet-inbox", headers = {}, body = "" } = {}) {
  const req = {
    method,
    url: reqPath,
    headers: { ...headers },
  };
  const result = { statusCode: null, headers: {}, body: "" };
  const res = {
    writeHead(statusCode, resHeaders = {}) {
      result.statusCode = statusCode;
      result.headers = resHeaders;
    },
    end(resBody = "") {
      result.body = (typeof resBody === "string" ? resBody : resBody.toString("utf8"));
    },
  };
  handler(req, res);
  return result;
}

test("remote ingress rejects POST /pet-inbox even with valid nonce (fail closed)", () => {
  const routed = [];
  const validNonce = "a".repeat(32);
  const handler = createIngressRequestHandler({
    remoteProfile: { profileId: "remote-profile-1" },
    getAcceptedNonces: () => [validNonce],
    routeRequest: (req, res) => {
      routed.push(req.url);
      res.writeHead(200);
      res.end("ok");
    },
  });

  // Valid nonce header must still be rejected (not in ingress whitelist)
  const validNonceRes = dispatchSync(handler, {
    method: "POST",
    path: "/pet-inbox",
    headers: { [ROUTING_NONCE_HEADER]: validNonce },
  });
  assert.equal(validNonceRes.statusCode, 404);
  assert.equal(validNonceRes.body, "not found");

  // Missing nonce header
  const noNonceRes = dispatchSync(handler, {
    method: "POST",
    path: "/pet-inbox",
  });
  assert.equal(noNonceRes.statusCode, 404);
  assert.equal(noNonceRes.body, "not found");

  // Wrong nonce header
  const wrongNonceRes = dispatchSync(handler, {
    method: "POST",
    path: "/pet-inbox",
    headers: { [ROUTING_NONCE_HEADER]: "b".repeat(32) },
  });
  assert.equal(wrongNonceRes.statusCode, 404);
  assert.equal(wrongNonceRes.body, "not found");

  // Query / path nonce attempts
  const queryNonceRes = dispatchSync(handler, {
    method: "POST",
    path: `/pet-inbox?nonce=${validNonce}`,
    headers: {},
  });
  assert.equal(queryNonceRes.statusCode, 404);

  const pathNonceRes = dispatchSync(handler, {
    method: "POST",
    path: `/pet-inbox/${validNonce}`,
    headers: {},
  });
  assert.equal(pathNonceRes.statusCode, 404);

  assert.deepEqual(routed, []);
});

test("route rejects and fails closed when remoteProfile is non-null", async () => {
  let called = false;
  const { res, result } = createMockRes();
  const req = createMockReq({
    body: JSON.stringify({
      schemaVersion: "1",
      kind: "user_message",
      petId: "pet_123",
      text: "hello",
    }),
  });

  handlePetInboxPost(req, res, {
    remoteProfile: { profileId: "remote-worker" },
    enqueueUserMessage: () => {
      called = true;
      return { status: "queued" };
    },
  });

  await result.done;
  assert.equal(result.statusCode, 403);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.status, "rejected");
  assert.match(parsed.reason, /remote/i);
  assert.equal(called, false);
});

test("rejects malformed JSON with 400", async () => {
  const { res, result } = createMockRes();
  const req = createMockReq({ body: "{invalid json" });

  handlePetInboxPost(req, res, {
    enqueueUserMessage: () => {
      throw new Error("should not be called");
    },
  });

  await result.done;
  assert.equal(result.statusCode, 400);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.status, "rejected");
  assert.match(parsed.reason, /bad json/i);
});

test("rejects invalid schema fields with 400", async () => {
  const testCases = [
    {
      name: "non-object payload",
      payload: '"just a string"',
      reasonMatch: /payload must be an object/i,
    },
    {
      name: "array payload",
      payload: JSON.stringify([{ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi" }]),
      reasonMatch: /payload must be an object/i,
    },
    {
      name: "missing schemaVersion",
      payload: JSON.stringify({ kind: "user_message", petId: "p1", text: "hi" }),
      reasonMatch: /schemaVersion/i,
    },
    {
      name: "invalid schemaVersion",
      payload: JSON.stringify({ schemaVersion: "2", kind: "user_message", petId: "p1", text: "hi" }),
      reasonMatch: /schemaVersion/i,
    },
    {
      name: "missing kind",
      payload: JSON.stringify({ schemaVersion: "1", petId: "p1", text: "hi" }),
      reasonMatch: /kind/i,
    },
    {
      name: "invalid kind",
      payload: JSON.stringify({ schemaVersion: "1", kind: "peer_message", petId: "p1", text: "hi" }),
      reasonMatch: /kind/i,
    },
    {
      name: "missing petId",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", text: "hi" }),
      reasonMatch: /petId/i,
    },
    {
      name: "empty petId",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "", text: "hi" }),
      reasonMatch: /petId/i,
    },
    {
      name: "oversized petId (>128)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "x".repeat(129), text: "hi" }),
      reasonMatch: /petId/i,
    },
    {
      name: "path traversal petId",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "../etc/passwd", text: "hi" }),
      reasonMatch: /petId/i,
    },
    {
      name: "invalid characters in petId",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "pet/123!", text: "hi" }),
      reasonMatch: /petId/i,
    },
    {
      name: "missing text",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1" }),
      reasonMatch: /text/i,
    },
    {
      name: "empty text",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "" }),
      reasonMatch: /text/i,
    },
    {
      name: "oversized text (>2000)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "t".repeat(2001) }),
      reasonMatch: /text/i,
    },
    {
      name: "invalid deliverAs (not followUp)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", deliverAs: "instant" }),
      reasonMatch: /deliverAs/i,
    },
    {
      name: "invalid deliverAs type (number)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", deliverAs: 123 }),
      reasonMatch: /deliverAs/i,
    },
    {
      name: "oversized commandId (>64)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", commandId: "c".repeat(65) }),
      reasonMatch: /commandId/i,
    },
    {
      name: "empty commandId",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", commandId: "" }),
      reasonMatch: /commandId/i,
    },
    {
      name: "invalid characters in commandId (slash)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", commandId: "cmd/123" }),
      reasonMatch: /commandId/i,
    },
    {
      name: "invalid characters in commandId (space)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", commandId: "cmd 123" }),
      reasonMatch: /commandId/i,
    },
    {
      name: "invalid characters in commandId (special symbol)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", commandId: "cmd$123!" }),
      reasonMatch: /commandId/i,
    },
    {
      name: "oversized dedupKey (>64)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", dedupKey: "k".repeat(65) }),
      reasonMatch: /dedupKey/i,
    },
    {
      name: "empty dedupKey",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", dedupKey: "" }),
      reasonMatch: /dedupKey/i,
    },
    {
      name: "invalid characters in dedupKey (slash)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", dedupKey: "key/123" }),
      reasonMatch: /dedupKey/i,
    },
    {
      name: "invalid characters in dedupKey (space)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", dedupKey: "key 123" }),
      reasonMatch: /dedupKey/i,
    },
    {
      name: "invalid characters in dedupKey (special symbol)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", dedupKey: "key$123!" }),
      reasonMatch: /dedupKey/i,
    },
    {
      name: "ttlMs too low (<1000)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", ttlMs: 999 }),
      reasonMatch: /ttlMs/i,
    },
    {
      name: "ttlMs too high (>300000)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", ttlMs: 300001 }),
      reasonMatch: /ttlMs/i,
    },
    {
      name: "ttlMs non-integer",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", ttlMs: 5000.5 }),
      reasonMatch: /ttlMs/i,
    },
    {
      name: "createdAtMs rejected as unknown",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", createdAtMs: 1757419200000 }),
      reasonMatch: /unknown property: "createdAtMs"/i,
    },
    {
      name: "unknown property",
      payload: JSON.stringify({ schemaVersion: "1", kind: "user_message", petId: "p1", text: "hi", extra: "forbidden" }),
      reasonMatch: /unknown/i,
    },
  ];

  for (const tc of testCases) {
    const { res, result } = createMockRes();
    const req = createMockReq({ body: tc.payload });

    handlePetInboxPost(req, res, {
      enqueueUserMessage: () => {
        throw new Error("should not be called");
      },
    });

    await result.done;
    assert.equal(result.statusCode, 400, `Expected 400 for ${tc.name}`);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "rejected", `Expected status: rejected for ${tc.name}`);
    assert.match(parsed.reason, tc.reasonMatch, `Expected reason matching ${tc.reasonMatch} for ${tc.name}`);
  }
});

test("createdAtMs is rejected as unknown property (coordinator/runtime owns timestamp)", async () => {
  const { res, result } = createMockRes();
  const req = createMockReq({
    body: JSON.stringify({
      schemaVersion: "1",
      kind: "user_message",
      petId: "pet_123",
      text: "hello",
      createdAtMs: Date.now(),
    }),
  });

  handlePetInboxPost(req, res, {
    enqueueUserMessage: () => {
      throw new Error("should not be called");
    },
  });

  await result.done;
  assert.equal(result.statusCode, 400);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.status, "rejected");
  assert.equal(parsed.reason, 'Unknown property: "createdAtMs"');
});

test("queued path returns 202 with receipt JSON and correctly forwards options with deliverAs followUp", async () => {
  const capturedArgs = [];
  const stubReceipt = {
    schemaVersion: "1",
    commandId: "cmd_msg_1",
    dedupKey: "dedup_msg_1",
    petId: "pet_alpha",
    status: "queued",
    reason: null,
    createdAtMs: 1757419200000,
    updatedAtMs: 1757419200100,
  };

  const { res, result } = createMockRes();
  const req = createMockReq({
    body: JSON.stringify({
      schemaVersion: "1",
      kind: "user_message",
      petId: "pet_alpha",
      text: "Please review the new commit",
      deliverAs: "followUp",
      commandId: "cmd_msg_1",
      dedupKey: "dedup_msg_1",
      ttlMs: 60000,
    }),
  });

  handlePetInboxPost(req, res, {
    dataDir: "/tmp/custom-data-dir",
    enqueueUserMessage: (args) => {
      capturedArgs.push(args);
      return stubReceipt;
    },
  });

  await result.done;
  assert.equal(result.statusCode, 202);
  assert.equal(result.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(result.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
  const parsed = JSON.parse(result.body);
  assert.deepEqual(parsed, stubReceipt);

  assert.equal(capturedArgs.length, 1);
  assert.deepEqual(capturedArgs[0], {
    petId: "pet_alpha",
    text: "Please review the new commit",
    deliverAs: "followUp",
    commandId: "cmd_msg_1",
    dedupKey: "dedup_msg_1",
    ttlMs: 60000,
    dataDir: "/tmp/custom-data-dir",
    env: process.env,
  });
  assert.equal(capturedArgs[0].createdAtMs, undefined, "createdAtMs must not be passed from request payload");
  assert.equal(capturedArgs[0].followUp, undefined, "followUp boolean must not be passed");
});

test("canonical deliverAs:'followUp' is passed when deliverAs omitted and queued receipt returns 202", async () => {
  const capturedArgs = [];
  const stubReceipt = {
    schemaVersion: "1",
    commandId: "cmd_canonical_deliver",
    petId: "pet_beta",
    status: "queued",
    reason: null,
  };

  const { res, result } = createMockRes();
  const req = createMockReq({
    body: JSON.stringify({
      schemaVersion: "1",
      kind: "user_message",
      petId: "pet_beta",
      text: "Default deliverAs text",
    }),
  });

  handlePetInboxPost(req, res, {
    enqueueUserMessage: (args) => {
      capturedArgs.push(args);
      return stubReceipt;
    },
  });

  await result.done;
  assert.equal(result.statusCode, 202);
  const parsed = JSON.parse(result.body);
  assert.deepEqual(parsed, stubReceipt);

  assert.equal(capturedArgs.length, 1);
  assert.equal(capturedArgs[0].petId, "pet_beta");
  assert.equal(capturedArgs[0].text, "Default deliverAs text");
  assert.equal(capturedArgs[0].deliverAs, "followUp");
  assert.equal(capturedArgs[0].followUp, undefined, "followUp boolean must not be passed");
});

test("does not accept legacy/imaginary status aliases (returns 500 unexpected status)", async () => {
  const legacyStatuses = ["enqueued", "duplicate_queued", "duplicate", "duplicate_enqueued"];
  for (const legacyStatus of legacyStatuses) {
    const legacyReceipt = {
      schemaVersion: "1",
      commandId: "cmd_legacy",
      petId: "pet_xyz",
      status: legacyStatus,
      reason: null,
    };

    const { res, result } = createMockRes();
    const req = createMockReq({
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        petId: "pet_xyz",
        text: "Legacy alias test",
      }),
    });

    handlePetInboxPost(req, res, {
      enqueueUserMessage: () => legacyReceipt,
    });

    await result.done;
    assert.equal(result.statusCode, 500, `Expected 500 for legacy status ${legacyStatus}`);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, legacyStatus);
  }
});

test("returns 200 when enqueueUserMessage returns dispatched receipt", async () => {
  const dispatchedReceipt = {
    schemaVersion: "1",
    commandId: "cmd_disp",
    petId: "pet_xyz",
    status: "dispatched",
    reason: null,
  };

  const { res, result } = createMockRes();
  const req = createMockReq({
    body: JSON.stringify({
      schemaVersion: "1",
      kind: "user_message",
      petId: "pet_xyz",
      text: "Immediate message",
    }),
  });

  handlePetInboxPost(req, res, {
    enqueueUserMessage: () => dispatchedReceipt,
  });

  await result.done;
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), dispatchedReceipt);
});

test("does not accept or map delivered status for user inbox (returns 500 unprovable receipt status)", async () => {
  const deliveredReceipt = {
    schemaVersion: "1",
    commandId: "cmd_deliv",
    petId: "pet_xyz",
    status: "delivered",
    reason: null,
  };

  const { res, result } = createMockRes();
  const req = createMockReq({
    body: JSON.stringify({
      schemaVersion: "1",
      kind: "user_message",
      petId: "pet_xyz",
      text: "Delivered message test",
    }),
  });

  handlePetInboxPost(req, res, {
    enqueueUserMessage: () => deliveredReceipt,
  });

  await result.done;
  assert.equal(result.statusCode, 500);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.status, "delivered");
});

test("returns 422 when enqueueUserMessage returns rejected or expired receipt", async () => {
  const rejectedReceipt = {
    schemaVersion: "1",
    commandId: "cmd_rej",
    petId: "pet_xyz",
    status: "rejected",
    reason: "SessionClosed: session is closed",
  };

  {
    const { res, result } = createMockRes();
    const req = createMockReq({
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        petId: "pet_xyz",
        text: "Are you there?",
      }),
    });

    handlePetInboxPost(req, res, {
      enqueueUserMessage: () => rejectedReceipt,
    });

    await result.done;
    assert.equal(result.statusCode, 422);
    assert.deepEqual(JSON.parse(result.body), rejectedReceipt);
  }

  const expiredReceipt = {
    schemaVersion: "1",
    commandId: "cmd_exp",
    petId: "pet_xyz",
    status: "expired",
    reason: "Message expired before delivery",
  };

  {
    const { res, result } = createMockRes();
    const req = createMockReq({
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        petId: "pet_xyz",
        text: "Too late",
      }),
    });

    handlePetInboxPost(req, res, {
      enqueueUserMessage: () => expiredReceipt,
    });

    await result.done;
    assert.equal(result.statusCode, 422);
    assert.deepEqual(JSON.parse(result.body), expiredReceipt);
  }
});

test("returns 500 when enqueueUserMessage returns failed receipt or invalid object", async () => {
  const failedReceipt = {
    schemaVersion: "1",
    commandId: "cmd_fail",
    petId: "pet_xyz",
    status: "failed",
    reason: "IO error writing inbox queue",
  };

  {
    const { res, result } = createMockRes();
    const req = createMockReq({
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        petId: "pet_xyz",
        text: "Fail test",
      }),
    });

    handlePetInboxPost(req, res, {
      enqueueUserMessage: () => failedReceipt,
    });

    await result.done;
    assert.equal(result.statusCode, 500);
    assert.deepEqual(JSON.parse(result.body), failedReceipt);
  }

  {
    const { res, result } = createMockRes();
    const req = createMockReq({
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        petId: "pet_xyz",
        text: "Invalid receipt test",
      }),
    });

    handlePetInboxPost(req, res, {
      enqueueUserMessage: () => "not an object",
    });

    await result.done;
    assert.equal(result.statusCode, 500);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "failed");
  }
});

test("returns 503 when pet runtime is not configured", async () => {
  const { res, result } = createMockRes();
  const req = createMockReq({
    body: JSON.stringify({
      schemaVersion: "1",
      kind: "user_message",
      petId: "pet_123",
      text: "Hello",
    }),
  });

  handlePetInboxPost(req, res, {
    env: {}, // No CLAWD_PET_RUNTIME_MODULE
  });

  await result.done;
  assert.equal(result.statusCode, 503);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.reason, "pet runtime not configured");
});

test("returns 413 on oversized body (>16 KiB)", async () => {
  const oversizedText = "a".repeat(MAX_PET_INBOX_BODY_BYTES + 100);
  const { res, result } = createMockRes();
  const req = createMockReq({
    body: JSON.stringify({
      schemaVersion: "1",
      kind: "user_message",
      petId: "pet_123",
      text: oversizedText,
    }),
  });

  handlePetInboxPost(req, res, {
    enqueueUserMessage: () => {
      throw new Error("should not be called");
    },
  });

  await result.done;
  assert.equal(result.statusCode, 413);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.status, "rejected");
  assert.match(parsed.reason, /payload too large/i);
});

test("returns 500 when enqueueUserMessage throws an unexpected error", async () => {
  const { res, result } = createMockRes();
  const req = createMockReq({
    body: JSON.stringify({
      schemaVersion: "1",
      kind: "user_message",
      petId: "pet_123",
      text: "Crash test",
    }),
  });

  handlePetInboxPost(req, res, {
    enqueueUserMessage: () => {
      throw new Error("Disk full or queue locked");
    },
  });

  await result.done;
  assert.equal(result.statusCode, 500);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.status, "failed");
  assert.match(parsed.reason, /Disk full or queue locked/);
});

test("loads runtime via CLAWD_PET_RUNTIME_MODULE when not directly injected", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-inbox-test-"));
  const modulePath = path.join(dir, "runtime.js");
  fs.writeFileSync(
    modulePath,
    `
    module.exports = {
      API_CONTRACT_VERSION: "1",
      createClawdPresentationBridge() { return {}; },
      enqueueUserMessage(opts) {
        return {
          schemaVersion: "1",
          commandId: "cmd_from_module",
          petId: opts.petId,
          status: "queued",
          reason: null,
          payloadEcho: { text: opts.text, deliverAs: opts.deliverAs },
        };
      },
    };
  `,
    "utf8"
  );

  try {
    const { res, result } = createMockRes();
    const req = createMockReq({
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        petId: "pet_loaded_module",
        text: "Testing module load for inbox",
        deliverAs: "followUp",
      }),
    });

    handlePetInboxPost(req, res, {
      env: { CLAWD_PET_RUNTIME_MODULE: modulePath },
    });

    await result.done;
    assert.equal(result.statusCode, 202);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "queued");
    assert.equal(parsed.commandId, "cmd_from_module");
    assert.equal(parsed.petId, "pet_loaded_module");
    assert.deepEqual(parsed.payloadEcho, {
      text: "Testing module load for inbox",
      deliverAs: "followUp",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("server routing dispatches local POST /pet-inbox through initServer", async () => {
  let routedArgs = null;
  let capturedHandler = null;

  function fakeCreateHttpServer(handler) {
    capturedHandler = handler;
    const server = new EventEmitter();
    server.listen = function () { this.emit("listening"); };
    server.close = function () {};
    return server;
  }

  const server = initServer({
    createHttpServer: fakeCreateHttpServer,
    setImmediate: () => {},
    getPortCandidates: () => [23334],
    readRuntimePort: () => 23334,
    clearRuntimeConfig: () => true,
    writeRuntimeConfig: () => true,
    isAgentEnabled: () => true,
    enqueueUserMessage: (args) => {
      routedArgs = args;
      return {
        schemaVersion: "1",
        commandId: "cmd_server_dispatched",
        petId: args.petId,
        status: "queued",
      };
    },
  });

  server.startHttpServer();
  assert.ok(capturedHandler, "HTTP request handler should be registered");

  const { res, result } = createMockRes();
  const req = createMockReq({
    method: "POST",
    url: "/pet-inbox",
    body: JSON.stringify({
      schemaVersion: "1",
      kind: "user_message",
      petId: "pet_e2e_server",
      text: "E2E message to server",
      deliverAs: "followUp",
    }),
  });

  capturedHandler(req, res);

  await result.done;
  assert.equal(result.statusCode, 202);
  assert.equal(result.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.status, "queued");
  assert.equal(parsed.commandId, "cmd_server_dispatched");
  assert.equal(parsed.petId, "pet_e2e_server");

  assert.equal(routedArgs.petId, "pet_e2e_server");
  assert.equal(routedArgs.text, "E2E message to server");
  assert.equal(routedArgs.deliverAs, "followUp");
  assert.equal(routedArgs.followUp, undefined);

  server.cleanup();
});

test("real route with actual configured runtime returns 202 queued and creates pending message with deliverAs followUp", async () => {
  const runtimeModulePath = resolveRootRuntimeModule();
  assert.ok(runtimeModulePath, "Must resolve root runtime module for integration test");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-inbox-e2e-"));
  try {
    const petId = "local_pi_session_real_integration";
    const statusDir = path.join(tempDir, "status");
    fs.mkdirSync(statusDir, { recursive: true });

    // Active session status file so runtime accepts the message
    const statusFile = path.join(statusDir, `status-${petId}.json`);
    fs.writeFileSync(
      statusFile,
      JSON.stringify({
        state: "idle",
        agentId: "pi",
        rawSessionId: "session_real_integration",
      }),
      "utf8"
    );

    const { res, result } = createMockRes();
    const req = createMockReq({
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        petId,
        text: "Real runtime integration message content",
        commandId: "cmd_real_e2e_1",
        dedupKey: "dedup_real_e2e_1",
        // deliverAs omitted to prove canonical followUp is passed and recorded
      }),
    });

    handlePetInboxPost(req, res, {
      env: {
        CLAWD_PET_RUNTIME_MODULE: runtimeModulePath,
        PI_PET_DATA_DIR: tempDir,
      },
      dataDir: tempDir,
    });

    await result.done;
    assert.equal(result.statusCode, 202);
    assert.equal(result.headers["Content-Type"], "application/json; charset=utf-8");
    assert.equal(result.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);

    const parsed = JSON.parse(result.body);
    assert.equal(parsed.schemaVersion, "1");
    assert.equal(parsed.kind, "user_message");
    assert.equal(parsed.commandId, "cmd_real_e2e_1");
    assert.equal(parsed.dedupKey, "dedup_real_e2e_1");
    assert.equal(parsed.petId, petId);
    assert.equal(parsed.status, "queued");
    assert.equal(parsed.deliverAs, "followUp");
    assert.equal(parsed.text, "Real runtime integration message content");

    // Verify pending directory and exactly one message created on disk
    const pendingDir = path.join(tempDir, "inbox", petId, "pending");
    assert.ok(fs.existsSync(pendingDir), "Pending directory should exist");
    const pendingFiles = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
    assert.equal(pendingFiles.length, 1, "Exactly one pending message file should be created");

    const pendingFilePath = path.join(pendingDir, pendingFiles[0]);
    const pendingData = JSON.parse(fs.readFileSync(pendingFilePath, "utf8"));
    assert.equal(pendingData.schemaVersion, "1");
    assert.equal(pendingData.kind, "user_message");
    assert.equal(pendingData.commandId, "cmd_real_e2e_1");
    assert.equal(pendingData.dedupKey, "dedup_real_e2e_1");
    assert.equal(pendingData.petId, petId);
    assert.equal(pendingData.text, "Real runtime integration message content");
    assert.equal(pendingData.deliverAs, "followUp");
    assert.equal(pendingData.followUp, undefined, "followUp boolean must never be written");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("correctly handles multibyte UTF-8 characters split across Buffer data chunks", async () => {
  const chineseText = "你好，世界！这是一条测试消息：🦀 🚀";
  const payloadObj = {
    schemaVersion: "1",
    kind: "user_message",
    petId: "pet_split_utf8",
    text: chineseText,
    deliverAs: "followUp",
  };

  const fullBuffer = Buffer.from(JSON.stringify(payloadObj), "utf8");

  // Deliberately find a multibyte Chinese character (e.g. "你" is 3 bytes: 0xe4, 0xbd, 0xa0)
  const charBytes = Buffer.from("你", "utf8");
  const charOffset = fullBuffer.indexOf(charBytes);
  assert.ok(charOffset >= 0, "Target multibyte character must be present in serialized payload buffer");

  // Split right in the middle of the 3-byte Chinese character "你" (after 1st byte)
  const splitPoint = charOffset + 1;
  const chunk1 = fullBuffer.subarray(0, splitPoint);
  const chunk2 = fullBuffer.subarray(splitPoint);

  // Verify that individual string conversions corrupt with replacement characters
  assert.ok(
    chunk1.toString("utf8").includes("\ufffd") || chunk2.toString("utf8").includes("\ufffd"),
    "Chunk split must cut across a multibyte sequence"
  );

  let capturedMessage = null;
  const { res, result } = createMockRes();

  const req = Readable.from([chunk1, chunk2]);
  req.method = "POST";
  req.url = "/pet-inbox";
  req.headers = { "content-type": "application/json" };

  handlePetInboxPost(req, res, {
    enqueueUserMessage: (args) => {
      capturedMessage = args;
      return {
        schemaVersion: "1",
        commandId: "cmd_split_utf8",
        petId: args.petId,
        status: "queued",
      };
    },
  });

  await result.done;
  assert.equal(result.statusCode, 202);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.status, "queued");

  assert.ok(capturedMessage, "enqueueUserMessage must be called");
  assert.equal(capturedMessage.petId, "pet_split_utf8");
  assert.equal(capturedMessage.text, chineseText);
  assert.equal(capturedMessage.deliverAs, "followUp");
});
