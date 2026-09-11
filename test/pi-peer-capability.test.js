"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const core = require("../hooks/pi-extension-core");

function makeCtx(overrides = {}) {
  return {
    hasUI: true,
    cwd: "/home/user/project",
    sessionManager: {
      getSessionId: () => "session-peer-1",
    },
    ...overrides,
  };
}

function makeRemoteIdentity(overrides = {}) {
  return {
    ok: true,
    version: 2,
    layoutVersion: 1,
    runtimeKey: "account-default",
    profileId: "remote-pi-peer",
    installId: "a".repeat(64),
    remotePort: 23337,
    routingNonce: "b".repeat(32),
    deployedAt: 1000,
    ...overrides,
  };
}

describe("Pi Peer Capability Producer and Shared Slot", () => {
  it("local SessionStart advertises exact injected token", async () => {
    const handlers = {};
    const pi = {
      on(event, fn) { handlers[event] = fn; },
    };
    const posts = [];
    const fakeGlobal = {};
    const token = "a1".repeat(32);

    const attachResult = core.attach(pi, {
      globalObject: fakeGlobal,
      peerCapabilityToken: token,
      shouldReport: () => true,
      postState: async (payload) => {
        posts.push(payload);
        return true;
      },
    });

    assert.ok(core.PEER_CAPABILITY_SLOT_SYMBOL);
    assert.deepEqual(fakeGlobal[core.PEER_CAPABILITY_SLOT_SYMBOL], {
      version: 1,
      token,
    });
    assert.equal(Object.isFrozen(fakeGlobal[core.PEER_CAPABILITY_SLOT_SYMBOL]), true);

    handlers.session_start({ type: "session_start" }, makeCtx());
    attachResult.stopHeartbeat();

    assert.equal(posts.length, 1);
    assert.equal(posts[0].event, "SessionStart");
    assert.equal(posts[0].session_id, "pi:session-peer-1");
    assert.deepEqual(posts[0].pet_peer_capability, {
      version: 1,
      receivePeerMessage: true,
      token,
    });
    assert.equal(posts[0].pet_inbox_capability, undefined);
  });

  it("remote advertises both separate user inbox and peer capability", async () => {
    const handlers = {};
    const pi = {
      on(event, fn) { handlers[event] = fn; },
    };
    const posts = [];
    const inboxToken = "11".repeat(32);
    const peerToken = "22".repeat(32);

    const attachResult = core.attach(pi, {
      remoteIdentity: makeRemoteIdentity(),
      capabilityToken: inboxToken,
      peerCapabilityToken: peerToken,
      shouldReport: () => true,
      postState: async (payload) => {
        posts.push(payload);
        return true;
      },
      httpRequest: () => {
        const req = new (require("node:events").EventEmitter)();
        req.end = () => {};
        req.destroy = () => {};
        return req;
      },
    });

    handlers.session_start({ type: "session_start" }, makeCtx());
    attachResult.stopHeartbeat();
    if (attachResult.getInboxConsumer()) attachResult.getInboxConsumer().stop();

    assert.equal(posts.length >= 1, true);
    assert.deepEqual(posts[0].pet_inbox_capability, {
      version: 1,
      receiveUserMessage: true,
      token: inboxToken,
    });
    assert.deepEqual(posts[0].pet_peer_capability, {
      version: 1,
      receivePeerMessage: true,
      token: peerToken,
    });
    assert.notEqual(posts[0].pet_inbox_capability.token, posts[0].pet_peer_capability.token);
  });

  it("default session omits peer capability in buildPayload and attach sends", () => {
    const token = "33".repeat(32);

    // 1. Direct buildPayload with default session contexts
    const defaultCtx1 = makeCtx({ sessionManager: { getSessionId: () => "default" } });
    const payload1 = core.buildPayload({
      ctx: defaultCtx1,
      peerCapabilityToken: token,
    });
    assert.equal(payload1.session_id, "pi:default");
    assert.equal(payload1.pet_peer_capability, undefined);

    const defaultCtx2 = makeCtx({ sessionManager: { getSessionId: () => "pi:default" } });
    const payload2 = core.buildPayload({
      ctx: defaultCtx2,
      peerCapabilityToken: token,
    });
    assert.equal(payload2.session_id, "pi:default");
    assert.equal(payload2.pet_peer_capability, undefined);

    const defaultCtx3 = makeCtx({ sessionManager: { getSessionId: () => "pi:" } });
    const payload3 = core.buildPayload({
      ctx: defaultCtx3,
      peerCapabilityToken: token,
    });
    assert.equal(payload3.session_id, "pi:");
    assert.equal(payload3.pet_peer_capability, undefined);

    const defaultCtx4 = makeCtx({ sessionManager: { getSessionId: () => "" } });
    const payload4 = core.buildPayload({
      ctx: defaultCtx4,
      peerCapabilityToken: token,
    });
    assert.equal(payload4.session_id, "pi:default");
    assert.equal(payload4.pet_peer_capability, undefined);

    const emptyCtxPayload = core.buildPayload({
      ctx: {},
      peerCapabilityToken: token,
    });
    assert.equal(emptyCtxPayload.session_id, "pi:default");
    assert.equal(emptyCtxPayload.pet_peer_capability, undefined);

    // 2. Attach lifecycle sends with default session
    const handlers = {};
    const pi = { on(event, fn) { handlers[event] = fn; } };
    const posts = [];
    const attachResult = core.attach(pi, {
      peerCapabilityToken: token,
      shouldReport: () => true,
      postState: (payload) => { posts.push(payload); return true; },
    });

    handlers.session_start({ type: "session_start" }, defaultCtx1);
    attachResult.stopHeartbeat();

    assert.equal(posts.length, 1);
    assert.equal(posts[0].session_id, "pi:default");
    assert.equal(posts[0].pet_peer_capability, undefined);
  });

  it("heartbeat and real shutdown include peer token", async () => {
    const handlers = {};
    const pi = { on(event, fn) { handlers[event] = fn; } };
    const posts = [];
    let intervalCallback = null;
    const token = "44".repeat(32);

    const attachResult = core.attach(pi, {
      peerCapabilityToken: token,
      shouldReport: () => true,
      setInterval: (cb) => {
        intervalCallback = cb;
        return { unref() {} };
      },
      clearInterval: () => {},
      postState: async (payload) => {
        posts.push(payload);
        return true;
      },
    });

    const ctx = makeCtx();
    handlers.session_start({ type: "session_start" }, ctx);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].event, "SessionStart");
    assert.deepEqual(posts[0].pet_peer_capability, {
      version: 1,
      receivePeerMessage: true,
      token,
    });

    // Heartbeat
    intervalCallback();
    await Promise.resolve();
    assert.equal(posts.length, 2);
    assert.equal(posts[1].event, "SessionHeartbeat");
    assert.equal(posts[1].liveness_only, true);
    assert.deepEqual(posts[1].pet_peer_capability, {
      version: 1,
      receivePeerMessage: true,
      token,
    });

    // Mid-turn events: tool_call, tool_result, compact
    handlers.before_agent_start({ type: "before_agent_start" }, ctx);
    handlers.tool_call({ type: "tool_call", toolName: "read", toolCallId: "t-1" }, ctx);
    handlers.tool_result({ type: "tool_result", isError: false }, ctx);
    handlers.session_before_compact({ type: "session_before_compact" }, ctx);
    handlers.session_compact({ type: "session_compact" }, ctx);

    for (let i = 2; i < posts.length; i++) {
      assert.deepEqual(posts[i].pet_peer_capability, {
        version: 1,
        receivePeerMessage: true,
        token,
      });
    }

    // Real shutdown (quit)
    await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
    const lastPost = posts[posts.length - 1];
    assert.equal(lastPost.event, "SessionEnd");
    assert.equal(lastPost.state, "sleeping");
    assert.deepEqual(lastPost.pet_peer_capability, {
      version: 1,
      receivePeerMessage: true,
      token,
    });
  });

  it("reload sends no SessionEnd", async () => {
    const handlers = {};
    const pi = { on(event, fn) { handlers[event] = fn; } };
    const posts = [];
    const token = "55".repeat(32);

    const attachResult = core.attach(pi, {
      peerCapabilityToken: token,
      shouldReport: () => true,
      postState: async (payload) => {
        posts.push(payload);
        return true;
      },
    });

    const ctx = makeCtx();
    handlers.session_start({ type: "session_start" }, ctx);
    assert.equal(posts.length, 1);

    const reloadResult = await handlers.session_shutdown({ type: "session_shutdown", reason: "reload" }, ctx);
    assert.equal(reloadResult, false);
    // Post count unchanged: no SessionEnd sent
    assert.equal(posts.length, 1);
  });

  it("two attaches against same fake global rotate slot", () => {
    const fakeGlobal = {};
    const token1 = "66".repeat(32);
    const token2 = "77".repeat(32);

    const pi1 = { on() {} };
    const attach1 = core.attach(pi1, {
      globalObject: fakeGlobal,
      peerCapabilityToken: token1,
    });
    attach1.stopHeartbeat();

    assert.deepEqual(fakeGlobal[core.PEER_CAPABILITY_SLOT_SYMBOL], {
      version: 1,
      token: token1,
    });
    assert.equal(Object.isFrozen(fakeGlobal[core.PEER_CAPABILITY_SLOT_SYMBOL]), true);

    const pi2 = { on() {} };
    const attach2 = core.attach(pi2, {
      globalObject: fakeGlobal,
      peerCapabilityToken: token2,
    });
    attach2.stopHeartbeat();

    assert.deepEqual(fakeGlobal[core.PEER_CAPABILITY_SLOT_SYMBOL], {
      version: 1,
      token: token2,
    });
    assert.equal(Object.isFrozen(fakeGlobal[core.PEER_CAPABILITY_SLOT_SYMBOL]), true);
  });

  it("stale attach still sends its own original token (coordinator retired-token logic handles it)", async () => {
    const fakeGlobal = {};
    const token1 = "88".repeat(32);
    const token2 = "99".repeat(32);

    const handlers1 = {};
    const pi1 = { on(event, fn) { handlers1[event] = fn; } };
    const posts1 = [];
    const attach1 = core.attach(pi1, {
      globalObject: fakeGlobal,
      peerCapabilityToken: token1,
      shouldReport: () => true,
      postState: async (payload) => {
        posts1.push(payload);
        return true;
      },
    });

    const handlers2 = {};
    const pi2 = { on(event, fn) { handlers2[event] = fn; } };
    const posts2 = [];
    const attach2 = core.attach(pi2, {
      globalObject: fakeGlobal,
      peerCapabilityToken: token2,
      shouldReport: () => true,
      postState: async (payload) => {
        posts2.push(payload);
        return true;
      },
    });

    // Global slot now holds token2 from the second attach
    assert.equal(fakeGlobal[core.PEER_CAPABILITY_SLOT_SYMBOL].token, token2);

    const ctx = makeCtx();

    // Attach 2 sends state with token 2
    handlers2.session_start({ type: "session_start" }, ctx);
    assert.equal(posts2.length, 1);
    assert.equal(posts2[0].pet_peer_capability.token, token2);

    // Stale attach 1 sends late/concurrent events with its own token 1
    handlers1.tool_call({ type: "tool_call", toolName: "bash", toolCallId: "late-call" }, ctx);
    await handlers1.session_shutdown({ type: "session_shutdown", reason: "quit" }, ctx);

    assert.equal(posts1.length, 2);
    assert.equal(posts1[0].event, "PreToolUse");
    assert.equal(posts1[0].pet_peer_capability.token, token1);
    assert.equal(posts1[1].event, "SessionEnd");
    assert.equal(posts1[1].pet_peer_capability.token, token1);

    attach1.stopHeartbeat();
    attach2.stopHeartbeat();
  });

  it("attach result/JSON does not contain token", () => {
    const token = "ab".repeat(32);
    const fakeGlobal = {};
    const pi = { on() {} };

    const attachResult = core.attach(pi, {
      globalObject: fakeGlobal,
      peerCapabilityToken: token,
      capabilityToken: "cd".repeat(32),
    });
    attachResult.stopHeartbeat();

    assert.equal(attachResult.peerCapabilityToken, undefined);
    assert.equal(attachResult.token, undefined);
    assert.equal(attachResult.capabilityToken, undefined);
    assert.equal(attachResult.pet_peer_capability, undefined);

    const jsonStr = JSON.stringify(attachResult);
    assert.equal(jsonStr.includes(token), false);
    assert.equal(jsonStr.includes("cd".repeat(32)), false);

    // Public API returns exactly the expected keys
    const keys = Object.keys(attachResult).sort();
    assert.deepEqual(keys, ["deliveryChains", "getInboxConsumer", "send", "startHeartbeat", "stopHeartbeat"]);
  });

  it("invalid injected token is replaced with valid generated token", () => {
    const invalidTokens = [
      "too-short",
      "G".repeat(64), // non-hex
      "A".repeat(64), // uppercase hex (must be lowercase)
      12345,
      null,
      "",
      true,
      {},
      [],
    ];

    for (const invalidToken of invalidTokens) {
      const fakeGlobal = {};
      const pi = { on() {} };
      const attachResult = core.attach(pi, {
        globalObject: fakeGlobal,
        peerCapabilityToken: invalidToken,
      });
      attachResult.stopHeartbeat();

      const record = fakeGlobal[core.PEER_CAPABILITY_SLOT_SYMBOL];
      assert.ok(record, `Shared slot must be populated for invalid token: ${invalidToken}`);
      assert.equal(record.version, 1);
      assert.equal(typeof record.token, "string");
      assert.match(record.token, /^[0-9a-f]{64}$/, "Generated token must be 64-char lowercase hex");
      assert.notEqual(record.token, invalidToken);
      assert.equal(Object.isFrozen(record), true);
    }
  });
});
