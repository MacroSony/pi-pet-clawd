"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { EventEmitter } = require("node:events");

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  ROUTING_NONCE_HEADER,
} = require("../hooks/server-config");
const {
  createIngressRequestHandler,
} = require("../src/remote-ssh-ingress");
const initServer = require("../src/server");
const {
  createPetInboxCapabilityRegistry,
  handlePetInboxClaimPost,
  handlePetInboxSettlePost,
  handlePetInboxReceiptPost,
  isValidRawSessionId,
  MAX_PET_INBOX_BODY_BYTES,
  validatePetInboxClaimPayload,
  validatePetInboxSettlePayload,
  validatePetInboxReceiptQueryPayload,
} = require("../src/server-route-pet-inbox");
const {
  handleStatePost,
} = require("../src/server-route-state");

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

const rootRuntimeModulePath = resolveRootRuntimeModule();
assert.ok(rootRuntimeModulePath, "Root runtime module must be resolvable for focused tests");
const rootRuntime = require(rootRuntimeModulePath);
const derivePetId = rootRuntime.derivePetId;
assert.equal(typeof derivePetId, "function", "derivePetId must be exported by root runtime");

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function createMockReq({ method = "POST", url = "/pet-inbox/claim", headers = {}, body = "" } = {}) {
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

function dispatchSync(handler, { method = "POST", path: reqPath = "/pet-inbox/claim", headers = {} } = {}) {
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

describe("Remote Ingress Routing & Nonce Gating", () => {
  const validNonce = "a".repeat(32);
  const remoteProfile = { profileId: "remote-worker-1" };

  test("allows POST /pet-inbox/claim and POST /pet-inbox/settle with valid nonce header", () => {
    const routed = [];
    const handler = createIngressRequestHandler({
      remoteProfile,
      getAcceptedNonces: () => [validNonce],
      routeRequest: (req, res) => {
        routed.push(req.url);
        res.writeHead(200);
        res.end("ok");
      },
    });

    const claimRes = dispatchSync(handler, {
      method: "POST",
      path: "/pet-inbox/claim",
      headers: { [ROUTING_NONCE_HEADER]: validNonce },
    });
    assert.equal(claimRes.statusCode, 200);
    assert.equal(claimRes.body, "ok");

    const settleRes = dispatchSync(handler, {
      method: "POST",
      path: "/pet-inbox/settle",
      headers: { [ROUTING_NONCE_HEADER]: validNonce },
    });
    assert.equal(settleRes.statusCode, 200);
    assert.equal(settleRes.body, "ok");

    assert.deepEqual(routed, ["/pet-inbox/claim", "/pet-inbox/settle"]);
  });

  test("rejects POST /pet-inbox/claim and /pet-inbox/settle when nonce is missing or incorrect", () => {
    const routed = [];
    const handler = createIngressRequestHandler({
      remoteProfile,
      getAcceptedNonces: () => [validNonce],
      routeRequest: (req, res) => {
        routed.push(req.url);
        res.writeHead(200);
        res.end("ok");
      },
    });

    // Missing nonce
    const missingClaim = dispatchSync(handler, {
      method: "POST",
      path: "/pet-inbox/claim",
      headers: {},
    });
    assert.equal(missingClaim.statusCode, 404);

    // Wrong nonce
    const wrongSettle = dispatchSync(handler, {
      method: "POST",
      path: "/pet-inbox/settle",
      headers: { [ROUTING_NONCE_HEADER]: "b".repeat(32) },
    });
    assert.equal(wrongSettle.statusCode, 404);

    // Path or query nonce attempt (only header nonce is accepted for claim/settle)
    const pathClaim = dispatchSync(handler, {
      method: "POST",
      path: `/pet-inbox/claim/${validNonce}`,
      headers: {},
    });
    assert.equal(pathClaim.statusCode, 404);

    const querySettle = dispatchSync(handler, {
      method: "POST",
      path: `/pet-inbox/settle?nonce=${validNonce}`,
      headers: {},
    });
    assert.equal(querySettle.statusCode, 404);

    assert.deepEqual(routed, []);
  });

  test("continues rejecting remote POST /pet-inbox and POST /pet-inbox/receipt even with valid nonce", () => {
    const routed = [];
    const handler = createIngressRequestHandler({
      remoteProfile,
      getAcceptedNonces: () => [validNonce],
      routeRequest: (req, res) => {
        routed.push(req.url);
        res.writeHead(200);
        res.end("ok");
      },
    });

    const inboxRes = dispatchSync(handler, {
      method: "POST",
      path: "/pet-inbox",
      headers: { [ROUTING_NONCE_HEADER]: validNonce },
    });
    assert.equal(inboxRes.statusCode, 404);

    const receiptRes = dispatchSync(handler, {
      method: "POST",
      path: "/pet-inbox/receipt",
      headers: { [ROUTING_NONCE_HEADER]: validNonce },
    });
    assert.equal(receiptRes.statusCode, 404);

    assert.deepEqual(routed, []);
  });
});

describe("Local / Remote Fail-Closed Access Control", () => {
  test("claim fails closed with 403 when remoteProfile is null or missing profileId", async () => {
    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-inbox/claim",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message_claim",
        rawSessionId: "session-1",
        capabilityToken: generateToken(),
      }),
    });

    handlePetInboxClaimPost(req, res, {
      remoteProfile: null,
      verifyPetInboxCapability: () => true,
      derivePetId,
      claimNextUserMessage: () => null,
    });

    await result.done;
    assert.equal(result.statusCode, 403);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "rejected");
    assert.match(parsed.reason, /profile-bound ingress required/i);
  });

  test("settle fails closed with 403 when remoteProfile is null", async () => {
    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-inbox/settle",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message_settle",
        rawSessionId: "session-1",
        capabilityToken: generateToken(),
        commandId: "cmd-1",
        claimToken: "claim-tok-1",
        status: "dispatched",
      }),
    });

    handlePetInboxSettlePost(req, res, {
      remoteProfile: null,
      verifyPetInboxCapability: () => true,
      derivePetId,
      settleUserMessage: () => ({ status: "dispatched" }),
    });

    await result.done;
    assert.equal(result.statusCode, 403);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "rejected");
    assert.match(parsed.reason, /profile-bound ingress required/i);
  });

  test("receipt query fails closed with 403 when remoteProfile is present (local-only)", async () => {
    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-inbox/receipt",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message_receipt_query",
        petId: "pet_123",
        commandId: "cmd_123",
      }),
    });

    handlePetInboxReceiptPost(req, res, {
      remoteProfile: { profileId: "remote-worker-1" },
    });

    await result.done;
    assert.equal(result.statusCode, 403);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "rejected");
    assert.match(parsed.reason, /remote receipt query is not allowed/i);
  });
});

describe("Capability Registry & State Route Registration Lifecycle", () => {
  test("registers, rotates, verifies, and revokes capability token with exact profile, pi agent, and rawSessionId", () => {
    const registry = createPetInboxCapabilityRegistry();
    const token1 = generateToken();
    const token2 = generateToken();

    // Register token1
    const reg1 = registry.registerCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-x",
      token: token1,
    });
    assert.equal(reg1, true);

    // Verify token1
    assert.equal(registry.verifyCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-x",
      token: token1,
    }), true);

    // Wrong token
    assert.equal(registry.verifyCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-x",
      token: token2,
    }), false);

    // Profile isolation: wrong profileId
    assert.equal(registry.verifyCapability({
      profileId: "profile-b",
      agentId: "pi",
      rawSessionId: "session-x",
      token: token1,
    }), false);

    // Session isolation: wrong rawSessionId
    assert.equal(registry.verifyCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-y",
      token: token1,
    }), false);

    // Agent isolation: non-pi agent fails
    assert.equal(registry.verifyCapability({
      profileId: "profile-a",
      agentId: "claude-code",
      rawSessionId: "session-x",
      token: token1,
    }), false);

    // Rotate to token2
    const reg2 = registry.registerCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-x",
      token: token2,
    });
    assert.equal(reg2, true);

    // Old token1 is now invalid, token2 is valid
    assert.equal(registry.verifyCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-x",
      token: token1,
    }), false);
    assert.equal(registry.verifyCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-x",
      token: token2,
    }), true);

    // Revoke
    const revoked = registry.revokeCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-x",
    });
    assert.equal(revoked, true);

    // After revocation, token2 is no longer valid
    assert.equal(registry.verifyCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-x",
      token: token2,
    }), false);
  });

  test("profile disconnect clears only remote capabilities and allows unchanged process token to re-register", () => {
    const registry = createPetInboxCapabilityRegistry();
    const localToken = generateToken();
    const remoteToken = generateToken();
    const local = { profileId: "local", agentId: "pi", rawSessionId: "local-session" };
    const remote = { profileId: "profile-remote", agentId: "pi", rawSessionId: "remote-session" };

    assert.equal(registry.registerCapability({ ...local, token: localToken }), true);
    assert.equal(registry.registerCapability({ ...remote, token: remoteToken }), true);
    assert.equal(registry.clearProfile("profile-remote"), 1);
    assert.equal(registry.verifyCapability({ ...remote, token: remoteToken }), false);
    assert.equal(registry.verifyCapability({ ...local, token: localToken }), true);

    assert.equal(registry.registerCapability({ ...remote, token: remoteToken }), true);
    assert.equal(registry.verifyCapability({ ...remote, token: remoteToken }), true);
    assert.equal(registry.clearProfile("local"), 0);
    assert.equal(registry.verifyCapability({ ...local, token: localToken }), true);
  });

  test("registry exposes size getter for tests/diagnostics without leaking tokens or entries", () => {
    const registry = createPetInboxCapabilityRegistry();
    assert.equal(registry.size, 0);

    const tok1 = generateToken();
    const tok2 = generateToken();

    registry.registerCapability({
      profileId: "profile-1",
      agentId: "pi",
      rawSessionId: "sess-1",
      token: tok1,
    });
    assert.equal(registry.size, 1);

    // Updating existing key keeps size at 1
    registry.registerCapability({
      profileId: "profile-1",
      agentId: "pi",
      rawSessionId: "sess-1",
      token: tok2,
    });
    assert.equal(registry.size, 1);

    // Registering distinct key increases size to 2
    registry.registerCapability({
      profileId: "profile-2",
      agentId: "pi",
      rawSessionId: "sess-2",
      token: tok1,
    });
    assert.equal(registry.size, 2);

    // Revoking decrements size
    registry.revokeCapability({
      profileId: "profile-1",
      agentId: "pi",
      rawSessionId: "sess-1",
    });
    assert.equal(registry.size, 1);

    // Clear resets size to 0
    registry.clear();
    assert.equal(registry.size, 0);

    // Ensure tokens/internal map are not exposed
    assert.equal(registry.entries, undefined);
    assert.equal(registry.tokens, undefined);
  });

  test("registry rejects invalid rawSessionId with whitespace-only or control characters", () => {
    const registry = createPetInboxCapabilityRegistry();
    const tok = generateToken();

    // Whitespace only
    assert.equal(registry.registerCapability({
      profileId: "prof-1",
      agentId: "pi",
      rawSessionId: "   ",
      token: tok,
    }), false);

    // NUL byte
    assert.equal(registry.registerCapability({
      profileId: "prof-1",
      agentId: "pi",
      rawSessionId: "sess\0evil",
      token: tok,
    }), false);

    // CR / LF
    assert.equal(registry.registerCapability({
      profileId: "prof-1",
      agentId: "pi",
      rawSessionId: "sess\nbreak",
      token: tok,
    }), false);
    assert.equal(registry.registerCapability({
      profileId: "prof-1",
      agentId: "pi",
      rawSessionId: "sess\rbreak",
      token: tok,
    }), false);

    assert.equal(registry.size, 0);
  });

  test("server-route-state registers capability only for remote authenticated Pi hook_source='pi-extension'", async () => {
    const registered = [];
    const revoked = [];
    const token = generateToken();

    function fakeCtx() {
      return {
        STATE_SVGS: { idle: "idle.svg" },
        updateSession: () => {},
        touchSessionActivity: () => false,
      };
    }

    const baseData = {
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: "pi-sess-100",
      state: "idle",
      event: "SessionStart",
      pet_inbox_capability: {
        version: 1,
        receiveUserMessage: true,
        token,
      },
    };

    // 1. Valid remote Pi extension registration
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/state",
        body: JSON.stringify(baseData),
      });

      handleStatePost(req, res, {
        ctx: fakeCtx(),
        remoteProfile: { profileId: "remote-worker-1" },
        createRequestHookRecorder: () => ({ droppedInvalidAgent: () => {}, acceptedUnlessDnd: () => {} }),
        registerPetInboxCapability: (args) => registered.push(args),
        revokePetInboxCapability: (args) => revoked.push(args),
      });

      await result.done;
      assert.equal(registered.length, 1);
      assert.deepEqual(registered[0], {
        profileId: "remote-worker-1",
        agentId: "pi",
        rawSessionId: "pi-sess-100",
        token,
      });
    }

    // 2. Local state POST must NOT register capability
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/state",
        body: JSON.stringify(baseData),
      });

      handleStatePost(req, res, {
        ctx: fakeCtx(),
        remoteProfile: null,
        createRequestHookRecorder: () => ({ droppedInvalidAgent: () => {}, acceptedUnlessDnd: () => {} }),
        registerPetInboxCapability: (args) => registered.push(args),
        revokePetInboxCapability: (args) => revoked.push(args),
      });

      await result.done;
      assert.equal(registered.length, 1, "Local state must not register capability");
    }

    // 3. Other agent (claude-code) must NOT register capability
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/state",
        body: JSON.stringify({ ...baseData, agent_id: "claude-code" }),
      });

      handleStatePost(req, res, {
        ctx: fakeCtx(),
        remoteProfile: { profileId: "remote-worker-1" },
        createRequestHookRecorder: () => ({ droppedInvalidAgent: () => {}, acceptedUnlessDnd: () => {} }),
        registerPetInboxCapability: (args) => registered.push(args),
        revokePetInboxCapability: (args) => revoked.push(args),
      });

      await result.done;
      assert.equal(registered.length, 1, "Non-pi agent must not register capability");
    }

    // 4. Other hook_source (not pi-extension) must NOT register capability
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/state",
        body: JSON.stringify({ ...baseData, hook_source: "manual" }),
      });

      handleStatePost(req, res, {
        ctx: fakeCtx(),
        remoteProfile: { profileId: "remote-worker-1" },
        createRequestHookRecorder: () => ({ droppedInvalidAgent: () => {}, acceptedUnlessDnd: () => {} }),
        registerPetInboxCapability: (args) => registered.push(args),
        revokePetInboxCapability: (args) => revoked.push(args),
      });

      await result.done;
      assert.equal(registered.length, 1, "Non-pi-extension hook_source must not register capability");
    }

    // 5. Malformed capability shapes must NOT register
    const malformedPayloads = [
      { ...baseData, pet_inbox_capability: "not-an-object" },
      { ...baseData, pet_inbox_capability: { version: 2, receiveUserMessage: true, token } },
      { ...baseData, pet_inbox_capability: { version: 1, receiveUserMessage: false, token } },
      { ...baseData, pet_inbox_capability: { version: 1, receiveUserMessage: true, token: "too-short" } },
      { ...baseData, pet_inbox_capability: { version: 1, receiveUserMessage: true, token: "G".repeat(64) } }, // uppercase / non-hex
      { ...baseData, pet_inbox_capability: [] },
    ];

    for (const badData of malformedPayloads) {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/state",
        body: JSON.stringify(badData),
      });

      handleStatePost(req, res, {
        ctx: fakeCtx(),
        remoteProfile: { profileId: "remote-worker-1" },
        createRequestHookRecorder: () => ({ droppedInvalidAgent: () => {}, acceptedUnlessDnd: () => {} }),
        registerPetInboxCapability: (args) => registered.push(args),
        revokePetInboxCapability: (args) => revoked.push(args),
      });

      await result.done;
      assert.equal(registered.length, 1, "Malformed capability must not register");
    }

    // 6. SessionEnd revokes capability
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/state",
        body: JSON.stringify({
          agent_id: "pi",
          hook_source: "pi-extension",
          session_id: "pi-sess-100",
          state: "idle",
          event: "SessionEnd",
        }),
      });

      handleStatePost(req, res, {
        ctx: fakeCtx(),
        remoteProfile: { profileId: "remote-worker-1" },
        createRequestHookRecorder: () => ({ droppedInvalidAgent: () => {}, acceptedUnlessDnd: () => {} }),
        registerPetInboxCapability: (args) => registered.push(args),
        revokePetInboxCapability: (args) => revoked.push(args),
      });

      await result.done;
      assert.equal(revoked.length, 1);
      assert.deepEqual(revoked[0], {
        profileId: "remote-worker-1",
        agentId: "pi",
        rawSessionId: "pi-sess-100",
      });
    }
  });
});

describe("Payload Validation, Size Limits & UTF-8 Chunk Handling", () => {
  const token = generateToken();

  test("rejects oversized bodies (>16KiB) with 413 for claim, settle, and receipt", async () => {
    const oversizedRawSessionId = "a".repeat(MAX_PET_INBOX_BODY_BYTES + 100);

    // Claim 413
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-inbox/claim",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "user_message_claim",
          rawSessionId: oversizedRawSessionId,
          capabilityToken: token,
        }),
      });

      handlePetInboxClaimPost(req, res, {
        remoteProfile: { profileId: "remote-1" },
        derivePetId,
        claimNextUserMessage: () => null,
      });

      await result.done;
      assert.equal(result.statusCode, 413);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "rejected");
      assert.match(parsed.reason, /payload too large/i);
    }

    // Settle 413
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-inbox/settle",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "user_message_settle",
          rawSessionId: oversizedRawSessionId,
          capabilityToken: token,
          commandId: "cmd-1",
          claimToken: "claim-1",
          status: "dispatched",
        }),
      });

      handlePetInboxSettlePost(req, res, {
        remoteProfile: { profileId: "remote-1" },
        derivePetId,
        settleUserMessage: () => ({ status: "dispatched" }),
      });

      await result.done;
      assert.equal(result.statusCode, 413);
    }

    // Receipt query 413
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-inbox/receipt",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "user_message_receipt_query",
          petId: "a".repeat(MAX_PET_INBOX_BODY_BYTES + 100),
          commandId: "cmd-1",
        }),
      });

      handlePetInboxReceiptPost(req, res, {});

      await result.done;
      assert.equal(result.statusCode, 413);
    }
  });

  test("handles multibyte UTF-8 characters split across Buffer data chunks for claim and settle", async () => {
    const rawSessionIdWithUtf8 = "会话_测试_session_42";
    const payloadObj = {
      schemaVersion: "1",
      kind: "user_message_claim",
      rawSessionId: rawSessionIdWithUtf8,
      capabilityToken: token,
    };

    const fullBuffer = Buffer.from(JSON.stringify(payloadObj), "utf8");
    const charBytes = Buffer.from("会", "utf8");
    const charOffset = fullBuffer.indexOf(charBytes);
    assert.ok(charOffset >= 0);

    const splitPoint = charOffset + 1;
    const chunk1 = fullBuffer.subarray(0, splitPoint);
    const chunk2 = fullBuffer.subarray(splitPoint);

    let claimedArgs = null;
    const { res, result } = createMockRes();
    const req = Readable.from([chunk1, chunk2]);
    req.method = "POST";
    req.url = "/pet-inbox/claim";
    req.headers = { "content-type": "application/json" };

    handlePetInboxClaimPost(req, res, {
      remoteProfile: { profileId: "profile-split-utf8" },
      verifyPetInboxCapability: () => true,
      derivePetId,
      claimNextUserMessage: (args) => {
        claimedArgs = args;
        return null;
      },
    });

    await result.done;
    assert.equal(result.statusCode, 200);
    assert.ok(claimedArgs);
    assert.equal(claimedArgs.rawSessionId, rawSessionIdWithUtf8);
  });

  test("validates claim payload schema strictly and rejects unexpected properties", () => {
    assert.equal(validatePetInboxClaimPayload({
      schemaVersion: "1",
      kind: "user_message_claim",
      rawSessionId: "session-1",
      capabilityToken: token,
    }).ok, true);

    // Disallowed extra keys
    assert.equal(validatePetInboxClaimPayload({
      schemaVersion: "1",
      kind: "user_message_claim",
      rawSessionId: "session-1",
      capabilityToken: token,
      profileId: "remote-worker", // Must not be trusted from body
    }).ok, false);

    assert.equal(validatePetInboxClaimPayload({
      schemaVersion: "1",
      kind: "user_message_claim",
      rawSessionId: "session-1",
      capabilityToken: token,
      extra: "unknown",
    }).ok, false);

    // Bad schemaVersion
    assert.equal(validatePetInboxClaimPayload({
      schemaVersion: "2",
      kind: "user_message_claim",
      rawSessionId: "session-1",
      capabilityToken: token,
    }).ok, false);

    // Bad kind
    assert.equal(validatePetInboxClaimPayload({
      schemaVersion: "1",
      kind: "user_message",
      rawSessionId: "session-1",
      capabilityToken: token,
    }).ok, false);

    // Bad capabilityToken
    assert.equal(validatePetInboxClaimPayload({
      schemaVersion: "1",
      kind: "user_message_claim",
      rawSessionId: "session-1",
      capabilityToken: "invalid-token",
    }).ok, false);
  });

  test("validates settle payload schema strictly and rejects unexpected properties", () => {
    assert.equal(validatePetInboxSettlePayload({
      schemaVersion: "1",
      kind: "user_message_settle",
      rawSessionId: "session-1",
      capabilityToken: token,
      commandId: "cmd-1",
      claimToken: "claim-1",
      status: "dispatched",
    }).ok, true);

    assert.equal(validatePetInboxSettlePayload({
      schemaVersion: "1",
      kind: "user_message_settle",
      rawSessionId: "session-1",
      capabilityToken: token,
      commandId: "cmd-1",
      claimToken: "claim-1",
      status: "failed",
      reason: "Command timed out",
    }).ok, true);

    assert.equal(validatePetInboxSettlePayload({
      schemaVersion: "1",
      kind: "user_message_settle",
      rawSessionId: "session-1",
      capabilityToken: token,
      commandId: "cmd-1",
      claimToken: "claim-1",
      status: "expired",
    }).ok, true);

    // Rejected status values: delivered is not allowed
    assert.equal(validatePetInboxSettlePayload({
      schemaVersion: "1",
      kind: "user_message_settle",
      rawSessionId: "session-1",
      capabilityToken: token,
      commandId: "cmd-1",
      claimToken: "claim-1",
      status: "delivered",
    }).ok, false);

    // Rejected status values: unknown status
    assert.equal(validatePetInboxSettlePayload({
      schemaVersion: "1",
      kind: "user_message_settle",
      rawSessionId: "session-1",
      capabilityToken: token,
      commandId: "cmd-1",
      claimToken: "claim-1",
      status: "queued",
    }).ok, false);

    // Extra unknown keys
    assert.equal(validatePetInboxSettlePayload({
      schemaVersion: "1",
      kind: "user_message_settle",
      rawSessionId: "session-1",
      capabilityToken: token,
      commandId: "cmd-1",
      claimToken: "claim-1",
      status: "dispatched",
      profileId: "attacker",
    }).ok, false);
  });

  test("rawSessionId validation rejects whitespace-only and control characters but allows paths and Unicode", () => {
    // isValidRawSessionId helper
    assert.equal(isValidRawSessionId(""), false);
    assert.equal(isValidRawSessionId("   "), false);
    assert.equal(isValidRawSessionId("\t  \t"), false);
    assert.equal(isValidRawSessionId("session\0evil"), false);
    assert.equal(isValidRawSessionId("session\nnewline"), false);
    assert.equal(isValidRawSessionId("session\rcarriage"), false);
    assert.equal(isValidRawSessionId("/home/user/project/session-1"), true);
    assert.equal(isValidRawSessionId("C:\\Users\\app\\session"), true);
    assert.equal(isValidRawSessionId("会话_42_🦊"), true);
    assert.equal(isValidRawSessionId("тест_сессия_1"), true);

    // In claim payload
    assert.equal(validatePetInboxClaimPayload({
      schemaVersion: "1",
      kind: "user_message_claim",
      rawSessionId: "   ",
      capabilityToken: token,
    }).ok, false);

    assert.equal(validatePetInboxClaimPayload({
      schemaVersion: "1",
      kind: "user_message_claim",
      rawSessionId: "sess\0null",
      capabilityToken: token,
    }).ok, false);

    assert.equal(validatePetInboxClaimPayload({
      schemaVersion: "1",
      kind: "user_message_claim",
      rawSessionId: "/var/run/pi/session-001",
      capabilityToken: token,
    }).ok, true);

    assert.equal(validatePetInboxClaimPayload({
      schemaVersion: "1",
      kind: "user_message_claim",
      rawSessionId: "会话-alpha-123",
      capabilityToken: token,
    }).ok, true);

    // In settle payload
    assert.equal(validatePetInboxSettlePayload({
      schemaVersion: "1",
      kind: "user_message_settle",
      rawSessionId: "   \t",
      capabilityToken: token,
      commandId: "cmd-1",
      claimToken: "claim-1",
      status: "dispatched",
    }).ok, false);

    assert.equal(validatePetInboxSettlePayload({
      schemaVersion: "1",
      kind: "user_message_settle",
      rawSessionId: "sess\nnewline",
      capabilityToken: token,
      commandId: "cmd-1",
      claimToken: "claim-1",
      status: "dispatched",
    }).ok, false);

    assert.equal(validatePetInboxSettlePayload({
      schemaVersion: "1",
      kind: "user_message_settle",
      rawSessionId: "/var/run/pi/session-001",
      capabilityToken: token,
      commandId: "cmd-1",
      claimToken: "claim-1",
      status: "dispatched",
    }).ok, true);
  });

  test("validates receipt query payload schema strictly", () => {
    assert.equal(validatePetInboxReceiptQueryPayload({
      schemaVersion: "1",
      kind: "user_message_receipt_query",
      petId: "pet_alpha_1",
      commandId: "cmd_alpha_1",
    }).ok, true);

    // Bad kind
    assert.equal(validatePetInboxReceiptQueryPayload({
      schemaVersion: "1",
      kind: "receipt_query",
      petId: "pet_alpha_1",
      commandId: "cmd_alpha_1",
    }).ok, false);

    // Unsafe petId
    assert.equal(validatePetInboxReceiptQueryPayload({
      schemaVersion: "1",
      kind: "user_message_receipt_query",
      petId: "../etc/passwd",
      commandId: "cmd_alpha_1",
    }).ok, false);

    // Extra property
    assert.equal(validatePetInboxReceiptQueryPayload({
      schemaVersion: "1",
      kind: "user_message_receipt_query",
      petId: "pet_alpha_1",
      commandId: "cmd_alpha_1",
      extra: 123,
    }).ok, false);
  });
});

describe("Pet ID Derivation Fail-Closed & Status/Field Whitelisting", () => {
  const token = generateToken();

  test("claim fails closed with 503 when derivePetId is missing from injection", async () => {
    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-inbox/claim",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message_claim",
        rawSessionId: "sess-1",
        capabilityToken: token,
      }),
    });

    handlePetInboxClaimPost(req, res, {
      remoteProfile: { profileId: "remote-box" },
      verifyPetInboxCapability: () => true,
      claimNextUserMessage: () => null,
      // derivePetId deliberately omitted
    });

    await result.done;
    assert.equal(result.statusCode, 503);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "failed");
    assert.match(parsed.reason, /pet runtime not configured/i);
  });

  test("settle fails closed with 503 when derivePetId is missing from injection", async () => {
    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-inbox/settle",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message_settle",
        rawSessionId: "sess-1",
        capabilityToken: token,
        commandId: "cmd-1",
        claimToken: "tok-1",
        status: "dispatched",
      }),
    });

    handlePetInboxSettlePost(req, res, {
      remoteProfile: { profileId: "remote-box" },
      verifyPetInboxCapability: () => true,
      settleUserMessage: () => ({ status: "dispatched" }),
      // derivePetId deliberately omitted
    });

    await result.done;
    assert.equal(result.statusCode, 503);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "failed");
    assert.match(parsed.reason, /pet runtime not configured/i);
  });

  test("claim and settle fail closed with 503 when loaded runtime module lacks derivePetId", async () => {
    const mockIncompleteRuntime = {
      claimNextUserMessage: () => null,
      settleUserMessage: () => ({ status: "dispatched" }),
      // derivePetId is missing
    };

    // Claim 503
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-inbox/claim",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "user_message_claim",
          rawSessionId: "sess-1",
          capabilityToken: token,
        }),
      });

      handlePetInboxClaimPost(req, res, {
        remoteProfile: { profileId: "remote-box" },
        verifyPetInboxCapability: () => true,
        loadRuntime: () => mockIncompleteRuntime,
      });

      await result.done;
      assert.equal(result.statusCode, 503);
    }

    // Settle 503
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-inbox/settle",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "user_message_settle",
          rawSessionId: "sess-1",
          capabilityToken: token,
          commandId: "cmd-1",
          claimToken: "tok-1",
          status: "dispatched",
        }),
      });

      handlePetInboxSettlePost(req, res, {
        remoteProfile: { profileId: "remote-box" },
        verifyPetInboxCapability: () => true,
        loadRuntime: () => mockIncompleteRuntime,
      });

      await result.done;
      assert.equal(result.statusCode, 503);
    }
  });

  test("claimed response explicitly whitelists canonical fields and status='claimed' is written last, preventing status overwrite and field leaks", async () => {
    const maliciousClaimResult = {
      schemaVersion: "1",
      kind: "user_message",
      commandId: "cmd-attack-1",
      dedupKey: "dedup-attack-1",
      petId: "pet_custom_attack",
      text: "Testing field isolation",
      deliverAs: "followUp",
      claimToken: "tok-claim-safe",
      createdAtMs: 1757419200000,
      expiresAtMs: 1757419260000,
      claimedAtMs: 1757419200100,
      status: "failed", // Runtime tries to overwrite status to failed
      injectedSecret: "attacker_secret_token",
      arbitraryInternalFlag: true,
      message: {
        schemaVersion: "1",
        kind: "user_message",
        commandId: "cmd-attack-1",
        dedupKey: "dedup-attack-1",
        petId: "pet_custom_attack",
        text: "Testing field isolation",
        deliverAs: "followUp",
        createdAtMs: 1757419200000,
        expiresAtMs: 1757419260000,
        injectedNestedField: "attacker_nested_value",
      },
    };

    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-inbox/claim",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message_claim",
        rawSessionId: "sess-whitelist-test",
        capabilityToken: token,
      }),
    });

    handlePetInboxClaimPost(req, res, {
      remoteProfile: { profileId: "remote-secure-box" },
      verifyPetInboxCapability: () => true,
      derivePetId,
      claimNextUserMessage: () => maliciousClaimResult,
    });

    await result.done;
    assert.equal(result.statusCode, 200);

    const parsed = JSON.parse(result.body);
    // 1. status must be 'claimed' and NOT the runtime's 'failed'
    assert.equal(parsed.status, "claimed");

    // 2. Injected top-level and nested fields must NOT be present
    assert.equal(parsed.injectedSecret, undefined);
    assert.equal(parsed.arbitraryInternalFlag, undefined);
    assert.equal(parsed.message.injectedNestedField, undefined);

    // 3. Whitelisted canonical fields must match exactly
    const canonicalKeys = [
      "schemaVersion",
      "kind",
      "commandId",
      "dedupKey",
      "petId",
      "text",
      "deliverAs",
      "createdAtMs",
      "expiresAtMs",
      "claimToken",
      "claimedAtMs",
      "message",
      "status",
    ];
    assert.deepEqual(Object.keys(parsed), canonicalKeys);

    // 4. status is written last
    const keys = Object.keys(parsed);
    assert.equal(keys[keys.length - 1], "status");
  });
});

describe("Claim, Settle, and Receipt Query Handler Mapping & Statuses", () => {
  const token = generateToken();

  test("claim returns 200 { status: 'empty' } when no messages are pending", async () => {
    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-inbox/claim",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message_claim",
        rawSessionId: "sess-empty",
        capabilityToken: token,
      }),
    });

    handlePetInboxClaimPost(req, res, {
      remoteProfile: { profileId: "remote-box" },
      verifyPetInboxCapability: () => true,
      derivePetId,
      claimNextUserMessage: () => null,
    });

    await result.done;
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    const parsed = JSON.parse(result.body);
    assert.deepEqual(parsed, { status: "empty" });
  });

  test("claim returns 200 { status: 'claimed', ... } and correctly binds petId derived from remoteProfile", async () => {
    let capturedArgs = null;
    const expectedPetId = derivePetId({
      profileId: "remote-box",
      agentId: "pi",
      rawSessionId: "sess-with-msg",
    });

    const stubClaimResult = {
      schemaVersion: "1",
      kind: "user_message",
      commandId: "cmd-claim-1",
      dedupKey: "dedup-1",
      petId: expectedPetId,
      text: "Hello from user to Pi",
      deliverAs: "followUp",
      claimToken: "tok-claim-1",
      createdAtMs: 1757419200000,
      expiresAtMs: 1757419260000,
      claimedAtMs: 1757419200100,
    };

    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-inbox/claim",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message_claim",
        rawSessionId: "sess-with-msg",
        capabilityToken: token,
      }),
    });

    handlePetInboxClaimPost(req, res, {
      remoteProfile: { profileId: "remote-box" },
      verifyPetInboxCapability: () => true,
      derivePetId,
      claimNextUserMessage: (args) => {
        capturedArgs = args;
        return stubClaimResult;
      },
    });

    await result.done;
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "claimed");
    assert.equal(parsed.commandId, "cmd-claim-1");
    assert.equal(parsed.text, "Hello from user to Pi");

    assert.ok(capturedArgs);
    assert.equal(capturedArgs.petId, expectedPetId);
    assert.equal(capturedArgs.profileId, "remote-box");
    assert.equal(capturedArgs.agentId, "pi");
    assert.equal(capturedArgs.rawSessionId, "sess-with-msg");
  });

  test("claim rejects with 403 when capability token does not match", async () => {
    let called = false;
    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-inbox/claim",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message_claim",
        rawSessionId: "sess-1",
        capabilityToken: token,
      }),
    });

    handlePetInboxClaimPost(req, res, {
      remoteProfile: { profileId: "remote-box" },
      verifyPetInboxCapability: () => false,
      derivePetId,
      claimNextUserMessage: () => {
        called = true;
        return null;
      },
    });

    await result.done;
    assert.equal(result.statusCode, 403);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "rejected");
    assert.match(parsed.reason, /invalid or expired capability token/i);
    assert.equal(called, false);
  });

  test("settle returns 200 with receipt on dispatched or failed or expired status", async () => {
    const statuses = ["dispatched", "failed", "expired"];

    for (const status of statuses) {
      const stubReceipt = {
        schemaVersion: "1",
        kind: "user_message",
        commandId: `cmd-settle-${status}`,
        dedupKey: "dedup-settle",
        petId: "pet_remote_1",
        status,
        reason: status === "failed" ? "Execution error" : null,
      };

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-inbox/settle",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "user_message_settle",
          rawSessionId: "sess-settle",
          capabilityToken: token,
          commandId: `cmd-settle-${status}`,
          claimToken: "claim-tok-xyz",
          status,
          ...(status === "failed" ? { reason: "Execution error" } : {}),
        }),
      });

      handlePetInboxSettlePost(req, res, {
        remoteProfile: { profileId: "remote-worker-1" },
        verifyPetInboxCapability: () => true,
        derivePetId,
        settleUserMessage: () => stubReceipt,
      });

      await result.done;
      assert.equal(result.statusCode, 200, `Expected 200 for settle status ${status}`);
      assert.equal(result.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
      const parsed = JSON.parse(result.body);
      assert.deepEqual(parsed, stubReceipt);
    }
  });

  test("settle returns 422 when runtime returns rejected receipt (e.g. invalid claimToken or claim not found)", async () => {
    const rejectedReceipt = {
      schemaVersion: "1",
      commandId: "cmd-settle-bad",
      petId: "pet_remote_1",
      status: "rejected",
      reason: "InvalidClaimToken: claimToken does not match active claim",
    };

    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-inbox/settle",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message_settle",
        rawSessionId: "sess-settle",
        capabilityToken: token,
        commandId: "cmd-settle-bad",
        claimToken: "wrong-claim-token",
        status: "dispatched",
      }),
    });

    handlePetInboxSettlePost(req, res, {
      remoteProfile: { profileId: "remote-worker-1" },
      verifyPetInboxCapability: () => true,
      derivePetId,
      settleUserMessage: () => rejectedReceipt,
    });

    await result.done;
    assert.equal(result.statusCode, 422);
    assert.deepEqual(JSON.parse(result.body), rejectedReceipt);
  });

  test("receipt query returns 200 when receipt found and 404 when missing", async () => {
    const foundReceipt = {
      schemaVersion: "1",
      kind: "user_message",
      commandId: "cmd-rcpt-query",
      dedupKey: "dedup-query",
      petId: "pet_target",
      status: "dispatched",
      reason: null,
      createdAtMs: 1757419200000,
      updatedAtMs: 1757419200500,
    };

    // Found path
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-inbox/receipt",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "user_message_receipt_query",
          petId: "pet_target",
          commandId: "cmd-rcpt-query",
        }),
      });

      handlePetInboxReceiptPost(req, res, {
        getUserMessageReceipt: () => foundReceipt,
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      assert.equal(result.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
      assert.deepEqual(JSON.parse(result.body), foundReceipt);
    }

    // Missing path (returns null)
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-inbox/receipt",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "user_message_receipt_query",
          petId: "pet_target",
          commandId: "cmd-non-existent",
        }),
      });

      handlePetInboxReceiptPost(req, res, {
        getUserMessageReceipt: () => null,
      });

      await result.done;
      assert.equal(result.statusCode, 404);
      assert.deepEqual(JSON.parse(result.body), { status: "not_found" });
    }

    // Missing path (returns { status: 'not_found' })
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-inbox/receipt",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "user_message_receipt_query",
          petId: "pet_target",
          commandId: "cmd-non-existent",
        }),
      });

      handlePetInboxReceiptPost(req, res, {
        getUserMessageReceipt: () => ({ status: "not_found" }),
      });

      await result.done;
      assert.equal(result.statusCode, 404);
      assert.deepEqual(JSON.parse(result.body), { status: "not_found" });
    }
  });

  test("receipt query returns 503 when pet runtime receipt getter is not available", async () => {
    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-inbox/receipt",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message_receipt_query",
        petId: "pet_target",
        commandId: "cmd-123",
      }),
    });

    handlePetInboxReceiptPost(req, res, {
      env: {}, // No CLAWD_PET_RUNTIME_MODULE and no injected function
    });

    await result.done;
    assert.equal(result.statusCode, 503);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "failed");
    assert.match(parsed.reason, /receipt query not available/i);
  });
});

describe("End-to-End Server & Ingress Integration", () => {
  test("full e2e: state registers token -> ingress dispatches claim & settle -> local queries receipt", async () => {
    const validNonce = "c".repeat(32);
    const remoteProfile = { profileId: "remote-pi-box" };
    const rawSessionId = "e2e-session-1";
    const token = generateToken();

    let capturedMainHandler = null;
    function fakeCreateMainHttpServer(handler) {
      capturedMainHandler = handler;
      const server = new EventEmitter();
      server.listen = function () { this.emit("listening"); };
      server.close = function () {};
      server.address = function () { return { port: 23335 }; };
      return server;
    }

    let capturedIngressHandler = null;
    function fakeCreateIngressHttpServer(handler) {
      capturedIngressHandler = handler;
      const server = new EventEmitter();
      server.listen = function () { this.emit("listening"); };
      server.close = function () {};
      server.address = function () { return { port: 23336 }; };
      return server;
    }

    const receiptsStore = new Map();
    let claimedMessage = null;

    const server = initServer({
      createHttpServer: fakeCreateMainHttpServer,
      setImmediate: () => {},
      getPortCandidates: () => [23335],
      readRuntimePort: () => 23335,
      clearRuntimeConfig: () => true,
      writeRuntimeConfig: () => true,
      isAgentEnabled: () => true,
      STATE_SVGS: { idle: "idle.svg" },
      updateSession: () => {},
      derivePetId,
      claimNextUserMessage: ({ petId, rawSessionId: sid }) => {
        if (sid === rawSessionId) {
          claimedMessage = {
            schemaVersion: "1",
            kind: "user_message",
            commandId: "cmd-e2e-msg",
            petId,
            text: "E2E Message Content",
            deliverAs: "followUp",
            claimToken: "claim-tok-e2e",
            createdAtMs: 1757419200000,
            expiresAtMs: 1757419260000,
            claimedAtMs: 1757419200100,
          };
          return claimedMessage;
        }
        return null;
      },
      settleUserMessage: ({ petId, commandId, status, reason }) => {
        const rcpt = {
          schemaVersion: "1",
          kind: "user_message",
          commandId,
          petId,
          status,
          reason: reason || null,
        };
        receiptsStore.set(`${petId}:${commandId}`, rcpt);
        return rcpt;
      },
      getUserMessageReceipt: ({ petId, commandId }) => {
        return receiptsStore.get(`${petId}:${commandId}`) || null;
      },
    });

    server.startHttpServer();
    assert.ok(capturedMainHandler);

    // Create ingress instance
    const ingress = server.openRemoteSshIngress({
      remoteProfile,
      getAcceptedNonces: () => [validNonce],
      createServer: fakeCreateIngressHttpServer,
    });
    const ingressPort = await ingress.start();
    assert.ok(capturedIngressHandler);

    // 1. Post state through ingress to register capability
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/state",
        headers: { [ROUTING_NONCE_HEADER]: validNonce },
        body: JSON.stringify({
          agent_id: "pi",
          hook_source: "pi-extension",
          session_id: rawSessionId,
          state: "idle",
          event: "SessionStart",
          pet_inbox_capability: {
            version: 1,
            receiveUserMessage: true,
            token,
          },
        }),
      });

      // Dispatch to ingress handler
      capturedIngressHandler(req, res);
      await result.done;
      assert.equal(result.statusCode, 200);
    }

    // 2. Claim message through ingress
    let claimToken = null;
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/pet-inbox/claim",
        headers: { [ROUTING_NONCE_HEADER]: validNonce },
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "user_message_claim",
          rawSessionId,
          capabilityToken: token,
        }),
      });

      capturedIngressHandler(req, res);
      await result.done;
      assert.equal(result.statusCode, 200);
      assert.equal(result.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "claimed");
      assert.equal(parsed.commandId, "cmd-e2e-msg");
      assert.equal(parsed.text, "E2E Message Content");
      claimToken = parsed.claimToken;
    }

    // 3. Settle message through ingress
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/pet-inbox/settle",
        headers: { [ROUTING_NONCE_HEADER]: validNonce },
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "user_message_settle",
          rawSessionId,
          capabilityToken: token,
          commandId: "cmd-e2e-msg",
          claimToken,
          status: "dispatched",
        }),
      });

      capturedIngressHandler(req, res);
      await result.done;
      assert.equal(result.statusCode, 200);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "dispatched");
    }

    // 4. Query receipt locally (main server without remoteProfile)
    {
      const expectedPetId = derivePetId({
        profileId: remoteProfile.profileId,
        agentId: "pi",
        rawSessionId,
      });

      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/pet-inbox/receipt",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "user_message_receipt_query",
          petId: expectedPetId,
          commandId: "cmd-e2e-msg",
        }),
      });

      capturedMainHandler(req, res); // Local request: routed through local main server
      await result.done;
      assert.equal(result.statusCode, 200);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.commandId, "cmd-e2e-msg");
      assert.equal(parsed.status, "dispatched");
      assert.equal(parsed.petId, expectedPetId);
    }

    ingress.close();
    server.cleanup();
  });
});
