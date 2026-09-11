"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const core = require("../hooks/pi-extension-core");

function makeRemoteIdentity(overrides = {}) {
  return {
    ok: true,
    version: 2,
    layoutVersion: 1,
    runtimeKey: "account-default",
    profileId: "remote-pi-1",
    installId: "a".repeat(64),
    remotePort: 23337,
    routingNonce: "b".repeat(32),
    deployedAt: 1000,
    ...overrides,
  };
}

function makeCtx(overrides = {}) {
  return {
    hasUI: true,
    cwd: "/home/user/project",
    sessionManager: {
      getSessionId: () => "sess-test-1",
    },
    ...overrides,
  };
}

function createMockHttp(handler) {
  return (options, callback) => {
    const req = new EventEmitter();
    let written = "";
    req.write = (chunk) => {
      written += (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    };
    req.end = (chunk) => {
      if (chunk) req.write(chunk);
      queueMicrotask(async () => {
        try {
          const spec = await handler(options, written ? JSON.parse(written) : null, written);
          if (!spec) {
            req.emit("error", new Error("connection-refused"));
            return;
          }
          const res = new EventEmitter();
          res.statusCode = spec.statusCode || 200;
          res.headers = spec.headers !== undefined ? spec.headers : { "x-clawd-server": "clawd-on-desk" };
          res.setEncoding = () => {};
          res.resume = () => {};
          callback(res);
          if (spec.chunks) {
            for (const c of spec.chunks) res.emit("data", c);
          } else if (spec.body !== undefined) {
            const bodyStr = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
            res.emit("data", Buffer.from(bodyStr, "utf8"));
          }
          res.emit("end");
        } catch (err) {
          req.emit("error", err);
        }
      });
    };
    req.destroy = () => {
      req.emit("close");
    };
    return req;
  };
}

describe("Remote Pi Inbox Consumer", () => {
  it("enables consumer and capability state ONLY when remote identity is valid", async () => {
    const statePosts = [];
    const httpCalls = [];
    const handlers = {};
    const pi = {
      on(event, fn) { handlers[event] = fn; },
      sendUserMessage() {},
    };

    const validIdentity = makeRemoteIdentity();
    const remoteAttach = core.attach(pi, {
      remoteIdentity: validIdentity,
      capabilityToken: "c".repeat(64),
      shouldReport: () => true,
      postState: async (payload) => { statePosts.push(payload); return true; },
      httpRequest: createMockHttp((options, body) => {
        httpCalls.push({ path: options.path, body, headers: options.headers });
        return { statusCode: 200, body: { status: "empty" } };
      }),
    });

    handlers.session_start({ type: "session_start" }, makeCtx());
    await new Promise((r) => setTimeout(r, 20));
    remoteAttach.stopHeartbeat();
    if (remoteAttach.getInboxConsumer()) remoteAttach.getInboxConsumer().stop();

    assert.equal(statePosts.length >= 1, true);
    assert.deepEqual(statePosts[0].pet_inbox_capability, {
      version: 1,
      receiveUserMessage: true,
      token: "c".repeat(64),
    });
    assert.equal(httpCalls.length >= 1, true);
    assert.equal(httpCalls[0].path, "/pet-inbox/claim");
    assert.equal(httpCalls[0].headers["x-clawd-routing-nonce"], "b".repeat(32));
    assert.equal(remoteAttach.capabilityToken, undefined, "capability must not leak through attach result");

    // Local mode: no capability in state, no inbox requests
    const localStatePosts = [];
    const localHttpCalls = [];
    const localPi = {
      on(event, fn) { handlers[event] = fn; },
      sendUserMessage() {},
    };
    const localAttach = core.attach(localPi, {
      remoteIdentity: { ok: false, reason: "identity-unreadable" },
      shouldReport: () => true,
      postState: async (payload) => { localStatePosts.push(payload); return true; },
      httpRequest: createMockHttp((options, body) => {
        localHttpCalls.push({ path: options.path, body });
        return { statusCode: 200, body: { status: "empty" } };
      }),
    });

    handlers.session_start({ type: "session_start" }, makeCtx());
    await new Promise((r) => setTimeout(r, 20));
    localAttach.stopHeartbeat();
    if (localAttach.getInboxConsumer()) localAttach.getInboxConsumer().stop();

    assert.equal(localStatePosts.length >= 1, true);
    assert.equal(localStatePosts[0].pet_inbox_capability, undefined);
    assert.equal(localHttpCalls.length, 0);

    const invalidHandlers = {};
    const invalidPosts = [];
    const invalidAttach = core.attach({
      on(event, fn) { invalidHandlers[event] = fn; },
      sendUserMessage() {},
    }, {
      remoteIdentity: makeRemoteIdentity({ remotePort: 0 }),
      capabilityToken: "9".repeat(64),
      shouldReport: () => true,
      postState: (payload) => { invalidPosts.push(payload); return true; },
      httpRequest: () => { throw new Error("must not probe"); },
    });
    invalidHandlers.session_start({ type: "session_start" }, makeCtx());
    assert.equal(invalidPosts[0].pet_inbox_capability, undefined);
    assert.equal(invalidAttach.getInboxConsumer(), null);
    invalidAttach.stopHeartbeat();
  });

  it("performs exact claim, dispatch, and settle lifecycle", async () => {
    const httpRequests = [];
    const sentMessages = [];
    const handlers = {};
    const pi = {
      on(event, fn) { handlers[event] = fn; },
      sendUserMessage(text, options) {
        sentMessages.push({ text, options });
      },
    };

    let claimCount = 0;
    const mockHttp = createMockHttp((options, body) => {
      httpRequests.push({ path: options.path, body, port: options.port });
      if (options.path === "/pet-inbox/claim") {
        claimCount++;
        if (claimCount === 1) {
          return {
            statusCode: 200,
            body: {
              status: "claimed",
              commandId: "cmd-101",
              claimToken: "tok-abc-123",
              text: "Hello from desk pet!",
              deliverAs: "followUp",
              expiresAtMs: Date.now() + 30000,
              claimedAtMs: Date.now(),
            },
          };
        }
        return { statusCode: 200, body: { status: "empty" } };
      }
      if (options.path === "/pet-inbox/settle") {
        return {
          statusCode: 200,
          body: {
            status: "dispatched",
            commandId: body.commandId,
          },
        };
      }
      return { statusCode: 404 };
    });

    const attachResult = core.attach(pi, {
      remoteIdentity: makeRemoteIdentity({ remotePort: 23337 }),
      capabilityToken: "d".repeat(64),
      shouldReport: () => true,
      postState: async () => true,
      httpRequest: mockHttp,
      pollIntervalMs: 50,
    });

    handlers.session_start({ type: "session_start" }, makeCtx({
      sessionManager: { getSessionId: () => "sess-42" },
    }));

    await new Promise((r) => setTimeout(r, 40));
    attachResult.stopHeartbeat();
    if (attachResult.getInboxConsumer()) attachResult.getInboxConsumer().stop();

    // Verify claim request
    assert.equal(httpRequests[0].path, "/pet-inbox/claim");
    assert.deepEqual(httpRequests[0].body, {
      schemaVersion: "1",
      kind: "user_message_claim",
      rawSessionId: "pi:sess-42",
      capabilityToken: "d".repeat(64),
    });

    // Verify Pi dispatch call
    assert.equal(sentMessages.length, 1);
    assert.deepEqual(sentMessages[0], {
      text: "Hello from desk pet!",
      options: {
        deliverAs: "followUp",
        expandPromptTemplates: false,
      },
    });

    // Verify settle request
    const settleReq = httpRequests.find((r) => r.path === "/pet-inbox/settle");
    assert.ok(settleReq);
    assert.deepEqual(settleReq.body, {
      schemaVersion: "1",
      kind: "user_message_settle",
      rawSessionId: "pi:sess-42",
      capabilityToken: "d".repeat(64),
      commandId: "cmd-101",
      claimToken: "tok-abc-123",
      status: "dispatched",
    });
  });

  it("handles empty inbox backoff without dispatching", async () => {
    const httpRequests = [];
    const sentMessages = [];
    let currentTime = 1000;
    const scheduled = [];

    const mockConsumer = core.createRemoteInboxConsumer({
      pi: {
        sendUserMessage(text, options) { sentMessages.push({ text, options }); },
      },
      identity: makeRemoteIdentity(),
      rawSessionId: "pi:sess-empty",
      capabilityToken: "e".repeat(64),
      httpRequest: createMockHttp((options, body) => {
        httpRequests.push({ path: options.path, body });
        return { statusCode: 200, body: { status: "empty" } };
      }),
      setTimeout: (fn, ms) => {
        const id = { fn, ms };
        scheduled.push(id);
        return id;
      },
      clearTimeout: () => {},
      now: () => currentTime,
      pollIntervalMs: 1000,
    });

    // Initial tick was scheduled at delay 0
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, 0);
    await scheduled.shift().fn();

    assert.equal(httpRequests.length, 1);
    assert.equal(httpRequests[0].path, "/pet-inbox/claim");
    assert.equal(sentMessages.length, 0);

    // Empty response schedules next poll at 1000ms
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, 1000);

    mockConsumer.stop();
  });

  it("settles expired message without dispatching to Pi when TTL has passed", async () => {
    const httpRequests = [];
    const sentMessages = [];
    let currentTime = 20000;

    const mockConsumer = core.createRemoteInboxConsumer({
      pi: {
        sendUserMessage(text, options) { sentMessages.push({ text, options }); },
      },
      identity: makeRemoteIdentity(),
      rawSessionId: "pi:sess-ttl",
      capabilityToken: "f".repeat(64),
      httpRequest: createMockHttp((options, body) => {
        httpRequests.push({ path: options.path, body });
        if (options.path === "/pet-inbox/claim") {
          return {
            statusCode: 200,
            body: {
              status: "claimed",
              commandId: "cmd-expired",
              claimToken: "tok-exp",
              text: "stale message",
              deliverAs: "followUp",
              expiresAtMs: 15000, // already expired at currentTime 20000
              claimedAtMs: 10000,
            },
          };
        }
        if (options.path === "/pet-inbox/settle") {
          return { statusCode: 200, body: { status: "expired" } };
        }
      }),
      setTimeout: (fn) => { queueMicrotask(fn); return { unref() {} }; },
      clearTimeout: () => {},
      now: () => currentTime,
    });

    await new Promise((r) => setTimeout(r, 30));
    mockConsumer.stop();

    assert.equal(sentMessages.length, 0);
    const settleReq = httpRequests.find((r) => r.path === "/pet-inbox/settle");
    assert.ok(settleReq);
    assert.equal(settleReq.body.status, "expired");
    assert.equal(settleReq.body.commandId, "cmd-expired");
  });

  it("settles failed on synchronous throw from sendUserMessage", async () => {
    const httpRequests = [];

    const mockConsumer = core.createRemoteInboxConsumer({
      pi: {
        sendUserMessage() {
          throw new Error("send exploded");
        },
      },
      identity: makeRemoteIdentity(),
      rawSessionId: "pi:sess-throw",
      capabilityToken: "1".repeat(64),
      httpRequest: createMockHttp((options, body) => {
        httpRequests.push({ path: options.path, body });
        if (options.path === "/pet-inbox/claim") {
          return {
            statusCode: 200,
            body: {
              status: "claimed",
              commandId: "cmd-throw",
              claimToken: "tok-throw",
              text: "kaboom",
              deliverAs: "followUp",
              expiresAtMs: Date.now() + 30000,
            },
          };
        }
        if (options.path === "/pet-inbox/settle") {
          return { statusCode: 200, body: { status: "failed" } };
        }
      }),
      setTimeout: (fn) => { queueMicrotask(fn); return { unref() {} }; },
      clearTimeout: () => {},
    });

    await new Promise((r) => setTimeout(r, 30));
    mockConsumer.stop();

    const settleReq = httpRequests.find((r) => r.path === "/pet-inbox/settle");
    assert.ok(settleReq);
    assert.equal(settleReq.body.status, "failed");
    assert.equal(settleReq.body.reason, "send exploded");
  });

  it("retries settle on transport/5xx failures without re-dispatching, and clears on terminal / 60s timeout", async () => {
    const settleCalls = [];
    let dispatchCount = 0;
    let settleAttempt = 0;
    let currentTime = 10000;
    const scheduled = [];

    const mockConsumer = core.createRemoteInboxConsumer({
      pi: {
        sendUserMessage() { dispatchCount++; },
      },
      identity: makeRemoteIdentity(),
      rawSessionId: "pi:sess-retry",
      capabilityToken: "2".repeat(64),
      httpRequest: createMockHttp((options, body) => {
        if (options.path === "/pet-inbox/claim") {
          return {
            statusCode: 200,
            body: {
              status: "claimed",
              commandId: "cmd-retry",
              claimToken: "tok-retry",
              text: "retry test",
              deliverAs: "followUp",
              expiresAtMs: currentTime + 50000,
              claimedAtMs: currentTime,
            },
          };
        }
        if (options.path === "/pet-inbox/settle") {
          settleAttempt++;
          settleCalls.push({ attempt: settleAttempt, body });
          if (settleAttempt === 1) {
            // First settle attempt: 500 server error
            return { statusCode: 500, body: { status: "failed", reason: "db lock" } };
          }
          if (settleAttempt === 2) {
            // Second settle attempt: generic ingress 404 without trusted header.
            // It must not be confused with coordinator ClaimNotFound.
            return {
              statusCode: 404,
              headers: {},
              body: { status: "rejected", reason: "not found" },
            };
          }
          if (settleAttempt === 3) {
            // Third settle attempt: network transport failure
            return null;
          }
          // Fourth settle attempt: trusted terminal receipt
          return { statusCode: 200, body: { status: "dispatched" } };
        }
      }),
      setTimeout: (fn, ms) => {
        const item = { fn, ms };
        scheduled.push(item);
        return item;
      },
      clearTimeout: () => {},
      now: () => currentTime,
      retryIntervalMs: 1000,
      pollIntervalMs: 1000,
    });

    // 1. Initial claim tick
    await scheduled.shift().fn();
    assert.equal(dispatchCount, 1);
    assert.equal(settleCalls.length, 1);
    assert.ok(mockConsumer.getPendingSettlement());

    // 2. Settle failed with 500 -> retry scheduled
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, 1000);
    currentTime += 1000;
    await scheduled.shift().fn();
    assert.equal(dispatchCount, 1); // NEVER re-dispatches!
    assert.equal(settleCalls.length, 2);
    assert.ok(mockConsumer.getPendingSettlement());

    // 3. Untrusted generic 404 -> retain settlement and retry
    assert.equal(scheduled.length, 1);
    currentTime += 1000;
    await scheduled.shift().fn();
    assert.equal(dispatchCount, 1);
    assert.equal(settleCalls.length, 3);
    assert.ok(mockConsumer.getPendingSettlement());

    // 4. Transport error -> still retain settlement and retry
    assert.equal(scheduled.length, 1);
    currentTime += 1000;
    await scheduled.shift().fn();
    assert.equal(dispatchCount, 1);
    assert.equal(settleCalls.length, 4);

    // 5. Trusted terminal receipt -> pending settlement cleared
    assert.equal(mockConsumer.getPendingSettlement(), null);
    mockConsumer.stop();

    // Now test 60s timeout abandonment
    let claimAttempt = 0;
    const timeoutScheduled = [];
    const timeoutConsumer = core.createRemoteInboxConsumer({
      pi: { sendUserMessage() { dispatchCount++; } },
      identity: makeRemoteIdentity(),
      rawSessionId: "pi:sess-timeout",
      capabilityToken: "3".repeat(64),
      httpRequest: createMockHttp((options) => {
        if (options.path === "/pet-inbox/claim") {
          claimAttempt++;
          return {
            statusCode: 200,
            body: {
              status: "claimed",
              commandId: `cmd-to-${claimAttempt}`,
              claimToken: "tok-to",
              text: "timeout test",
              deliverAs: "followUp",
              expiresAtMs: currentTime + 100000,
              claimedAtMs: currentTime,
            },
          };
        }
        if (options.path === "/pet-inbox/settle") {
          return { statusCode: 503, body: { status: "failed" } };
        }
      }),
      setTimeout: (fn, ms) => {
        const item = { fn, ms };
        timeoutScheduled.push(item);
        return item;
      },
      clearTimeout: () => {},
      now: () => currentTime,
      settleDeadlineMs: 60000,
    });

    await timeoutScheduled.shift().fn();
    assert.ok(timeoutConsumer.getPendingSettlement());

    // Advance time past 60s deadline
    currentTime += 60001;
    await timeoutScheduled.shift().fn(); // settle retry executes and spots deadline exceeded
    assert.equal(timeoutConsumer.getPendingSettlement(), null);

    timeoutConsumer.stop();
  });

  it("does not dispatch a claim response that arrives after its 60s claim lease", async () => {
    const scheduled = [];
    let dispatchCount = 0;
    let settleCount = 0;
    const consumer = core.createRemoteInboxConsumer({
      pi: { sendUserMessage() { dispatchCount++; } },
      identity: makeRemoteIdentity(),
      rawSessionId: "pi:sess-late",
      capabilityToken: "7".repeat(64),
      now: () => 61_001,
      httpRequest: createMockHttp((options) => {
        if (options.path === "/pet-inbox/settle") settleCount++;
        return {
          statusCode: 200,
          body: options.path === "/pet-inbox/claim" ? {
            status: "claimed",
            commandId: "cmd-late",
            claimToken: "tok-late",
            text: "do not dispatch",
            deliverAs: "followUp",
            expiresAtMs: 100_000,
            claimedAtMs: 1_000,
          } : { status: "failed" },
        };
      }),
      setTimeout: (fn, ms) => {
        const timer = { fn, ms, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeout: () => {},
    });

    await scheduled.shift().fn();
    assert.equal(dispatchCount, 0);
    assert.equal(settleCount, 0);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, 1_000);
    consumer.stop();
  });

  it("stops inbox consumer timers on session_shutdown including reload", async () => {
    let clearedTimer = false;
    let timerRef = null;
    const handlers = {};
    const pi = {
      on(event, fn) { handlers[event] = fn; },
      sendUserMessage() {},
    };

    const attachResult = core.attach(pi, {
      remoteIdentity: makeRemoteIdentity(),
      capabilityToken: "4".repeat(64),
      shouldReport: () => true,
      postState: async () => true,
      httpRequest: createMockHttp(() => ({ statusCode: 200, body: { status: "empty" } })),
      setTimeout: (fn) => {
        timerRef = { fn, unref() {} };
        return timerRef;
      },
      clearTimeout: (t) => {
        if (t === timerRef) clearedTimer = true;
      },
    });

    handlers.session_start({ type: "session_start" }, makeCtx());
    const consumer = attachResult.getInboxConsumer();
    assert.ok(consumer);
    assert.equal(consumer.isActive(), true);

    // Shutdown with reload reason
    const reloadResult = handlers.session_shutdown({ type: "session_shutdown", reason: "reload" }, makeCtx());
    assert.equal(reloadResult, false);
    assert.equal(consumer.isActive(), false);
    assert.equal(clearedTimer, true);
    assert.equal(attachResult.getInboxConsumer(), null);
  });

  it("fails closed on bad server header, oversize payload, and invalid identity", async () => {
    const identity = makeRemoteIdentity();

    // Bad server header
    const badHeaderResult = await core.postInboxJson({
      identity,
      path: "/pet-inbox/claim",
      payload: { test: true },
      httpRequest: createMockHttp(() => ({
        statusCode: 200,
        headers: { "x-clawd-server": "wrong-server" },
        body: { status: "empty" },
      })),
    });
    assert.equal(badHeaderResult.ok, false);
    assert.equal(badHeaderResult.reason, "invalid-server-header");

    // Oversize request (>16KiB)
    const largePayload = { data: "x".repeat(17 * 1024) };
    const oversizeReqResult = await core.postInboxJson({
      identity,
      path: "/pet-inbox/claim",
      payload: largePayload,
      httpRequest: createMockHttp(() => ({ statusCode: 200, body: { status: "empty" } })),
    });
    assert.equal(oversizeReqResult.ok, false);
    assert.equal(oversizeReqResult.reason, "request-too-large");

    // Oversize response (>64KiB)
    const oversizeResResult = await core.postInboxJson({
      identity,
      path: "/pet-inbox/claim",
      payload: { test: true },
      httpRequest: createMockHttp(() => ({
        statusCode: 200,
        chunks: [Buffer.alloc(35 * 1024), Buffer.alloc(35 * 1024)],
      })),
    });
    assert.equal(oversizeResResult.ok, false);
    assert.equal(oversizeResResult.reason, "response-too-large");

    // Invalid identity fails closed without request
    let called = false;
    const invalidIdResult = await core.postInboxJson({
      identity: { ok: false },
      path: "/pet-inbox/claim",
      payload: { test: true },
      httpRequest: () => { called = true; },
    });
    assert.equal(invalidIdResult.ok, false);
    assert.equal(invalidIdResult.reason, "invalid-identity");
    assert.equal(called, false);
  });

  it("enforces canonical session ID matching buildPayload and rejects default/empty session startup", () => {
    // Session with normal id
    const ctxNormal = makeCtx({ sessionManager: { getSessionId: () => "sess-123" } });
    assert.equal(core.getCanonicalRawSessionId(ctxNormal), "pi:sess-123");
    assert.equal(core.isStartableRawSessionId("pi:sess-123"), true);

    // Session with already-prefixed id (no double prefix)
    const ctxPrefixed = makeCtx({ sessionManager: { getSessionId: () => "pi:sess-123" } });
    assert.equal(core.getCanonicalRawSessionId(ctxPrefixed), "pi:sess-123");
    assert.equal(core.isStartableRawSessionId("pi:sess-123"), true);

    // Default / empty sessions
    const ctxDefault = makeCtx({ sessionManager: { getSessionId: () => "default" } });
    assert.equal(core.getCanonicalRawSessionId(ctxDefault), "pi:default");
    assert.equal(core.isStartableRawSessionId("pi:default"), false);

    const ctxEmpty = makeCtx({ sessionManager: { getSessionId: () => "" } });
    assert.equal(core.getCanonicalRawSessionId(ctxEmpty), "pi:default");
    assert.equal(core.isStartableRawSessionId("pi:default"), false);

    assert.equal(core.isStartableRawSessionId("default"), false);
    assert.equal(core.isStartableRawSessionId("pi:"), false);
    assert.equal(core.isStartableRawSessionId("   "), false);

    // Consumer does NOT start for default session ID
    const handlers = {};
    const pi = { on(event, fn) { handlers[event] = fn; } };
    const attachResult = core.attach(pi, {
      remoteIdentity: makeRemoteIdentity(),
      shouldReport: () => true,
      postState: async () => true,
    });
    handlers.session_start({ type: "session_start" }, ctxDefault);
    assert.equal(attachResult.getInboxConsumer(), null);
    attachResult.stopHeartbeat();
  });
});
