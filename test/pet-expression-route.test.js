"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

const {
  ROUTING_NONCE_HEADER,
  createIngressRequestHandler,
} = require("../src/remote-ssh-ingress");
const initServer = require("../src/server");
const {
  handlePetExpressionPost,
  MAX_PET_EXPRESSION_BODY_BYTES,
} = require("../src/server-route-pet-expression");

function createMockReq({ method = "POST", url = "/pet-expression", headers = {}, body = "" } = {}) {
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

function dispatchSync(handler, { method = "POST", path = "/pet-expression", headers = {}, body = "" } = {}) {
  const req = {
    method,
    url: path,
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

test("ingress rejects missing/wrong nonce on POST /pet-expression as 404", () => {
  const routed = [];
  const handler = createIngressRequestHandler({
    remoteProfile: { profileId: "remote-profile-1" },
    getAcceptedNonces: () => ["a".repeat(32)],
    routeRequest: (req, res) => {
      routed.push(req.url);
      res.writeHead(200);
      res.end("ok");
    },
  });

  // Missing nonce header
  const noNonceRes = dispatchSync(handler, {
    method: "POST",
    path: "/pet-expression",
  });
  assert.equal(noNonceRes.statusCode, 404);
  assert.equal(noNonceRes.body, "not found");

  // Wrong nonce header
  const wrongNonceRes = dispatchSync(handler, {
    method: "POST",
    path: "/pet-expression",
    headers: { [ROUTING_NONCE_HEADER]: "b".repeat(32) },
  });
  assert.equal(wrongNonceRes.statusCode, 404);
  assert.equal(wrongNonceRes.body, "not found");

  // Nonce in query or path must be rejected for /pet-expression (header only)
  const queryNonceRes = dispatchSync(handler, {
    method: "POST",
    path: `/pet-expression?nonce=${"a".repeat(32)}`,
    headers: {},
  });
  assert.equal(queryNonceRes.statusCode, 404);

  const pathNonceRes = dispatchSync(handler, {
    method: "POST",
    path: `/pet-expression/${"a".repeat(32)}`,
    headers: {},
  });
  assert.equal(pathNonceRes.statusCode, 404);

  assert.deepEqual(routed, []);
});

test("ingress accepts valid nonce header for POST /pet-expression and forwards remoteProfile", () => {
  const seen = [];
  const validNonce = "c".repeat(32);
  const handler = createIngressRequestHandler({
    remoteProfile: { profileId: "remote-profile-1", displayHost: "worker-host" },
    getAcceptedNonces: () => [validNonce],
    routeRequest: (req, res, remoteProfile) => {
      seen.push({ method: req.method, url: req.url, remoteProfile });
      res.writeHead(200);
      res.end("ok");
    },
  });

  const response = dispatchSync(handler, {
    method: "POST",
    path: "/pet-expression",
    headers: { [ROUTING_NONCE_HEADER]: validNonce },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/pet-expression");
  assert.equal(seen[0].remoteProfile.profileId, "remote-profile-1");
});

test("server routeHttpRequest rejects nonce header when received without remoteProfile", async () => {
  const server = initServer({
    readRuntimePort: () => 23333,
    getPortCandidates: () => [23333],
    clearRuntimeConfig: () => true,
    writeRuntimeConfig: () => true,
    isAgentEnabled: () => true,
  });

  const ingress = server.openRemoteSshIngress({
    remoteProfile: { profileId: "remote-profile-1" },
    getAcceptedNonces: () => ["d".repeat(32)],
  });
  assert.ok(ingress);
  ingress.close();
  server.cleanup();
});

test("rejects malformed JSON with 400", async () => {
  const { res, result } = createMockRes();
  const req = createMockReq({ body: "{invalid json" });

  handlePetExpressionPost(req, res, {
    expressExpression: () => {
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
      payload: JSON.stringify([{ schemaVersion: "1", kind: "pet_expression" }]),
      reasonMatch: /payload must be an object/i,
    },
    {
      name: "missing schemaVersion",
      payload: JSON.stringify({ kind: "pet_expression", rawSessionId: "s1", text: "hi" }),
      reasonMatch: /schemaVersion/i,
    },
    {
      name: "invalid schemaVersion",
      payload: JSON.stringify({ schemaVersion: "2", kind: "pet_expression", rawSessionId: "s1", text: "hi" }),
      reasonMatch: /schemaVersion/i,
    },
    {
      name: "missing kind",
      payload: JSON.stringify({ schemaVersion: "1", rawSessionId: "s1", text: "hi" }),
      reasonMatch: /kind/i,
    },
    {
      name: "invalid kind",
      payload: JSON.stringify({ schemaVersion: "1", kind: "expression", rawSessionId: "s1", text: "hi" }),
      reasonMatch: /kind/i,
    },
    {
      name: "missing rawSessionId",
      payload: JSON.stringify({ schemaVersion: "1", kind: "pet_expression", text: "hi" }),
      reasonMatch: /rawSessionId/i,
    },
    {
      name: "empty rawSessionId",
      payload: JSON.stringify({ schemaVersion: "1", kind: "pet_expression", rawSessionId: "", text: "hi" }),
      reasonMatch: /rawSessionId/i,
    },
    {
      name: "oversized rawSessionId (>4096)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "pet_expression", rawSessionId: "x".repeat(4097), text: "hi" }),
      reasonMatch: /rawSessionId/i,
    },
    {
      name: "empty agentId",
      payload: JSON.stringify({ schemaVersion: "1", kind: "pet_expression", rawSessionId: "s1", agentId: "", text: "hi" }),
      reasonMatch: /agentId/i,
    },
    {
      name: "oversized agentId (>256)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "pet_expression", rawSessionId: "s1", agentId: "a".repeat(257), text: "hi" }),
      reasonMatch: /agentId/i,
    },
    {
      name: "oversized text (>2000)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "pet_expression", rawSessionId: "s1", text: "t".repeat(2001) }),
      reasonMatch: /text/i,
    },
    {
      name: "oversized dedupKey (>64)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "pet_expression", rawSessionId: "s1", text: "hi", dedupKey: "k".repeat(65) }),
      reasonMatch: /dedupKey/i,
    },
    {
      name: "ttlMs too low (<1000)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "pet_expression", rawSessionId: "s1", text: "hi", ttlMs: 999 }),
      reasonMatch: /ttlMs/i,
    },
    {
      name: "ttlMs too high (>300000)",
      payload: JSON.stringify({ schemaVersion: "1", kind: "pet_expression", rawSessionId: "s1", text: "hi", ttlMs: 300001 }),
      reasonMatch: /ttlMs/i,
    },
    {
      name: "ttlMs non-integer",
      payload: JSON.stringify({ schemaVersion: "1", kind: "pet_expression", rawSessionId: "s1", text: "hi", ttlMs: 5000.5 }),
      reasonMatch: /ttlMs/i,
    },
    {
      name: "createdAtMs non-number",
      payload: JSON.stringify({ schemaVersion: "1", kind: "pet_expression", rawSessionId: "s1", text: "hi", createdAtMs: "12345" }),
      reasonMatch: /createdAtMs/i,
    },
    {
      name: "unknown property",
      payload: JSON.stringify({ schemaVersion: "1", kind: "pet_expression", rawSessionId: "s1", text: "hi", extra: "forbidden" }),
      reasonMatch: /unknown/i,
    },
  ];

  for (const tc of testCases) {
    const { res, result } = createMockRes();
    const req = createMockReq({ body: tc.payload });

    handlePetExpressionPost(req, res, {
      expressExpression: () => {
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

test("rejects emotion enum violation with 400", async () => {
  const invalidEmotions = ["super_excited", "angry", "confused", "HAPPY", ""];
  for (const emotion of invalidEmotions) {
    const { res, result } = createMockRes();
    const req = createMockReq({
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "pet_expression",
        rawSessionId: "sess-1",
        emotion,
      }),
    });

    handlePetExpressionPost(req, res, {
      expressExpression: () => {
        throw new Error("should not be called");
      },
    });

    await result.done;
    assert.equal(result.statusCode, 400);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "rejected");
    assert.match(parsed.reason, /emotion/i);
  }
});

test("rejects missing text and emotion with 400", async () => {
  const { res, result } = createMockRes();
  const req = createMockReq({
    body: JSON.stringify({
      schemaVersion: "1",
      kind: "pet_expression",
      rawSessionId: "sess-1",
    }),
  });

  handlePetExpressionPost(req, res, {
    expressExpression: () => {
      throw new Error("should not be called");
    },
  });

  await result.done;
  assert.equal(result.statusCode, 400);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.status, "rejected");
  assert.match(parsed.reason, /at least one of text or emotion/i);
});

test("delivered path with stubbed expressExpression returns 200 with receipt JSON", async () => {
  const capturedArgs = [];
  const stubReceipt = {
    schemaVersion: "1",
    commandId: "cmd_test123",
    dedupKey: "notify_42",
    petId: "pet_abc123",
    status: "delivered",
    reason: null,
    payloadEcho: { text: "Task completed!", emotion: "happy" },
    createdAtMs: 1757419200000,
    updatedAtMs: 1757419200100,
  };

  const { res, result } = createMockRes();
  const req = createMockReq({
    body: JSON.stringify({
      schemaVersion: "1",
      kind: "pet_expression",
      rawSessionId: "remote-sess-789",
      agentId: "pi",
      text: "Task completed!",
      emotion: "happy",
      dedupKey: "notify_42",
      ttlMs: 45000,
      createdAtMs: 1757419200000,
    }),
  });

  handlePetExpressionPost(req, res, {
    remoteProfile: { profileId: "remote-worker-node" },
    expressExpression: (args) => {
      capturedArgs.push(args);
      return stubReceipt;
    },
  });

  await result.done;
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["Content-Type"], "application/json; charset=utf-8");
  const parsed = JSON.parse(result.body);
  assert.deepEqual(parsed, stubReceipt);

  assert.equal(capturedArgs.length, 1);
  assert.deepEqual(capturedArgs[0], {
    profileId: "remote-worker-node",
    agentId: "pi",
    rawSessionId: "remote-sess-789",
    text: "Task completed!",
    emotion: "happy",
    dedupKey: "notify_42",
    ttlMs: 45000,
    createdAtMs: 1757419200000,
  });
});

test("delivered path defaults agentId to 'pi' and profileId to 'local' when remoteProfile is null", async () => {
  const capturedArgs = [];
  const stubReceipt = {
    schemaVersion: "1",
    commandId: "cmd_local",
    petId: "pet_local",
    status: "delivered",
    reason: null,
    payloadEcho: { emotion: "celebrate" },
  };

  const { res, result } = createMockRes();
  const req = createMockReq({
    body: JSON.stringify({
      schemaVersion: "1",
      kind: "pet_expression",
      rawSessionId: "local-sess-1",
      emotion: "celebrate",
    }),
  });

  handlePetExpressionPost(req, res, {
    remoteProfile: null,
    expressExpression: (args) => {
      capturedArgs.push(args);
      return stubReceipt;
    },
  });

  await result.done;
  assert.equal(result.statusCode, 200);
  assert.equal(capturedArgs[0].profileId, "local");
  assert.equal(capturedArgs[0].agentId, "pi");
  assert.equal(capturedArgs[0].rawSessionId, "local-sess-1");
  assert.equal(capturedArgs[0].emotion, "celebrate");
});

test("returns 422 when expressExpression returns rejected or expired receipt", async () => {
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
        kind: "pet_expression",
        rawSessionId: "closed-sess",
        text: "Are you there?",
      }),
    });

    handlePetExpressionPost(req, res, {
      expressExpression: () => rejectedReceipt,
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
    reason: "Command expired before processing",
  };

  {
    const { res, result } = createMockRes();
    const req = createMockReq({
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "pet_expression",
        rawSessionId: "stale-sess",
        text: "Too late",
      }),
    });

    handlePetExpressionPost(req, res, {
      expressExpression: () => expiredReceipt,
    });

    await result.done;
    assert.equal(result.statusCode, 422);
    assert.deepEqual(JSON.parse(result.body), expiredReceipt);
  }
});

test("returns 503 when pet runtime is not configured", async () => {
  const { res, result } = createMockRes();
  const req = createMockReq({
    body: JSON.stringify({
      schemaVersion: "1",
      kind: "pet_expression",
      rawSessionId: "sess-1",
      text: "Hello",
    }),
  });

  handlePetExpressionPost(req, res, {
    env: {}, // No CLAWD_PET_RUNTIME_MODULE
  });

  await result.done;
  assert.equal(result.statusCode, 503);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.reason, "pet runtime not configured");
});

test("returns 413 on oversized body (>16 KiB)", async () => {
  const oversizedText = "a".repeat(MAX_PET_EXPRESSION_BODY_BYTES + 100);
  const { res, result } = createMockRes();
  const req = createMockReq({
    body: JSON.stringify({
      schemaVersion: "1",
      kind: "pet_expression",
      rawSessionId: "sess-1",
      text: oversizedText,
    }),
  });

  handlePetExpressionPost(req, res, {
    expressExpression: () => {
      throw new Error("should not be called");
    },
  });

  await result.done;
  assert.ok(result.statusCode === 413 || result.statusCode === 400);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.status, "rejected");
});

test("returns 500 when expressExpression throws an unexpected error", async () => {
  const { res, result } = createMockRes();
  const req = createMockReq({
    body: JSON.stringify({
      schemaVersion: "1",
      kind: "pet_expression",
      rawSessionId: "sess-1",
      text: "Crash test",
    }),
  });

  handlePetExpressionPost(req, res, {
    expressExpression: () => {
      throw new Error("Disk full or permission denied");
    },
  });

  await result.done;
  assert.equal(result.statusCode, 500);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.status, "failed");
  assert.match(parsed.reason, /Disk full or permission denied/);
});

test("loads runtime via CLAWD_PET_RUNTIME_MODULE when not directly injected", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-route-test-"));
  const modulePath = path.join(dir, "runtime.js");
  fs.writeFileSync(
    modulePath,
    `
    module.exports = {
      API_CONTRACT_VERSION: "1",
      createClawdPresentationBridge() { return {}; },
      expressExpression(opts) {
        return {
          schemaVersion: "1",
          commandId: "cmd_from_module",
          petId: "pet_from_module",
          status: "delivered",
          payloadEcho: { text: opts.text },
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
        kind: "pet_expression",
        rawSessionId: "sess-module",
        text: "Testing module load",
      }),
    });

    handlePetExpressionPost(req, res, {
      env: { CLAWD_PET_RUNTIME_MODULE: modulePath },
    });

    await result.done;
    assert.equal(result.statusCode, 200);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "delivered");
    assert.equal(parsed.commandId, "cmd_from_module");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

