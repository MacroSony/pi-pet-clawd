"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");
const {
  createPetPeerCapabilityRegistry,
  createPetPeerHandleStore,
  createPeerSendRateLimiter,
  handlePetPeerCatalogPost,
  handlePetPeerSendPost,
  handlePetPeerClaimPost,
  handlePetPeerSettlePost,
  handlePetPeerReceiptPost,
  validatePetPeerCatalogPayload,
  validatePetPeerSendPayload,
  validatePetPeerClaimPayload,
  validatePetPeerSettlePayload,
  validatePetPeerReceiptQueryPayload,
  countUnicodeCodePoints,
  sanitizeDisplayName,
  sanitizeHost,
  sanitizeState,
  isInactiveState,
  isValidPeerRawSessionId,
  isValidSessionProfileId,
  projectSendReceipt,
  sendJsonResponse,
  MAX_PET_PEER_BODY_BYTES,
  MAX_RESPONSE_BYTES,
  PEER_HANDLE_TTL_MS,
  PEER_SEND_RATE_LIMIT_WINDOW_MS,
  PEER_SEND_RATE_LIMIT_MAX,
  MAX_UNICODE_CODE_POINTS,
  MAX_SETTLE_REASON_CODE_POINTS,
  PEER_MESSAGE_TTL_MS,
} = require("../src/server-route-pet-peer");

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function createMockReq({ method = "POST", url = "/pet-peer/catalog", headers = {}, body = "" } = {}) {
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

describe("Capability Registry & Token Generation Lifecycle", () => {
  test("registers, rotates, verifies, and revokes capability token with exact profile, pi agent, and rawSessionId", () => {
    const registry = createPetPeerCapabilityRegistry();
    const token1 = generateToken();
    const token2 = generateToken();

    // 1. Initial registration
    const reg1 = registry.registerCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-1",
      token: token1,
    });
    assert.equal(reg1, true);
    assert.equal(registry.getGeneration({ profileId: "profile-a", agentId: "pi", rawSessionId: "session-1" }), 1);
    assert.equal(registry.hasCapability({ profileId: "profile-a", agentId: "pi", rawSessionId: "session-1" }), true);

    // 2. Verify matching token
    assert.equal(registry.verifyCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-1",
      token: token1,
    }), true);

    // 3. Wrong token fails verification
    assert.equal(registry.verifyCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-1",
      token: token2,
    }), false);

    // 4. Repeated registration of the SAME token must NOT rotate generation
    const regSame = registry.registerCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-1",
      token: token1,
    });
    assert.equal(regSame, true);
    assert.equal(registry.getGeneration({ profileId: "profile-a", agentId: "pi", rawSessionId: "session-1" }), 1);

    // 5. Rotation to new token increments generation monotonically
    const reg2 = registry.registerCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-1",
      token: token2,
    });
    assert.equal(reg2, true);
    assert.equal(registry.getGeneration({ profileId: "profile-a", agentId: "pi", rawSessionId: "session-1" }), 2);

    // Old token is invalid, new token is valid
    assert.equal(registry.verifyCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-1",
      token: token1,
    }), false);
    assert.equal(registry.verifyCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-1",
      token: token2,
    }), true);

    // 6. Profile and agent isolation
    assert.equal(registry.verifyCapability({
      profileId: "profile-b",
      agentId: "pi",
      rawSessionId: "session-1",
      token: token2,
    }), false);
    assert.equal(registry.verifyCapability({
      profileId: "profile-a",
      agentId: "claude-code",
      rawSessionId: "session-1",
      token: token2,
    }), false);

    // 7. Revoke removes capability
    const revoked = registry.revokeCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-1",
      token: token2,
    });
    assert.equal(revoked, true);
    assert.equal(registry.hasCapability({ profileId: "profile-a", agentId: "pi", rawSessionId: "session-1" }), false);
    assert.equal(registry.getGeneration({ profileId: "profile-a", agentId: "pi", rawSessionId: "session-1" }), null);
    assert.equal(registry.verifyCapability({
      profileId: "profile-a",
      agentId: "pi",
      rawSessionId: "session-1",
      token: token2,
    }), false);
  });

  test("capability lifecycle: A->B stale A rejected, stale A revoke fails, B revokes, stale B cannot resurrect, fresh C attaches", () => {
    const registry = createPetPeerCapabilityRegistry();
    const tokenA = generateToken();
    const tokenB = generateToken();
    const tokenC = generateToken();

    // 1. Initial register A on profile-x
    assert.equal(registry.registerCapability({
      profileId: "profile-x",
      agentId: "pi",
      rawSessionId: "session-lc",
      token: tokenA,
    }), true);
    assert.equal(registry.getGeneration({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc" }), 1);
    assert.equal(registry.hasCapability({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc" }), true);
    assert.equal(registry.verifyCapability({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc", token: tokenA }), true);

    // 2. Active token A -> register new B retires A and activates B with fresh generation 2
    assert.equal(registry.registerCapability({
      profileId: "profile-x",
      agentId: "pi",
      rawSessionId: "session-lc",
      token: tokenB,
    }), true);
    assert.equal(registry.getGeneration({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc" }), 2);
    assert.equal(registry.verifyCapability({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc", token: tokenB }), true);
    assert.equal(registry.verifyCapability({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc", token: tokenA }), false);

    // 3. Stale heartbeat attempting register A MUST return false and MUST NOT replace B
    assert.equal(registry.registerCapability({
      profileId: "profile-x",
      agentId: "pi",
      rawSessionId: "session-lc",
      token: tokenA,
    }), false);
    assert.equal(registry.verifyCapability({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc", token: tokenB }), true);
    assert.equal(registry.getGeneration({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc" }), 2);

    // Repeating current B remains true and same generation
    assert.equal(registry.registerCapability({
      profileId: "profile-x",
      agentId: "pi",
      rawSessionId: "session-lc",
      token: tokenB,
    }), true);
    assert.equal(registry.getGeneration({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc" }), 2);

    // 4. Stale A SessionEnd / revoke cannot revoke B; B remains active
    assert.equal(registry.revokeCapability({
      profileId: "profile-x",
      agentId: "pi",
      rawSessionId: "session-lc",
      token: tokenA,
    }), false);
    assert.equal(registry.hasCapability({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc" }), true);
    assert.equal(registry.verifyCapability({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc", token: tokenB }), true);
    assert.equal(registry.getGeneration({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc" }), 2);

    // Revoke with omitted or malformed token fails
    assert.equal(registry.revokeCapability({
      profileId: "profile-x",
      agentId: "pi",
      rawSessionId: "session-lc",
    }), false);
    assert.equal(registry.revokeCapability({
      profileId: "profile-x",
      agentId: "pi",
      rawSessionId: "session-lc",
      token: "malformed",
    }), false);
    assert.equal(registry.hasCapability({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc" }), true);

    // 5. Successful revoke with token B retires B and leaves identity inactive
    assert.equal(registry.revokeCapability({
      profileId: "profile-x",
      agentId: "pi",
      rawSessionId: "session-lc",
      token: tokenB,
    }), true);
    assert.equal(registry.hasCapability({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc" }), false);
    assert.equal(registry.verifyCapability({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc", token: tokenB }), false);
    assert.equal(registry.getGeneration({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc" }), null);

    // Revoking again fails
    assert.equal(registry.revokeCapability({
      profileId: "profile-x",
      agentId: "pi",
      rawSessionId: "session-lc",
      token: tokenB,
    }), false);

    // 6. Stale B heartbeat cannot re-register / resurrect afterward
    assert.equal(registry.registerCapability({
      profileId: "profile-x",
      agentId: "pi",
      rawSessionId: "session-lc",
      token: tokenB,
    }), false);
    assert.equal(registry.hasCapability({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc" }), false);
    assert.equal(registry.getGeneration({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc" }), null);

    // Stale A also cannot register
    assert.equal(registry.registerCapability({
      profileId: "profile-x",
      agentId: "pi",
      rawSessionId: "session-lc",
      token: tokenA,
    }), false);

    // 7. A fresh unseen C can register with a fresh never-reused generation
    assert.equal(registry.registerCapability({
      profileId: "profile-x",
      agentId: "pi",
      rawSessionId: "session-lc",
      token: tokenC,
    }), true);
    assert.equal(registry.hasCapability({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc" }), true);
    assert.equal(registry.verifyCapability({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc", token: tokenC }), true);
    assert.equal(registry.getGeneration({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc" }), 3);

    // 8. Exact profile identity isolation: profile-y can register tokenA without interference
    assert.equal(registry.registerCapability({
      profileId: "profile-y",
      agentId: "pi",
      rawSessionId: "session-lc",
      token: tokenA,
    }), true);
    assert.equal(registry.hasCapability({ profileId: "profile-y", agentId: "pi", rawSessionId: "session-lc" }), true);
    assert.equal(registry.verifyCapability({ profileId: "profile-y", agentId: "pi", rawSessionId: "session-lc", token: tokenA }), true);
    assert.equal(registry.getGeneration({ profileId: "profile-y", agentId: "pi", rawSessionId: "session-lc" }), 4);

    // profile-x is unaffected
    assert.equal(registry.verifyCapability({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc", token: tokenC }), true);
    assert.equal(registry.getGeneration({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc" }), 3);

    // 9. clear removes all records/history
    registry.clear();
    assert.equal(registry.size, 0);
    assert.equal(registry.hasCapability({ profileId: "profile-x", agentId: "pi", rawSessionId: "session-lc" }), false);
    assert.equal(registry.hasCapability({ profileId: "profile-y", agentId: "pi", rawSessionId: "session-lc" }), false);

    // After clear, tokenA can be registered again as history was cleared
    assert.equal(registry.registerCapability({
      profileId: "profile-x",
      agentId: "pi",
      rawSessionId: "session-lc",
      token: tokenA,
    }), true);
  });

  test("capability generation ABA: generations are never reused and pre-revoke handle cannot revive", () => {
    const registry = createPetPeerCapabilityRegistry();
    const store = createPetPeerHandleStore();
    const tokenCaller = generateToken();
    const tokenTargetA = generateToken();
    const tokenTargetB = generateToken();
    const nowMs = 1757419200000;

    // 1. Register caller and target A
    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "caller-1", token: tokenCaller });
    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "target-1", token: tokenTargetA });

    const callerGen1 = registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: "caller-1" });
    const targetGen1 = registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: "target-1" });
    assert.equal(callerGen1, 1);
    assert.equal(targetGen1, 2);

    // 2. Create handle with target generation = targetGen1
    const { handle: oldHandle } = store.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-1" },
      callerGeneration: callerGen1,
      target: { profileId: "local", agentId: "pi", rawSessionId: "target-1", displayName: "Target", host: "local" },
      targetGeneration: targetGen1,
      nowMs,
    });

    // 3. Target capability is revoked
    registry.revokeCapability({ profileId: "local", agentId: "pi", rawSessionId: "target-1", token: tokenTargetA });
    assert.equal(registry.hasCapability({ profileId: "local", agentId: "pi", rawSessionId: "target-1" }), false);

    // 4. Target registers again with tokenTargetB (or even tokenTargetA)
    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "target-1", token: tokenTargetB });
    const targetGenNew = registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: "target-1" });
    assert.ok(targetGenNew > targetGen1, `New generation ${targetGenNew} must be strictly greater than pre-revoke generation ${targetGen1}`);

    // 5. Old pre-revoke handle MUST NOT revive
    const resolveResult = store.resolveAndConsumeHandle(oldHandle, {
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-1" },
      registry,
      nowMs,
    });
    assert.equal(resolveResult.ok, false);
    assert.equal(resolveResult.reason, "target_capability_rotated");
  });

  test("never exposes token via public registry methods or inspect", () => {
    const registry = createPetPeerCapabilityRegistry();
    const tok = generateToken();

    registry.registerCapability({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "sess-secret",
      token: tok,
    });

    assert.equal(registry.tokens, undefined);
    assert.equal(registry.entries, undefined);
    assert.equal(registry.getGeneration({ profileId: "local", rawSessionId: "sess-secret" }), 1);
    assert.equal(typeof registry.getGeneration({ profileId: "local", rawSessionId: "sess-secret" }), "number");
    assert.ok(!JSON.stringify(registry).includes(tok));
  });

  test("rejects invalid inputs on register, verify, revoke, and getGeneration conforming to profile validation", () => {
    const registry = createPetPeerCapabilityRegistry();
    const tok = generateToken();

    // Invalid profileId (empty, control chars, spaces, >64 chars)
    assert.equal(registry.registerCapability({ profileId: "", agentId: "pi", rawSessionId: "sess", token: tok }), false);
    assert.equal(registry.registerCapability({ profileId: "prof\0bad", agentId: "pi", rawSessionId: "sess", token: tok }), false);
    assert.equal(registry.registerCapability({ profileId: "invalid space", agentId: "pi", rawSessionId: "sess", token: tok }), false);
    assert.equal(registry.registerCapability({ profileId: "a".repeat(65), agentId: "pi", rawSessionId: "sess", token: tok }), false);
    assert.equal(registry.getGeneration({ profileId: "a".repeat(65), agentId: "pi", rawSessionId: "sess" }), null);

    // Non-pi agent
    assert.equal(registry.registerCapability({ profileId: "local", agentId: "codex", rawSessionId: "sess", token: tok }), false);

    // Invalid rawSessionId (empty, whitespace, newline, null)
    assert.equal(registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "", token: tok }), false);
    assert.equal(registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "   ", token: tok }), false);
    assert.equal(registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "sess\n1", token: tok }), false);
    assert.equal(registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "sess\0evil", token: tok }), false);

    // Default identities (default, pi:, pi:default with or without trimming) rejected
    assert.equal(registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "default", token: tok }), false);
    assert.equal(registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: " default ", token: tok }), false);
    assert.equal(registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "pi:", token: tok }), false);
    assert.equal(registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "  pi:  ", token: tok }), false);
    assert.equal(registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "pi:default", token: tok }), false);
    assert.equal(registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: " pi:default ", token: tok }), false);

    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId: "default", token: tok }), false);
    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId: "pi:", token: tok }), false);
    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId: "pi:default", token: tok }), false);

    assert.equal(registry.revokeCapability({ profileId: "local", agentId: "pi", rawSessionId: "default", token: tok }), false);
    assert.equal(registry.revokeCapability({ profileId: "local", agentId: "pi", rawSessionId: "pi:", token: tok }), false);
    assert.equal(registry.revokeCapability({ profileId: "local", agentId: "pi", rawSessionId: "pi:default", token: tok }), false);
    assert.equal(registry.revokeCapability({ profileId: "local", agentId: "pi", rawSessionId: "sess", token: "too-short" }), false);
    assert.equal(registry.revokeCapability({ profileId: "local", agentId: "pi", rawSessionId: "sess" }), false);

    assert.equal(registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: "default" }), null);
    assert.equal(registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: "pi:" }), null);
    assert.equal(registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: "pi:default" }), null);

    assert.equal(registry.hasCapability({ profileId: "local", agentId: "pi", rawSessionId: "default" }), false);
    assert.equal(registry.hasCapability({ profileId: "local", agentId: "pi", rawSessionId: "pi:" }), false);
    assert.equal(registry.hasCapability({ profileId: "local", agentId: "pi", rawSessionId: "pi:default" }), false);

    // Malformed token
    assert.equal(registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "sess", token: "too-short" }), false);
    assert.equal(registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "sess", token: "A".repeat(64) }), false); // uppercase hex

    assert.equal(registry.size, 0);
  });
});

describe("Handle Store Lifecycle, Scoping & Atomic Invalidation", () => {
  test("creates psh_ handles bound to caller + generation and target + generation", () => {
    const store = createPetPeerHandleStore();
    const nowMs = 1757419200000;

    const { handle, expiresAtMs } = store.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-sess" },
      callerGeneration: 1,
      target: { profileId: "remote-1", agentId: "pi", rawSessionId: "target-sess", displayName: "Remote Pi", host: "remote-1" },
      targetGeneration: 1,
      nowMs,
    });

    assert.ok(handle.startsWith("psh_"));
    assert.equal(expiresAtMs, nowMs + PEER_HANDLE_TTL_MS);
    assert.equal(store.size, 1);
  });

  test("atomic resolveAndConsumeHandle succeeds once and deletes handle (single use, concurrency-safe)", () => {
    const registry = createPetPeerCapabilityRegistry();
    const tokCaller = generateToken();
    const tokTarget = generateToken();

    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "caller-1", token: tokCaller });
    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "target-1", token: tokTarget });

    const store = createPetPeerHandleStore();
    const nowMs = 1757419200000;

    const { handle } = store.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-1" },
      callerGeneration: 1,
      target: { profileId: "local", agentId: "pi", rawSessionId: "target-1", displayName: "Target", host: "local" },
      targetGeneration: 2,
      nowMs,
    });

    // First resolution succeeds
    const res1 = store.resolveAndConsumeHandle(handle, {
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-1" },
      registry,
      nowMs,
    });
    assert.equal(res1.ok, true);
    assert.equal(res1.entry.target.rawSessionId, "target-1");
    assert.equal(store.size, 0);

    // Second resolution fails (already consumed / not found)
    const res2 = store.resolveAndConsumeHandle(handle, {
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-1" },
      registry,
      nowMs,
    });
    assert.equal(res2.ok, false);
    assert.equal(res2.reason, "not_found");
  });

  test("rejects handle when used by a different caller (cross-caller handle isolation)", () => {
    const registry = createPetPeerCapabilityRegistry();
    const tok1 = generateToken();
    const tok2 = generateToken();
    const tokTarget = generateToken();

    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "caller-a", token: tok1 });
    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "caller-b", token: tok2 });
    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "target-1", token: tokTarget });

    const store = createPetPeerHandleStore();
    const nowMs = 1757419200000;

    const { handle } = store.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-a" },
      callerGeneration: 1,
      target: { profileId: "local", agentId: "pi", rawSessionId: "target-1", displayName: "Target", host: "local" },
      targetGeneration: 3,
      nowMs,
    });

    // Caller B tries to use Caller A's handle
    const crossRes = store.resolveAndConsumeHandle(handle, {
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-b" },
      registry,
      nowMs,
    });
    assert.equal(crossRes.ok, false);
    assert.equal(crossRes.reason, "caller_mismatch");

    // Handle is not destroyed by wrong caller, legitimate caller A can still use it
    const legitRes = store.resolveAndConsumeHandle(handle, {
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-a" },
      registry,
      nowMs,
    });
    assert.equal(legitRes.ok, true);
  });

  test("strictly enforces exact expiry boundary (expiresAtMs <= nowMs)", () => {
    const registry = createPetPeerCapabilityRegistry();
    const tokCaller = generateToken();
    const tokTarget = generateToken();

    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "caller-1", token: tokCaller });
    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "target-1", token: tokTarget });

    const store = createPetPeerHandleStore();
    const startMs = 1757419200000;

    // 1. Handle valid at nowMs = expiresAtMs - 1
    const { handle: h1, expiresAtMs: exp1 } = store.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-1" },
      callerGeneration: 1,
      target: { profileId: "local", agentId: "pi", rawSessionId: "target-1", displayName: "Target", host: "local" },
      targetGeneration: 2,
      nowMs: startMs,
    });

    const validRes = store.resolveAndConsumeHandle(h1, {
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-1" },
      registry,
      nowMs: exp1 - 1,
    });
    assert.equal(validRes.ok, true);

    // 2. Handle expired at exact boundary: nowMs === expiresAtMs
    const { handle: h2, expiresAtMs: exp2 } = store.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-1" },
      callerGeneration: 1,
      target: { profileId: "local", agentId: "pi", rawSessionId: "target-1", displayName: "Target", host: "local" },
      targetGeneration: 2,
      nowMs: startMs,
    });

    const exactExpiredRes = store.resolveAndConsumeHandle(h2, {
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-1" },
      registry,
      nowMs: exp2,
    });
    assert.equal(exactExpiredRes.ok, false);
    assert.equal(exactExpiredRes.reason, "expired");

    // 3. pruneExpired cleans up at exact boundary: nowMs === expiresAtMs
    const { handle: h3, expiresAtMs: exp3 } = store.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-1" },
      callerGeneration: 1,
      target: { profileId: "local", agentId: "pi", rawSessionId: "target-1", displayName: "Target", host: "local" },
      targetGeneration: 2,
      nowMs: startMs,
    });
    assert.equal(store.size, 1);
    store.pruneExpired(exp3);
    assert.equal(store.size, 0);
  });

  test("invalidates handle when caller or target rotates capability token", () => {
    const registry = createPetPeerCapabilityRegistry();
    const tokCaller1 = generateToken();
    const tokTarget1 = generateToken();

    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "caller-1", token: tokCaller1 });
    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "target-1", token: tokTarget1 });

    const store = createPetPeerHandleStore();
    const nowMs = 1757419200000;

    // 1. Caller rotation test
    const h1 = store.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-1" },
      callerGeneration: 1,
      target: { profileId: "local", agentId: "pi", rawSessionId: "target-1", displayName: "Target", host: "local" },
      targetGeneration: 2,
      nowMs,
    }).handle;

    // Caller rotates token
    const tokCaller2 = generateToken();
    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "caller-1", token: tokCaller2 });
    assert.equal(registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: "caller-1" }), 3);

    const callerRotatedRes = store.resolveAndConsumeHandle(h1, {
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-1" },
      registry,
      nowMs,
    });
    assert.equal(callerRotatedRes.ok, false);
    assert.equal(callerRotatedRes.reason, "capability_rotated");

    // 2. Target rotation test
    const h2 = store.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-1" },
      callerGeneration: 3,
      target: { profileId: "local", agentId: "pi", rawSessionId: "target-1", displayName: "Target", host: "local" },
      targetGeneration: 2,
      nowMs,
    }).handle;

    // Target rotates token
    const tokTarget2 = generateToken();
    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "target-1", token: tokTarget2 });
    assert.equal(registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: "target-1" }), 4);

    const targetRotatedRes = store.resolveAndConsumeHandle(h2, {
      caller: { profileId: "local", agentId: "pi", rawSessionId: "caller-1" },
      registry,
      nowMs,
    });
    assert.equal(targetRotatedRes.ok, false);
    assert.equal(targetRotatedRes.reason, "target_capability_rotated");
  });
});

describe("Peer Send Rate Limiter", () => {
  test("allows up to 10 sends in 60s window, rate-limits 11th, and resets after window rolls over", () => {
    const rateLimiter = createPeerSendRateLimiter();
    const source = { profileId: "local", agentId: "pi", rawSessionId: "sender-1" };
    let nowMs = 1757419200000;

    // 10 accepted sends
    for (let i = 1; i <= 10; i++) {
      const check = rateLimiter.check(source, nowMs);
      assert.equal(check.allowed, true, `Send ${i} should be allowed`);
      assert.equal(check.remaining, 11 - i);
      rateLimiter.record(source, nowMs);
    }

    // 11th send attempt within 60s is rejected
    const check11 = rateLimiter.check(source, nowMs);
    assert.equal(check11.allowed, false, "11th send in 60s window must be rate limited");
    assert.equal(check11.remaining, 0);
    assert.ok(check11.resetMs > 0);

    // Another source is not affected (per-source isolation)
    const otherSource = { profileId: "local", agentId: "pi", rawSessionId: "sender-2" };
    assert.equal(rateLimiter.check(otherSource, nowMs).allowed, true);

    // Advance time past 60s window
    nowMs += 60001;
    const checkAfter = rateLimiter.check(source, nowMs);
    assert.equal(checkAfter.allowed, true, "Sends should be allowed after 60s window rolls over");
    assert.equal(checkAfter.remaining, 10);
  });
});

describe("Catalog Route (POST /pet-peer/catalog)", () => {
  const tokenCaller = generateToken();
  const tokenTarget1 = generateToken();
  const tokenTarget2 = generateToken();

  function setupCatalogFixtures() {
    const registry = createPetPeerCapabilityRegistry();
    const handleStore = createPetPeerHandleStore();

    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "caller-sess", token: tokenCaller });
    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "target-active-1", token: tokenTarget1 });
    registry.registerCapability({ profileId: "remote-host", agentId: "pi", rawSessionId: "caller-sess", token: tokenTarget2 }); // Same rawSessionId but remote

    const mockSnapshot = [
      {
        id: "caller-sess",
        profileId: "local",
        rawSessionId: "caller-sess",
        agentId: "pi",
        displayTitle: "Caller Pi",
        sourceDisplayLabel: "local",
        state: "idle",
        headless: false,
      },
      {
        id: "target-active-1",
        profileId: "local",
        rawSessionId: "target-active-1",
        agentId: "pi",
        displayTitle: "Active Desk",
        sourceDisplayLabel: "local",
        state: "idle",
        headless: false,
      },
      {
        id: "target-remote-same-id",
        profileId: "remote-host",
        rawSessionId: "caller-sess",
        agentId: "pi",
        displayTitle: "Remote",
        sourceDisplayLabel: "remote-host",
        state: "running",
        headless: false,
      },
      // Inactive / non-discoverable candidates:
      {
        id: "target-headless",
        profileId: "local",
        rawSessionId: "target-headless",
        agentId: "pi",
        displayTitle: "Headless Pi",
        state: "idle",
        headless: true,
      },
      {
        id: "target-startup-recovered",
        profileId: "local",
        rawSessionId: "target-startup-recovered",
        agentId: "pi",
        displayTitle: "Recovered Pi",
        state: "idle",
        startupRecovered: true,
      },
      {
        id: "target-hidden",
        profileId: "local",
        rawSessionId: "target-hidden",
        agentId: "pi",
        displayTitle: "Hidden Pi",
        state: "idle",
        hiddenFromHud: true,
      },
      {
        id: "target-sleeping",
        profileId: "local",
        rawSessionId: "target-sleeping",
        agentId: "pi",
        displayTitle: "Sleeping Pi",
        state: "sleeping",
      },
      {
        id: "target-closed",
        profileId: "local",
        rawSessionId: "target-closed",
        agentId: "pi",
        displayTitle: "Closed Pi",
        state: "closed",
      },
      {
        id: "target-claude",
        profileId: "local",
        rawSessionId: "target-claude",
        agentId: "claude-code",
        displayTitle: "Claude Agent",
        state: "idle",
      },
      {
        id: "target-no-capability",
        profileId: "local",
        rawSessionId: "target-no-capability",
        agentId: "pi",
        displayTitle: "Pi Without Cap",
        state: "idle",
      },
    ];

    return { registry, handleStore, mockSnapshot };
  }

  test("returns only active interactive Pi sessions with EXACT fields, formatted displayName, and NO leaked identity/tokens", async () => {
    const { registry, handleStore, mockSnapshot } = setupCatalogFixtures();
    const { res, result } = createMockRes();

    const req = createMockReq({
      url: "/pet-peer/catalog",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "peer_catalog_query",
        rawSessionId: "caller-sess",
        capabilityToken: tokenCaller,
      }),
    });

    handlePetPeerCatalogPost(req, res, {
      remoteProfile: null, // local caller
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      getSessionSnapshot: () => ({ sessions: mockSnapshot }),
    });

    await result.done;
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);

    const parsed = JSON.parse(result.body);
    assert.equal(parsed.schemaVersion, "1");
    assert.equal(parsed.kind, "peer_catalog");
    assert.ok(Array.isArray(parsed.sessions));

    // Exactly 2 sessions discoverable: target-active-1 and remote caller-sess (same raw id but remote)
    assert.equal(parsed.sessions.length, 2);

    const exactAllowedEntryKeys = ["canMessage", "capabilities", "displayName", "expiresAtMs", "handle", "host", "state"];

    for (const session of parsed.sessions) {
      const keys = Object.keys(session).sort();
      assert.deepEqual(keys, exactAllowedEntryKeys, "Session entry must contain EXACT contract fields only");

      // No leaked internal fields
      assert.equal(session.petId, undefined);
      assert.equal(session.profileId, undefined);
      assert.equal(session.rawSessionId, undefined);
      assert.equal(session.sessionId, undefined);
      assert.equal(session.id, undefined);
      assert.equal(session.cwd, undefined);
      assert.equal(session.pid, undefined);
      assert.equal(session.token, undefined);

      assert.ok(session.handle.startsWith("psh_"));
      assert.deepEqual(session.capabilities, ["receive_peer_message"]);
      assert.equal(session.canMessage, true);
      assert.ok(session.expiresAtMs > Date.now());
    }

    // Verify displayName formatting: bounded "<sanitized title> · Pi"
    const displayNames = parsed.sessions.map((s) => s.displayName);
    assert.ok(!displayNames.includes("Caller · Pi"), "Caller session must be excluded");
    assert.ok(displayNames.includes("Remote · Pi"));
    assert.ok(displayNames.includes("Active Desk · Pi"));
  });

  test("fails closed instead of returning a misleading empty catalog when the snapshot is unavailable", async () => {
    const cases = [
      {
        label: "missing provider",
        expectedStatus: 503,
        expectedReason: "session snapshot unavailable",
      },
      {
        label: "throwing provider",
        getSessionSnapshot: () => { throw new Error("snapshot failed"); },
        expectedStatus: 500,
        expectedReason: "failed to retrieve session snapshot",
      },
      {
        label: "invalid provider result",
        getSessionSnapshot: () => null,
        expectedStatus: 500,
        expectedReason: "invalid session snapshot",
      },
    ];

    for (const fixture of cases) {
      const { registry, handleStore } = setupCatalogFixtures();
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/catalog",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_catalog_query",
          rawSessionId: "caller-sess",
          capabilityToken: tokenCaller,
        }),
      });

      handlePetPeerCatalogPost(req, res, {
        remoteProfile: null,
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        ...(fixture.getSessionSnapshot ? { getSessionSnapshot: fixture.getSessionSnapshot } : {}),
      });

      await result.done;
      assert.equal(result.statusCode, fixture.expectedStatus, fixture.label);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "failed", fixture.label);
      assert.equal(parsed.reason, fixture.expectedReason, fixture.label);
      assert.equal(parsed.sessions, undefined, fixture.label);
    }
  });

  test("applies state and host filters on sanitized projections", async () => {
    const { registry, handleStore, mockSnapshot } = setupCatalogFixtures();

    // Filter by state: "running"
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/catalog",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_catalog_query",
          rawSessionId: "caller-sess",
          capabilityToken: tokenCaller,
          state: "running",
        }),
      });

      handlePetPeerCatalogPost(req, res, {
        remoteProfile: null,
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        getSessionSnapshot: () => ({ sessions: mockSnapshot }),
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.sessions.length, 1);
      assert.equal(parsed.sessions[0].displayName, "Remote · Pi");
      assert.equal(parsed.sessions[0].state, "running");
    }

    // Filter by host: "local"
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/catalog",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_catalog_query",
          rawSessionId: "caller-sess",
          capabilityToken: tokenCaller,
          host: "local",
        }),
      });

      handlePetPeerCatalogPost(req, res, {
        remoteProfile: null,
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        getSessionSnapshot: () => ({ sessions: mockSnapshot }),
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.sessions.length, 1);
      assert.equal(parsed.sessions[0].displayName, "Active Desk · Pi");
      assert.equal(parsed.sessions[0].host, "local");
    }
  });

  test("rejects catalog request with wrong capability token (403)", async () => {
    const { registry, handleStore, mockSnapshot } = setupCatalogFixtures();
    const { res, result } = createMockRes();

    const req = createMockReq({
      url: "/pet-peer/catalog",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "peer_catalog_query",
        rawSessionId: "caller-sess",
        capabilityToken: generateToken(), // Wrong token
      }),
    });

    handlePetPeerCatalogPost(req, res, {
      remoteProfile: null,
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      getSessionSnapshot: () => ({ sessions: mockSnapshot }),
    });

    await result.done;
    assert.equal(result.statusCode, 403);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "rejected");
    assert.match(parsed.reason, /invalid or expired capability token/i);
  });

  test("rejects catalog request with unknown properties or invalid request kind (400)", async () => {
    const { registry, handleStore, mockSnapshot } = setupCatalogFixtures();

    // Unknown property
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/catalog",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_catalog_query",
          rawSessionId: "caller-sess",
          capabilityToken: tokenCaller,
          unknownField: "malicious",
        }),
      });

      handlePetPeerCatalogPost(req, res, {
        remoteProfile: null,
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        getSessionSnapshot: () => ({ sessions: mockSnapshot }),
      });

      await result.done;
      assert.equal(result.statusCode, 400);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "rejected");
      assert.match(parsed.reason, /Unknown property: "unknownField"/i);
    }

    // Invalid kind (peer_catalog instead of peer_catalog_query)
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/catalog",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_catalog",
          rawSessionId: "caller-sess",
          capabilityToken: tokenCaller,
        }),
      });

      handlePetPeerCatalogPost(req, res, {
        remoteProfile: null,
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        getSessionSnapshot: () => ({ sessions: mockSnapshot }),
      });

      await result.done;
      assert.equal(result.statusCode, 400);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "rejected");
      assert.match(parsed.reason, /kind must be 'peer_catalog_query'/i);
    }
  });
});

describe("Send Route (POST /pet-peer/send)", () => {
  const tokenSender = generateToken();
  const tokenReceiver = generateToken();

  function setupSendFixtures() {
    const registry = createPetPeerCapabilityRegistry();
    const handleStore = createPetPeerHandleStore();
    const rateLimiter = createPeerSendRateLimiter();

    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "sender-sess", token: tokenSender });
    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "receiver-sess", token: tokenReceiver });

    const mockSnapshot = [
      {
        id: "sender-sess",
        profileId: "local",
        rawSessionId: "sender-sess",
        agentId: "pi",
        displayTitle: "Sender",
        sourceDisplayLabel: "local",
        state: "idle",
      },
      {
        id: "receiver-sess",
        profileId: "local",
        rawSessionId: "receiver-sess",
        agentId: "pi",
        displayTitle: "Receiver",
        sourceDisplayLabel: "local",
        state: "idle",
      },
    ];

    return { registry, handleStore, rateLimiter, mockSnapshot };
  }

  test("successful hop 0 send authors coordinator metadata, creates reply handle, calls sync enqueue, and returns sanitized response", async () => {
    const { registry, handleStore, rateLimiter, mockSnapshot } = setupSendFixtures();
    const nowMs = 1757419200000;

    // Create a catalog handle from sender to receiver
    const { handle: catalogHandle } = handleStore.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "sender-sess" },
      callerGeneration: 1,
      target: { profileId: "local", agentId: "pi", rawSessionId: "receiver-sess", displayName: "Receiver", host: "local" },
      targetGeneration: 2,
      nowMs,
    });

    let enqueuedArgs = null;
    const fakeEnqueueSync = (args) => {
      enqueuedArgs = args;
      return {
        schemaVersion: "1",
        kind: "peer_message",
        messageId: args.messageId,
        dedupKey: args.dedupKey,
        targetPetId: args.targetPetId,
        sourcePetId: args.sourcePetId,
        status: "queued",
        threadId: args.threadId,
        hopCount: args.hopCount,
        maxHops: args.maxHops,
        replyHandle: args.replyHandle,
        createdAtMs: args.createdAtMs,
        expiresAtMs: args.createdAtMs + args.ttlMs,
      };
    };

    const fakeDerivePetId = ({ profileId, rawSessionId }) => `pet_${profileId}_${rawSessionId}`;

    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-peer/send",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "peer_send",
        rawSessionId: "sender-sess",
        capabilityToken: tokenSender,
        target: catalogHandle,
        text: "Hello peer, tests are passing!",
      }),
    });

    handlePetPeerSendPost(req, res, {
      remoteProfile: null,
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      peerSendRateLimiter: rateLimiter,
      getSessionSnapshot: () => ({ sessions: mockSnapshot }),
      enqueuePeerMessage: fakeEnqueueSync,
      derivePetId: fakeDerivePetId,
      now: () => nowMs,
    });

    await result.done;
    assert.equal(result.statusCode, 202);
    assert.equal(result.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);

    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "queued");
    assert.equal(parsed.hopCount, 0);
    assert.equal(parsed.maxHops, 1);
    assert.ok(parsed.threadId.startsWith("thr_"));

    // Verify sanitized response strictly omits sensitive fields
    assert.equal(parsed.replyHandle, undefined, "Agent-facing send response MUST NOT return replyHandle");
    assert.equal(parsed.sourcePetId, undefined, "send response MUST NOT return sourcePetId");
    assert.equal(parsed.targetPetId, undefined, "send response MUST NOT return targetPetId");
    assert.equal(parsed.dedupKey, undefined, "send response MUST NOT return dedupKey");
    assert.equal(parsed.text, undefined, "send response MUST NOT return text/payloadEcho");

    // Verify coordinator authored all parameters passed to runtime
    assert.ok(enqueuedArgs);
    assert.equal(enqueuedArgs.targetPetId, "pet_local_receiver-sess");
    assert.equal(enqueuedArgs.sourcePetId, "pet_local_sender-sess");
    assert.equal(enqueuedArgs.sourceDisplayName, "Sender · Pi");
    assert.equal(enqueuedArgs.sourceHost, "local");
    assert.equal(enqueuedArgs.text, "Hello peer, tests are passing!");
    assert.equal(enqueuedArgs.deliverAs, "followUp");
    assert.equal(enqueuedArgs.hopCount, 0);
    assert.equal(enqueuedArgs.maxHops, 1);
    assert.equal(enqueuedArgs.ttlMs, 60000);
    assert.ok(enqueuedArgs.replyHandle.startsWith("psh_"));

    // Catalog handle is now consumed / single-use
    assert.equal(handleStore.resolveAndConsumeHandle(catalogHandle).ok, false);
  });

  test("successful hop 1 reply send continues thread and creates NO further reply handle", async () => {
    const { registry, handleStore, rateLimiter, mockSnapshot } = setupSendFixtures();
    const nowMs = 1757419200000;

    // 1. Initial Hop 0 send
    const { handle: catalogHandle } = handleStore.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "sender-sess" },
      callerGeneration: 1,
      target: { profileId: "local", agentId: "pi", rawSessionId: "receiver-sess", displayName: "Receiver", host: "local" },
      targetGeneration: 2,
      nowMs,
    });

    const fakeDerivePetId = ({ profileId, rawSessionId }) => `pet_${profileId}_${rawSessionId}`;
    let hop0ReplyHandle = null;
    let initialThreadId = null;

    {
      let capturedHop0Args = null;
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/send",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_send",
          rawSessionId: "sender-sess",
          capabilityToken: tokenSender,
          target: catalogHandle,
          text: "Initial message from sender",
        }),
      });

      handlePetPeerSendPost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        peerSendRateLimiter: rateLimiter,
        getSessionSnapshot: () => ({ sessions: mockSnapshot }),
        enqueuePeerMessage: (args) => {
          capturedHop0Args = args;
          return {
            status: "queued",
            threadId: args.threadId,
            hopCount: args.hopCount,
            maxHops: args.maxHops,
            replyHandle: args.replyHandle,
          };
        },
        derivePetId: fakeDerivePetId,
        now: () => nowMs,
      });

      await result.done;
      assert.equal(result.statusCode, 202);
      const parsed = JSON.parse(result.body);
      initialThreadId = parsed.threadId;

      // Obtain replyHandle from captured hop0 enqueue args, NOT from response
      assert.equal(parsed.replyHandle, undefined);
      assert.ok(capturedHop0Args && capturedHop0Args.replyHandle);
      hop0ReplyHandle = capturedHop0Args.replyHandle;
    }

    // 2. Receiver uses reply handle to reply back to sender (Hop 1)
    let hop1EnqueuedArgs = null;
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/send",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_send",
          rawSessionId: "receiver-sess",
          capabilityToken: tokenReceiver,
          target: hop0ReplyHandle,
          text: "Reply back to sender",
        }),
      });

      handlePetPeerSendPost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        peerSendRateLimiter: rateLimiter,
        getSessionSnapshot: () => ({ sessions: mockSnapshot }),
        enqueuePeerMessage: (args) => {
          hop1EnqueuedArgs = args;
          return {
            status: "queued",
            threadId: args.threadId,
            hopCount: args.hopCount,
            maxHops: args.maxHops,
            replyHandle: args.replyHandle,
          };
        },
        derivePetId: fakeDerivePetId,
        now: () => nowMs + 1000,
      });

      await result.done;
      assert.equal(result.statusCode, 202);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "queued");
      assert.equal(parsed.hopCount, 1);
      assert.equal(parsed.maxHops, 1);
      assert.equal(parsed.threadId, initialThreadId);
      assert.equal(parsed.replyHandle, undefined, "Hop 1 must NOT create any further reply handle");

      assert.ok(hop1EnqueuedArgs);
      assert.equal(hop1EnqueuedArgs.threadId, initialThreadId);
      assert.equal(hop1EnqueuedArgs.hopCount, 1);
      assert.equal(hop1EnqueuedArgs.maxHops, 1);
      assert.equal(hop1EnqueuedArgs.replyHandle, undefined);
      assert.equal(hop1EnqueuedArgs.targetPetId, "pet_local_sender-sess");
      assert.equal(hop1EnqueuedArgs.sourcePetId, "pet_local_receiver-sess");
    }

    // 3. Re-using reply handle fails
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/send",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_send",
          rawSessionId: "receiver-sess",
          capabilityToken: tokenReceiver,
          target: hop0ReplyHandle,
          text: "Trying second reply",
        }),
      });

      handlePetPeerSendPost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        peerSendRateLimiter: rateLimiter,
        getSessionSnapshot: () => ({ sessions: mockSnapshot }),
        enqueuePeerMessage: () => ({ status: "queued" }),
        derivePetId: fakeDerivePetId,
        now: () => nowMs + 2000,
      });

      await result.done;
      assert.equal(result.statusCode, 422);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "rejected");
      assert.match(parsed.reason, /invalid handle/i);
    }
  });

  test("rejects self-send attempts", async () => {
    const { registry, handleStore, rateLimiter, mockSnapshot } = setupSendFixtures();
    const nowMs = 1757419200000;

    // Handle pointing to same caller
    const { handle } = handleStore.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "sender-sess" },
      callerGeneration: 1,
      target: { profileId: "local", agentId: "pi", rawSessionId: "sender-sess", displayName: "Sender", host: "local" },
      targetGeneration: 1,
      nowMs,
    });

    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-peer/send",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "peer_send",
        rawSessionId: "sender-sess",
        capabilityToken: tokenSender,
        target: handle,
        text: "Talking to myself",
      }),
    });

    handlePetPeerSendPost(req, res, {
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      peerSendRateLimiter: rateLimiter,
      getSessionSnapshot: () => ({ sessions: mockSnapshot }),
      enqueuePeerMessage: () => ({ status: "queued" }),
      derivePetId: () => "pet_123",
      now: () => nowMs,
    });

    await result.done;
    assert.equal(result.statusCode, 422);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "rejected");
    assert.match(parsed.reason, /self-send forbidden/i);
  });

  test("send fails closed if getSessionSnapshot is missing or throws", async () => {
    const { registry, handleStore, rateLimiter } = setupSendFixtures();
    const nowMs = 1757419200000;

    const { handle: h1 } = handleStore.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "sender-sess" },
      callerGeneration: 1,
      target: { profileId: "local", agentId: "pi", rawSessionId: "receiver-sess", displayName: "Receiver", host: "local" },
      targetGeneration: 2,
      nowMs,
    });

    // 1. Missing getSessionSnapshot -> 503
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/send",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_send",
          rawSessionId: "sender-sess",
          capabilityToken: tokenSender,
          target: h1,
          text: "Snapshot test",
        }),
      });

      handlePetPeerSendPost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        peerSendRateLimiter: rateLimiter,
        enqueuePeerMessage: () => ({ status: "queued" }),
        derivePetId: () => "pet_123",
        now: () => nowMs,
      });

      await result.done;
      assert.equal(result.statusCode, 503);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "failed");
      assert.match(parsed.reason, /session snapshot unavailable/i);
    }

    // 2. getSessionSnapshot throws -> 500
    const { handle: h2 } = handleStore.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "sender-sess" },
      callerGeneration: 1,
      target: { profileId: "local", agentId: "pi", rawSessionId: "receiver-sess", displayName: "Receiver", host: "local" },
      targetGeneration: 2,
      nowMs,
    });

    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/send",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_send",
          rawSessionId: "sender-sess",
          capabilityToken: tokenSender,
          target: h2,
          text: "Snapshot test throws",
        }),
      });

      handlePetPeerSendPost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        peerSendRateLimiter: rateLimiter,
        getSessionSnapshot: () => { throw new Error("snapshot retrieval failed"); },
        enqueuePeerMessage: () => ({ status: "queued" }),
        derivePetId: () => "pet_123",
        now: () => nowMs,
      });

      await result.done;
      assert.equal(result.statusCode, 500);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "failed");
      assert.match(parsed.reason, /failed to retrieve session snapshot/i);
    }
  });

  test("send fails closed if caller or target snapshot entry is absent, ineligible, or non-Pi", async () => {
    const { registry, handleStore, rateLimiter } = setupSendFixtures();
    const nowMs = 1757419200000;

    // 1. Target session absent from snapshot (capability alone is not enough)
    {
      const { handle } = handleStore.createCatalogHandle({
        caller: { profileId: "local", agentId: "pi", rawSessionId: "sender-sess" },
        callerGeneration: 1,
        target: { profileId: "local", agentId: "pi", rawSessionId: "receiver-sess", displayName: "Receiver", host: "local" },
        targetGeneration: 2,
        nowMs,
      });

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/send",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_send",
          rawSessionId: "sender-sess",
          capabilityToken: tokenSender,
          target: handle,
          text: "Where are you?",
        }),
      });

      handlePetPeerSendPost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        peerSendRateLimiter: rateLimiter,
        getSessionSnapshot: () => ({ sessions: [{ id: "sender-sess", profileId: "local", rawSessionId: "sender-sess", agentId: "pi", state: "idle" }] }), // Target absent
        enqueuePeerMessage: () => ({ status: "queued" }),
        derivePetId: () => "pet_123",
        now: () => nowMs,
      });

      await result.done;
      assert.equal(result.statusCode, 422);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "rejected");
      assert.match(parsed.reason, /target session is inactive, closed, or not found/i);
    }

    // 2. Target is non-Pi (e.g. claude-code)
    {
      const { handle } = handleStore.createCatalogHandle({
        caller: { profileId: "local", agentId: "pi", rawSessionId: "sender-sess" },
        callerGeneration: 1,
        target: { profileId: "local", agentId: "pi", rawSessionId: "receiver-sess", displayName: "Receiver", host: "local" },
        targetGeneration: 2,
        nowMs,
      });

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/send",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_send",
          rawSessionId: "sender-sess",
          capabilityToken: tokenSender,
          target: handle,
          text: "Non-pi target",
        }),
      });

      handlePetPeerSendPost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        peerSendRateLimiter: rateLimiter,
        getSessionSnapshot: () => ({
          sessions: [
            { id: "sender-sess", profileId: "local", rawSessionId: "sender-sess", agentId: "pi", state: "idle" },
            { id: "receiver-sess", profileId: "local", rawSessionId: "receiver-sess", agentId: "claude-code", state: "idle" },
          ],
        }),
        enqueuePeerMessage: () => ({ status: "queued" }),
        derivePetId: () => "pet_123",
        now: () => nowMs,
      });

      await result.done;
      assert.equal(result.statusCode, 422);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "rejected");
      assert.match(parsed.reason, /target session is inactive, closed, or not found/i);
    }

    // 3. Caller is sleeping / inactive
    {
      const { handle } = handleStore.createCatalogHandle({
        caller: { profileId: "local", agentId: "pi", rawSessionId: "sender-sess" },
        callerGeneration: 1,
        target: { profileId: "local", agentId: "pi", rawSessionId: "receiver-sess", displayName: "Receiver", host: "local" },
        targetGeneration: 2,
        nowMs,
      });

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/send",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_send",
          rawSessionId: "sender-sess",
          capabilityToken: tokenSender,
          target: handle,
          text: "I am sleeping",
        }),
      });

      handlePetPeerSendPost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        peerSendRateLimiter: rateLimiter,
        getSessionSnapshot: () => ({
          sessions: [
            { id: "sender-sess", profileId: "local", rawSessionId: "sender-sess", agentId: "pi", state: "sleeping" },
            { id: "receiver-sess", profileId: "local", rawSessionId: "receiver-sess", agentId: "pi", state: "idle" },
          ],
        }),
        enqueuePeerMessage: () => ({ status: "queued" }),
        derivePetId: () => "pet_123",
        now: () => nowMs,
      });

      await result.done;
      assert.equal(result.statusCode, 422);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "rejected");
      assert.match(parsed.reason, /caller session is inactive, closed, or ineligible/i);
    }
  });

  test("rejects Promise return from synchronous enqueuePeerMessage and records rate only on queued/dispatched", async () => {
    const { registry, handleStore, rateLimiter, mockSnapshot } = setupSendFixtures();
    const nowMs = 1757419200000;

    const { handle } = handleStore.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "sender-sess" },
      callerGeneration: 1,
      target: { profileId: "local", agentId: "pi", rawSessionId: "receiver-sess", displayName: "Receiver", host: "local" },
      targetGeneration: 2,
      nowMs,
    });

    const fakeAsyncEnqueue = async () => ({ status: "queued" }); // Returns a Promise!

    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-peer/send",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "peer_send",
        rawSessionId: "sender-sess",
        capabilityToken: tokenSender,
        target: handle,
        text: "Promise test",
      }),
    });

    handlePetPeerSendPost(req, res, {
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      peerSendRateLimiter: rateLimiter,
      getSessionSnapshot: () => ({ sessions: mockSnapshot }),
      enqueuePeerMessage: fakeAsyncEnqueue,
      derivePetId: () => "pet_123",
      now: () => nowMs,
    });

    await result.done;
    assert.equal(result.statusCode, 500);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "failed");
    assert.match(parsed.reason, /must be synchronous/i);

    // Rate limiter must NOT have recorded this failed send
    const check = rateLimiter.check({ profileId: "local", agentId: "pi", rawSessionId: "sender-sess" }, nowMs);
    assert.equal(check.remaining, PEER_SEND_RATE_LIMIT_MAX);
  });

  test("rate limits 11th accepted send in rolling 60s with 429", async () => {
    const { registry, handleStore, rateLimiter, mockSnapshot } = setupSendFixtures();
    const nowMs = 1757419200000;
    const fakeDerivePetId = () => "pet_dummy";
    const fakeEnqueue = (args) => ({
      status: "queued",
      threadId: args.threadId,
      hopCount: args.hopCount,
      maxHops: args.maxHops,
    });

    // Perform 10 successful sends
    for (let i = 1; i <= 10; i++) {
      const { handle } = handleStore.createCatalogHandle({
        caller: { profileId: "local", agentId: "pi", rawSessionId: "sender-sess" },
        callerGeneration: 1,
        target: { profileId: "local", agentId: "pi", rawSessionId: "receiver-sess", displayName: "Receiver", host: "local" },
        targetGeneration: 2,
        nowMs,
      });

      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/send",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_send",
          rawSessionId: "sender-sess",
          capabilityToken: tokenSender,
          target: handle,
          text: `Message ${i}`,
        }),
      });

      handlePetPeerSendPost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        peerSendRateLimiter: rateLimiter,
        getSessionSnapshot: () => ({ sessions: mockSnapshot }),
        enqueuePeerMessage: fakeEnqueue,
        derivePetId: fakeDerivePetId,
        now: () => nowMs,
      });

      await result.done;
      assert.equal(result.statusCode, 202);
    }

    // 11th send attempt within 60s is rate-limited
    const { handle: handle11 } = handleStore.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "sender-sess" },
      callerGeneration: 1,
      target: { profileId: "local", agentId: "pi", rawSessionId: "receiver-sess", displayName: "Receiver", host: "local" },
      targetGeneration: 2,
      nowMs,
    });

    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-peer/send",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "peer_send",
        rawSessionId: "sender-sess",
        capabilityToken: tokenSender,
        target: handle11,
        text: "Message 11 attempt",
      }),
    });

    handlePetPeerSendPost(req, res, {
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      peerSendRateLimiter: rateLimiter,
      getSessionSnapshot: () => ({ sessions: mockSnapshot }),
      enqueuePeerMessage: fakeEnqueue,
      derivePetId: fakeDerivePetId,
      now: () => nowMs,
    });

    await result.done;
    assert.equal(result.statusCode, 429);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "rejected");
    assert.match(parsed.reason, /rate limit exceeded/i);
    assert.ok(parsed.retryAfterMs > 0);
  });

  test("returns 503 when peer runtime is not configured or unavailable", async () => {
    const { registry, handleStore, rateLimiter, mockSnapshot } = setupSendFixtures();
    const nowMs = 1757419200000;

    const { handle } = handleStore.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "sender-sess" },
      callerGeneration: 1,
      target: { profileId: "local", agentId: "pi", rawSessionId: "receiver-sess", displayName: "Receiver", host: "local" },
      targetGeneration: 2,
      nowMs,
    });

    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-peer/send",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "peer_send",
        rawSessionId: "sender-sess",
        capabilityToken: tokenSender,
        target: handle,
        text: "Runtime test",
      }),
    });

    handlePetPeerSendPost(req, res, {
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      peerSendRateLimiter: rateLimiter,
      getSessionSnapshot: () => ({ sessions: mockSnapshot }),
      env: {}, // No runtime
      now: () => nowMs,
    });

    await result.done;
    assert.equal(result.statusCode, 503);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "failed");
    assert.match(parsed.reason, /peer runtime not configured/i);
  });
});

describe("Unicode Boundary & Validation Constraints", () => {
  test("isValidPeerRawSessionId strictly validates raw session id and rejects trimmed default, pi:, pi:default", () => {
    assert.equal(isValidPeerRawSessionId("session-1"), true);
    assert.equal(isValidPeerRawSessionId("sess_abc-123"), true);
    assert.equal(isValidPeerRawSessionId("a".repeat(4096)), true);

    // Reject default patterns
    assert.equal(isValidPeerRawSessionId("default"), false);
    assert.equal(isValidPeerRawSessionId(" default "), false);
    assert.equal(isValidPeerRawSessionId("pi:"), false);
    assert.equal(isValidPeerRawSessionId("  pi:  "), false);
    assert.equal(isValidPeerRawSessionId("pi:default"), false);
    assert.equal(isValidPeerRawSessionId(" pi:default "), false);

    // Reject non-strings and empty/whitespace/control characters
    assert.equal(isValidPeerRawSessionId(""), false);
    assert.equal(isValidPeerRawSessionId("   "), false);
    assert.equal(isValidPeerRawSessionId(null), false);
    assert.equal(isValidPeerRawSessionId(undefined), false);
    assert.equal(isValidPeerRawSessionId(123), false);
    assert.equal(isValidPeerRawSessionId("sess\n1"), false);
    assert.equal(isValidPeerRawSessionId("sess\r1"), false);
    assert.equal(isValidPeerRawSessionId("sess\x001"), false);
    assert.equal(isValidPeerRawSessionId("a".repeat(4097)), false);
  });

  test("validators reject default, pi:, and pi:default rawSessionId values", () => {
    const defaultIds = ["default", " default ", "pi:", "  pi:  ", "pi:default", " pi:default "];
    for (const sid of defaultIds) {
      assert.equal(validatePetPeerCatalogPayload({
        schemaVersion: "1",
        kind: "peer_catalog_query",
        rawSessionId: sid,
        capabilityToken: generateToken(),
      }).ok, false, `Catalog query must reject rawSessionId "${sid}"`);

      assert.equal(validatePetPeerSendPayload({
        schemaVersion: "1",
        kind: "peer_send",
        rawSessionId: sid,
        capabilityToken: generateToken(),
        target: "psh_target_123",
        text: "hello",
      }).ok, false, `Send payload must reject rawSessionId "${sid}"`);

      assert.equal(validatePetPeerClaimPayload({
        schemaVersion: "1",
        kind: "peer_message_claim",
        rawSessionId: sid,
        capabilityToken: generateToken(),
      }).ok, false, `Claim payload must reject rawSessionId "${sid}"`);

      assert.equal(validatePetPeerSettlePayload({
        schemaVersion: "1",
        kind: "peer_message_settle",
        rawSessionId: sid,
        capabilityToken: generateToken(),
        messageId: "msg_123",
        claimToken: "tok_123",
        status: "dispatched",
      }).ok, false, `Settle payload must reject rawSessionId "${sid}"`);

      assert.equal(validatePetPeerReceiptQueryPayload({
        schemaVersion: "1",
        kind: "peer_message_receipt_query",
        rawSessionId: sid,
        capabilityToken: generateToken(),
        messageId: "msg_123",
      }).ok, false, `Receipt query payload must reject rawSessionId "${sid}"`);
    }
  });

  test("countUnicodeCodePoints accurately counts astral emojis, CJK, and ASCII characters", () => {
    assert.equal(countUnicodeCodePoints(""), 0);
    assert.equal(countUnicodeCodePoints("hello"), 5);
    assert.equal(countUnicodeCodePoints("😀"), 1); // 1 code point, 2 UTF-16 units
    assert.equal(countUnicodeCodePoints("🐱🐾✨"), 3);
    assert.equal(countUnicodeCodePoints("会话测试"), 4);
    assert.equal(countUnicodeCodePoints("a🐱b"), 3);
  });

  test("send payload validation strictly enforces 1..2000 Unicode code points boundary", () => {
    const token = generateToken();

    // 2000 emoji code points -> valid
    const emoji2000 = "🐱".repeat(2000);
    assert.equal(countUnicodeCodePoints(emoji2000), 2000);
    assert.equal(validatePetPeerSendPayload({
      schemaVersion: "1",
      kind: "peer_send",
      rawSessionId: "sess-1",
      capabilityToken: token,
      target: "psh_validhandle123",
      text: emoji2000,
    }).ok, true);

    // 2001 emoji code points -> rejected
    const emoji2001 = "🐱".repeat(2001);
    assert.equal(countUnicodeCodePoints(emoji2001), 2001);
    assert.equal(validatePetPeerSendPayload({
      schemaVersion: "1",
      kind: "peer_send",
      rawSessionId: "sess-1",
      capabilityToken: token,
      target: "psh_validhandle123",
      text: emoji2001,
    }).ok, false);

    // 0 code points (empty string) -> rejected
    assert.equal(validatePetPeerSendPayload({
      schemaVersion: "1",
      kind: "peer_send",
      rawSessionId: "sess-1",
      capabilityToken: token,
      target: "psh_validhandle123",
      text: "",
    }).ok, false);

    // 2000 ASCII chars -> valid
    assert.equal(validatePetPeerSendPayload({
      schemaVersion: "1",
      kind: "peer_send",
      rawSessionId: "sess-1",
      capabilityToken: token,
      target: "psh_validhandle123",
      text: "a".repeat(2000),
    }).ok, true);

    // 2001 ASCII chars -> rejected
    assert.equal(validatePetPeerSendPayload({
      schemaVersion: "1",
      kind: "peer_send",
      rawSessionId: "sess-1",
      capabilityToken: token,
      target: "psh_validhandle123",
      text: "a".repeat(2001),
    }).ok, false);
  });

  test("settle payload validation strictly enforces max 1024 Unicode code points for reason", () => {
    const token = generateToken();

    // 1024 emoji code points -> valid
    const reason1024 = "🐱".repeat(1024);
    assert.equal(countUnicodeCodePoints(reason1024), 1024);
    assert.equal(validatePetPeerSettlePayload({
      schemaVersion: "1",
      kind: "peer_message_settle",
      rawSessionId: "sess-1",
      capabilityToken: token,
      messageId: "msg_1",
      claimToken: "tok_1",
      status: "failed",
      reason: reason1024,
    }).ok, true);

    // 1025 emoji code points -> rejected
    const reason1025 = "🐱".repeat(1025);
    assert.equal(countUnicodeCodePoints(reason1025), 1025);
    assert.equal(validatePetPeerSettlePayload({
      schemaVersion: "1",
      kind: "peer_message_settle",
      rawSessionId: "sess-1",
      capabilityToken: token,
      messageId: "msg_1",
      claimToken: "tok_1",
      status: "failed",
      reason: reason1025,
    }).ok, false);
  });

  test("send payload validation rejects extra/forbidden properties", () => {
    const token = generateToken();

    const forbiddenFields = [
      { profileId: "remote" },
      { threadId: "thr_custom" },
      { hopCount: 0 },
      { maxHops: 1 },
      { messageId: "msg_custom" },
      { ttlMs: 1000 },
      { deliverAs: "followUp" },
      { extra: "unknown" },
    ];

    for (const extra of forbiddenFields) {
      const payload = {
        schemaVersion: "1",
        kind: "peer_send",
        rawSessionId: "sess-1",
        capabilityToken: token,
        target: "psh_abc123",
        text: "hello",
        ...extra,
      };
      assert.equal(validatePetPeerSendPayload(payload).ok, false, `Payload with ${Object.keys(extra)[0]} must be rejected`);
    }
  });

  test("sanitization helpers format bounded displayName as <title> · Pi without double suffix", () => {
    assert.equal(sanitizeDisplayName("Desk"), "Desk · Pi");
    assert.equal(sanitizeDisplayName("Desk · Pi"), "Desk · Pi");
    assert.equal(sanitizeDisplayName("Desk · Pi · Pi"), "Desk · Pi");
    assert.equal(sanitizeDisplayName("Desk•Pi"), "Desk · Pi");
    assert.equal(sanitizeDisplayName("Pi"), "Pi");
    assert.equal(sanitizeDisplayName(""), "Pi");
    assert.equal(sanitizeDisplayName(null), "Pi");

    // Bounded total length
    const longTitle = "a".repeat(200);
    const formattedLong = sanitizeDisplayName(longTitle);
    assert.equal(countUnicodeCodePoints(formattedLong), 120);
    assert.ok(formattedLong.endsWith(" · Pi"));

    // Host sanitization
    assert.equal(sanitizeHost("  ssh-server\t\n  "), "ssh-server");
    assert.equal(sanitizeState("  IDLE\0  "), "idle");

    // Inactive state detector
    assert.equal(isInactiveState("sleeping"), true);
    assert.equal(isInactiveState("dozing"), true);
    assert.equal(isInactiveState("offline"), true);
    assert.equal(isInactiveState("closed"), true);
    assert.equal(isInactiveState("idle"), false);
    assert.equal(isInactiveState("running"), false);
    assert.equal(isInactiveState("thinking"), false);
  });
});

describe("Claim, Settle, and Receipt Wire Routes", () => {
  const token = generateToken();

  test("claim route returns claimed peer message with exact fields omitting internal IDs and raw message", async () => {
    const registry = createPetPeerCapabilityRegistry();
    registry.registerCapability({ profileId: "remote-worker", agentId: "pi", rawSessionId: "sess-claim", token });

    // Claim empty
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/claim",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_message_claim",
          rawSessionId: "sess-claim",
          capabilityToken: token,
        }),
      });

      handlePetPeerClaimPost(req, res, {
        remoteProfile: { profileId: "remote-worker" },
        peerCapabilityRegistry: registry,
        derivePetId: () => "pet_target",
        claimNextPeerMessage: () => null,
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      assert.deepEqual(JSON.parse(result.body), { status: "empty" });
    }

    // Claim found
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/claim",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_message_claim",
          rawSessionId: "sess-claim",
          capabilityToken: token,
        }),
      });

      const stubClaim = {
        schemaVersion: "1",
        kind: "peer_message",
        messageId: "msg_claim_1",
        dedupKey: "msg_claim_1",
        targetPetId: "pet_target",
        sourcePetId: "pet_source",
        sourceDisplayName: "Sender · Pi",
        sourceHost: "local",
        text: "Note to peer",
        deliverAs: "followUp",
        threadId: "thr_1",
        hopCount: 0,
        maxHops: 1,
        replyHandle: "psh_reply123",
        createdAtMs: 1757419200000,
        expiresAtMs: 1757419260000,
        claimToken: "claim_tok_1",
        claimedAtMs: 1757419200100,
        message: {
          raw: "secret_raw_message_must_be_omitted",
        },
      };

      handlePetPeerClaimPost(req, res, {
        remoteProfile: { profileId: "remote-worker" },
        peerCapabilityRegistry: registry,
        derivePetId: () => "pet_target",
        claimNextPeerMessage: () => stubClaim,
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "claimed");
      assert.equal(parsed.messageId, "msg_claim_1");
      assert.equal(parsed.replyHandle, "psh_reply123");
      assert.equal(parsed.sourceDisplayName, "Sender · Pi");

      // Assert forbidden keys are strictly omitted from claim response
      assert.equal(parsed.sourcePetId, undefined, "claim response must NOT include sourcePetId");
      assert.equal(parsed.targetPetId, undefined, "claim response must NOT include targetPetId");
      assert.equal(parsed.dedupKey, undefined, "claim response must NOT include dedupKey");
      assert.equal(parsed.message, undefined, "claim response must NOT include nested raw message");

      const expectedExactKeys = [
        "claimToken",
        "claimedAtMs",
        "createdAtMs",
        "deliverAs",
        "expiresAtMs",
        "hopCount",
        "kind",
        "maxHops",
        "messageId",
        "replyHandle",
        "schemaVersion",
        "sourceDisplayName",
        "sourceHost",
        "status",
        "text",
        "threadId",
      ];
      assert.deepEqual(Object.keys(parsed).sort(), expectedExactKeys);
    }
  });

  test("settle route returns sanitized receipt on dispatched status", async () => {
    const registry = createPetPeerCapabilityRegistry();
    registry.registerCapability({ profileId: "remote-worker", agentId: "pi", rawSessionId: "sess-settle", token });

    const stubReceipt = {
      schemaVersion: "1",
      kind: "peer_message",
      messageId: "msg_settle_1",
      dedupKey: "msg_settle_1",
      targetPetId: "pet_target",
      sourcePetId: "pet_source",
      status: "dispatched",
      reason: null,
    };

    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-peer/settle",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "peer_message_settle",
        rawSessionId: "sess-settle",
        capabilityToken: token,
        messageId: "msg_settle_1",
        claimToken: "claim_tok_1",
        status: "dispatched",
      }),
    });

    handlePetPeerSettlePost(req, res, {
      remoteProfile: { profileId: "remote-worker" },
      peerCapabilityRegistry: registry,
      derivePetId: () => "pet_target",
      settlePeerMessage: () => stubReceipt,
    });

    await result.done;
    assert.equal(result.statusCode, 200);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "dispatched");
    assert.equal(parsed.messageId, "msg_settle_1");
    assert.equal(parsed.sourcePetId, undefined);
    assert.equal(parsed.targetPetId, undefined);
    assert.equal(parsed.dedupKey, undefined);
  });

  test("receipt query returns sanitized receipt omitting pet IDs or 404", async () => {
    const registry = createPetPeerCapabilityRegistry();
    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "sess-rcpt", token });

    const stubReceipt = {
      schemaVersion: "1",
      kind: "peer_message",
      messageId: "msg_rcpt_1",
      sourcePetId: "pet_local_sess-rcpt",
      targetPetId: "pet_local_sess-target",
      replyHandle: "psh_secret",
      status: "dispatched",
    };

    // Found
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/receipt",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_message_receipt_query",
          rawSessionId: "sess-rcpt",
          capabilityToken: token,
          messageId: "msg_rcpt_1",
        }),
      });

      handlePetPeerReceiptPost(req, res, {
        peerCapabilityRegistry: registry,
        derivePetId: () => "pet_local_sess-rcpt",
        getPeerMessageReceipt: () => stubReceipt,
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "dispatched");
      assert.equal(parsed.messageId, "msg_rcpt_1");
      assert.equal(parsed.sourcePetId, undefined, "receipt query MUST NOT return sourcePetId");
      assert.equal(parsed.targetPetId, undefined, "receipt query MUST NOT return targetPetId");
      assert.equal(parsed.replyHandle, undefined, "receipt query MUST NOT return replyHandle");
    }

    // Not found
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-peer/receipt",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_message_receipt_query",
          rawSessionId: "sess-rcpt",
          capabilityToken: token,
          messageId: "msg_rcpt_missing",
        }),
      });

      handlePetPeerReceiptPost(req, res, {
        peerCapabilityRegistry: registry,
        derivePetId: () => "pet_local_sess-rcpt",
        getPeerMessageReceipt: () => null,
      });

      await result.done;
      assert.equal(result.statusCode, 404);
      assert.deepEqual(JSON.parse(result.body), { status: "not_found" });
    }
  });
});

describe("Response Size Enforcement (MAX_RESPONSE_BYTES)", () => {
  test("sendJsonResponse sends 500 when response exceeds 64KiB and avoids double-send", () => {
    const { res, result } = createMockRes();

    // Oversized payload > 64 KiB
    const oversizedPayload = {
      data: "x".repeat(MAX_RESPONSE_BYTES + 100),
    };

    sendJsonResponse(res, 200, oversizedPayload);
    assert.equal(result.statusCode, 500);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "failed");
    assert.match(parsed.reason, /response payload too large/i);
    assert.ok(Buffer.byteLength(result.body, "utf8") < 1024);

    // Subsequent call does not double-send
    sendJsonResponse(res, 200, { data: "second" });
    assert.equal(result.statusCode, 500);
  });
});
