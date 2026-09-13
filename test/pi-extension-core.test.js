"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const core = require("../hooks/pi-extension-core");
const { NESTED_TERMINAL_ENV } = require("../hooks/shared-process");

function makeCtx(overrides = {}) {
  return {
    hasUI: true,
    cwd: "D:/work/project",
    sessionManager: {
      getSessionId: () => "session-1",
    },
    ...overrides,
  };
}

describe("pi-extension-core", () => {
  it("detects non-interactive Pi modes from argv", () => {
    assert.strictEqual(core.parseMode(["node", "pi"]), "interactive");
    assert.strictEqual(core.parseMode(["node", "pi", "-p"]), "print");
    assert.strictEqual(core.parseMode(["node", "pi", "--print"]), "print");
    assert.strictEqual(core.parseMode(["node", "pi", "--mode", "rpc"]), "rpc");
    assert.strictEqual(core.parseMode(["node", "pi", "--mode=json"]), "json");
  });

  it("uses ctx.hasUI when Pi provides it", () => {
    assert.strictEqual(core.shouldReport({ hasUI: true }), true);
    assert.strictEqual(core.shouldReport({ hasUI: false }), false);
  });

  it("falls back to TTY detection when ctx.hasUI is unavailable", () => {
    assert.strictEqual(core.shouldReport({}, {
      argv: ["node", "pi"],
      stdin: { isTTY: true },
      stdout: { isTTY: true },
    }), true);
    assert.strictEqual(core.shouldReport({}, {
      argv: ["node", "pi", "--mode", "rpc"],
      stdin: { isTTY: true },
      stdout: { isTTY: true },
    }), false);
  });

  it("builds a generic Clawd /state payload with Pi session and pid fields", () => {
    const payload = core.buildPayload({
      state: "working",
      event: "PreToolUse",
      nativeEvent: {
        toolName: "bash",
        toolCallId: "tool-1",
      },
      ctx: makeCtx(),
      // Hermetic env: the payload picks up Orca's pane key from the environment,
      // so a real one would leak the developer's own terminal into this check.
      env: {},
      metadata: {
        cwd: "D:/work/project",
        sourcePid: 1234,
        pidChain: [3333, 2222, 1234],
        editor: "cursor",
      },
      agentPid: 3333,
    });

    assert.deepStrictEqual(payload, {
      agent_id: "pi",
      hook_source: "pi-extension",
      event: "PreToolUse",
      state: "working",
      session_id: "pi:session-1",
      agent_pid: 3333,
      cwd: "D:/work/project",
      source_pid: 1234,
      pid_chain: [3333, 2222, 1234],
      editor: "cursor",
      tool_name: "bash",
      tool_use_id: "tool-1",
    });
  });

  it("carries the Orca pane key from the injected env, and vetoes an inherited one", () => {
    // This module keeps its own copy of the validator and the marker list because
    // it ships inside the Pi extension, and until now nothing exercised either —
    // lowercasing "Orca" or inverting the guard would have kept the suite green
    // while Pi shipped a key belonging to a pane it does not live in.
    const build = (env) => core.buildPayload({
      state: "working",
      event: "PreToolUse",
      ctx: makeCtx(),
      env,
      metadata: { cwd: "D:/work/project", sourcePid: 1234, pidChain: [3333, 1234] },
      agentPid: 3333,
    });
    const KEY = "8ce1fff7-tab:9813824b-leaf";

    assert.strictEqual(build({ TERM_PROGRAM: "Orca", ORCA_PANE_KEY: KEY }).orca_pane_key, KEY);
    // Without the TERM_PROGRAM confirmation the key was inherited by a child shell.
    assert.strictEqual(build({ ORCA_PANE_KEY: KEY }).orca_pane_key, undefined);
    assert.strictEqual(build({ TERM_PROGRAM: "Orca", ORCA_PANE_KEY: "no-separator" }).orca_pane_key, undefined);
    for (const marker of NESTED_TERMINAL_ENV) {
      assert.strictEqual(
        build({ TERM_PROGRAM: "Orca", ORCA_PANE_KEY: KEY, [marker]: "1" }).orca_pane_key,
        undefined,
        `${marker} must veto the pane key`
      );
    }
  });

  it("falls back to a default session id when Pi session metadata is unavailable", () => {
    const payload = core.buildPayload({
      state: "idle",
      event: "SessionStart",
      ctx: makeCtx({ sessionManager: {} }),
    });

    assert.strictEqual(payload.session_id, "pi:default");
  });

  it("does not double-prefix when Pi sessionId already starts with pi:", () => {
    const payload = core.buildPayload({
      state: "idle",
      event: "SessionStart",
      ctx: makeCtx({ sessionManager: { getSessionId: () => "pi:custom-session" } }),
    });

    assert.strictEqual(payload.session_id, "pi:custom-session");
  });

  it("includes pet_inbox_capability when valid capabilityToken is provided", () => {
    const token = "a".repeat(64);
    const payload = core.buildPayload({
      state: "idle",
      event: "SessionStart",
      ctx: makeCtx(),
      capabilityToken: token,
    });

    assert.deepStrictEqual(payload.pet_inbox_capability, {
      version: 1,
      receiveUserMessage: true,
      token,
    });
  });

  it("registers Pi lifecycle handlers and maps them to Clawd events", async () => {
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };
    const posts = [];
    core.attach(pi, {
      shouldReport: (ctx) => ctx && ctx.hasUI,
      buildPayload: ({ state, event, nativeEvent, ctx }) => core.buildPayload({
        state,
        event,
        nativeEvent,
        ctx,
        agentPid: 999,
      }),
      postState: async (payload) => {
        posts.push(payload);
        return true;
      },
    });

    handlers.session_start({ type: "session_start" }, makeCtx());
    handlers.before_agent_start({ type: "before_agent_start" }, makeCtx());
    handlers.tool_call({ type: "tool_call", toolName: "read", toolCallId: "tool-2" }, makeCtx());
    await handlers.agent_end({ type: "agent_end" }, makeCtx());
    await Promise.resolve();

    assert.deepStrictEqual(
      posts.map((payload) => [payload.event, payload.state]),
      [
        ["SessionStart", "idle"],
        ["UserPromptSubmit", "thinking"],
        ["PreToolUse", "working"],
        ["Stop", "attention"],
      ]
    );
    assert.deepStrictEqual(posts[2].tool_name, "read");
    assert.strictEqual(posts[0].agent_pid, 999);
  });

  it("heartbeats in idle and mid-turn, and treats extension reload as non-terminal", async () => {
    const handlers = {};
    let intervalCallback = null;
    let cleared = false;
    const posts = [];
    const pi = { on(name, handler) { handlers[name] = handler; } };
    const ctx = makeCtx({ isIdle: () => true });
    core.attach(pi, {
      shouldReport: () => true,
      heartbeatIntervalMs: 10,
      setInterval: (callback) => {
        intervalCallback = callback;
        return { unref() {} };
      },
      clearInterval: () => { cleared = true; },
      buildPayload: ({ state, event, nativeEvent, ctx: eventCtx, livenessOnly }) => core.buildPayload({
        state,
        event,
        nativeEvent,
        ctx: eventCtx,
        livenessOnly,
      }),
      postState: async (payload) => { posts.push(payload); return true; },
    });

    handlers.session_start({ type: "session_start" }, ctx);
    intervalCallback();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepStrictEqual(posts.map((payload) => [payload.event, payload.liveness_only]), [
      ["SessionStart", undefined],
      ["SessionHeartbeat", true],
    ]);

    // Mid-turn (long-running tool call, no hook events for minutes): the
    // heartbeat must still fire and report the working lifecycle state so
    // Clawd's stale sweep never force-idles a genuinely busy session.
    handlers.before_agent_start({ type: "before_agent_start" }, makeCtx({ isIdle: () => false }));
    await Promise.resolve();
    posts.length = 0;
    intervalCallback();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepStrictEqual(posts.map((payload) => [payload.event, payload.state, payload.liveness_only]), [
      ["SessionHeartbeat", "working", true],
    ]);

    const beforeReload = posts.length;
    await handlers.session_shutdown({ type: "session_shutdown", reason: "reload" }, ctx);
    assert.strictEqual(cleared, true);
    assert.strictEqual(posts.length, beforeReload);
  });

  it("reports a real Pi quit as SessionEnd", async () => {
    const handlers = {};
    const posts = [];
    core.attach({ on(name, handler) { handlers[name] = handler; } }, {
      shouldReport: () => true,
      postState: async (payload) => { posts.push(payload); return true; },
    });

    await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, makeCtx());

    assert.deepStrictEqual(posts.map((payload) => [payload.event, payload.state]), [
      ["SessionEnd", "sleeping"],
    ]);
  });

  it("reports mutating tool calls as state only and never asks for permission", async () => {
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };
    const posts = [];
    core.attach(pi, {
      shouldReport: () => true,
      buildPayload: ({ state, event, nativeEvent, ctx }) => core.buildPayload({
        state,
        event,
        nativeEvent,
        ctx,
      }),
      postState: (payload) => {
        posts.push(payload);
        return true;
      },
    });

    const result = await handlers.tool_call({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "tool-bash",
      input: { command: "echo ok" },
    }, makeCtx());
    await Promise.resolve();

    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(posts.map((payload) => [payload.event, payload.state, payload.tool_name]), [
      ["PreToolUse", "working", "bash"],
    ]);
  });

  it("does not block Pi tools if state reporting fails", async () => {
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };
    core.attach(pi, {
      shouldReport: () => true,
      buildPayload: () => {
        throw new Error("metadata failed");
      },
      postState: () => true,
    });

    const result = await handlers.tool_call({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "tool-bash",
      input: { command: "echo ok" },
    }, makeCtx());
    await Promise.resolve();

    assert.strictEqual(result, undefined);
  });

  it("maps tool_result errors separately from successful tool results", async () => {
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };
    const posts = [];
    core.attach(pi, {
      shouldReport: () => true,
      buildPayload: ({ state, event, nativeEvent, ctx }) => core.buildPayload({
        state,
        event,
        nativeEvent,
        ctx,
      }),
      postState: async (payload) => {
        posts.push(payload);
        return true;
      },
    });

    handlers.tool_result({ type: "tool_result", isError: false }, makeCtx());
    await handlers.tool_result({ type: "tool_result", isError: true }, makeCtx());
    await Promise.resolve();

    assert.deepStrictEqual(
      posts.map((payload) => [payload.event, payload.state]),
      [
        ["PostToolUse", "working"],
        ["PostToolUseFailure", "error"],
      ]
    );
  });

  it("preserves per-session delivery ordering for awaited posts", async () => {
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };
    const posts = [];
    const pending = [];
    core.attach(pi, {
      shouldReport: () => true,
      buildPayload: ({ state, event, nativeEvent, ctx }) => core.buildPayload({
        state,
        event,
        nativeEvent,
        ctx,
      }),
      postState: (payload) => new Promise((resolve) => {
        posts.push(payload);
        pending.push(resolve);
      }),
    });

    const first = handlers.tool_result({
      type: "tool_result",
      toolName: "bash",
      toolCallId: "first",
      isError: true,
    }, makeCtx());
    const second = handlers.tool_result({
      type: "tool_result",
      toolName: "bash",
      toolCallId: "second",
      isError: true,
    }, makeCtx());
    await Promise.resolve();
    await Promise.resolve();

    assert.deepStrictEqual(posts.map((payload) => payload.tool_use_id), ["first"]);
    pending[0](true);
    await first;
    await Promise.resolve();
    await Promise.resolve();

    assert.deepStrictEqual(posts.map((payload) => payload.tool_use_id), ["first", "second"]);
    pending[1](true);
    await second;
  });

  it("does not report events when Pi runs without interactive UI", () => {
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };
    const posts = [];
    core.attach(pi, {
      shouldReport: () => false,
      postState: (payload) => posts.push(payload),
    });

    const result = handlers.session_start({ type: "session_start" }, makeCtx({ hasUI: false }));

    assert.strictEqual(result, false);
    assert.deepStrictEqual(posts, []);
  });

  it("boundedly forwards native getSessionName as session_title on state payloads", () => {
    const ctx = makeCtx({
      sessionManager: {
        getSessionId: () => "session-title-test",
        getSessionName: () => "Fix the auth bug",
      },
    });
    const payload = core.buildPayload({
      state: "working",
      event: "PreToolUse",
      ctx,
    });

    assert.strictEqual(payload.session_title, "Fix the auth bug");
    assert.strictEqual(payload.session_id, "pi:session-title-test");
  });

  it("sanitizes control/bidi characters and truncates long session_title values", () => {
    const longName = "A".repeat(120);
    const ctx = makeCtx({
      sessionManager: {
        getSessionId: () => "sess-1",
        getSessionName: () => ` \u061C\u200E ${longName}\u202E\u2066 `,
      },
    });
    const payload = core.buildPayload({
      state: "working",
      event: "PreToolUse",
      ctx,
    });

    assert.strictEqual(payload.session_title.length, core.SESSION_TITLE_MAX);
    assert.strictEqual(payload.session_title.endsWith("\u2026"), true);
    assert.strictEqual(payload.session_title.startsWith("A"), true);
    assert.strictEqual(/[\u0000-\u001F\u007F-\u009F\u061C\u200E-\u200F\u202A-\u202E\u2066-\u2069]/.test(payload.session_title), false);

    // Astral characters and surrogate pairs are handled safely without splitting
    const astralTitle = "🎉".repeat(85);
    const sanitizedAstral = core.sanitizeSessionTitle(astralTitle);
    assert.strictEqual(Array.from(sanitizedAstral).length, 80);
    assert.strictEqual(sanitizedAstral.endsWith("\u2026"), true);
    assert.strictEqual(sanitizedAstral.isWellFormed(), true);
  });

  it("allows fallback behavior when native session name is empty, cleared, or missing", () => {
    for (const emptyVal of ["", "   ", "\u0000\u001F", null, undefined]) {
      const ctx = makeCtx({
        sessionManager: {
          getSessionId: () => "sess-fallback",
          getSessionName: () => emptyVal,
        },
      });
      const payload = core.buildPayload({
        state: "idle",
        event: "SessionStart",
        ctx,
      });

      assert.strictEqual(payload.session_title, undefined);
      assert.strictEqual(payload.session_title_clear, true);
    }

    const legacyManagerPayload = core.buildPayload({
      state: "idle",
      event: "SessionStart",
      ctx: makeCtx({ sessionManager: { getSessionId: () => "sess-legacy" } }),
    });
    assert.strictEqual(legacyManagerPayload.session_title_clear, undefined);
  });

  it("does not forward session file or cwd as session_title", () => {
    const ctx = makeCtx({
      cwd: "D:/work/secret_project",
      sessionManager: {
        getSessionId: () => "sess-no-cwd-title",
        getSessionFile: () => "/path/to/session.json",
        // getSessionName is undefined
      },
    });
    const payload = core.buildPayload({
      state: "idle",
      event: "SessionStart",
      ctx,
    });

    assert.strictEqual(payload.session_title, undefined);
    assert.strictEqual(payload.cwd, "D:/work/secret_project");
  });

  it("supports metadata_only in buildPayload and forwards it on session_info_changed", async () => {
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };
    const posts = [];
    core.attach(pi, {
      shouldReport: () => true,
      buildPayload: (options) => core.buildPayload(options),
      postState: async (payload) => {
        posts.push(payload);
        return true;
      },
    });

    const ctx = makeCtx({
      sessionManager: {
        getSessionId: () => "pi-session-meta",
        getSessionName: () => "Refactored Core",
      },
    });

    // Fire session_info_changed event
    await handlers.session_info_changed({ type: "session_info_changed" }, ctx);
    await Promise.resolve();

    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].metadata_only, true);
    assert.strictEqual(posts[0].session_title, "Refactored Core");
    assert.strictEqual(posts[0].event, "SessionUpdate");
    assert.strictEqual(posts[0].session_id, "pi:pi-session-meta");

    ctx.sessionManager.getSessionName = () => undefined;
    await handlers.session_info_changed({ type: "session_info_changed", name: null }, ctx);
    await Promise.resolve();
    assert.strictEqual(posts.length, 2);
    assert.strictEqual(posts[1].metadata_only, true);
    assert.strictEqual(posts[1].session_title, undefined);
    assert.strictEqual(posts[1].session_title_clear, true);
  });

  it("prefers explicit session_title options when provided", () => {
    const ctx = makeCtx({
      sessionManager: {
        getSessionId: () => "sess-1",
        getSessionName: () => "Native Title",
      },
    });
    const payload = core.buildPayload({
      state: "idle",
      event: "SessionStart",
      ctx,
      session_title: "Explicit Override",
    });

    assert.strictEqual(payload.session_title, "Explicit Override");
  });
});

describe("Pi state transport", () => {
  const validRemoteIdentity = Object.freeze({
    ok: true,
    version: 2,
    layoutVersion: 1,
    runtimeKey: "account-default",
    profileId: "remote-pi",
    installId: "a".repeat(64),
    remotePort: 23337,
    routingNonce: "b".repeat(32),
    deployedAt: 1,
  });

  function requestStub(calls, respond) {
    return (options, callback) => {
      calls.push(options);
      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = () => {
        queueMicrotask(() => {
          const response = new EventEmitter();
          response.headers = respond(options);
          response.setEncoding = () => {};
          response.resume = () => {};
          callback(response);
          response.emit("end");
        });
      };
      return request;
    };
  }

  function getStub(calls, respond) {
    return (options, callback) => {
      calls.push(options);
      const request = new EventEmitter();
      request.destroy = () => {};
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.headers = respond(options);
        response.setEncoding = () => {};
        response.resume = () => {};
        callback(response);
        response.emit("end");
      });
      return request;
    };
  }

  it("keeps local runtime-first delivery with fallback probing", async () => {
    const postCalls = [];
    const probeCalls = [];
    const delivered = await core.postStateToClawd({ agent_id: "pi", state: "idle" }, {
      sshSecure: false,
      runtimePort: 23335,
      httpRequest: requestStub(postCalls, (options) => (
        options.port === 23333 ? { "x-clawd-server": "clawd-on-desk" } : {}
      )),
      httpGet: getStub(probeCalls, (options) => (
        options.port === 23333 ? { "x-clawd-server": "clawd-on-desk" } : {}
      )),
    });

    assert.strictEqual(delivered, true);
    assert.deepStrictEqual(postCalls.map((call) => call.port), [23335, 23333]);
    assert.deepStrictEqual(probeCalls.map((call) => call.port), [23333]);
    assert.strictEqual(postCalls[0].headers["x-clawd-routing-nonce"], undefined);
    assert.strictEqual(postCalls[0].timeout, 100);
  });

  it("uses the remote identity's single port, nonce, and remote timeout", async () => {
    const postCalls = [];
    const delivered = await core.postStateToClawd({ agent_id: "pi", state: "working" }, {
      remoteIdentity: validRemoteIdentity,
      sshSecure: true,
      runtimePort: 23333,
      httpRequest: requestStub(postCalls, () => ({ "x-clawd-server": "clawd-on-desk" })),
    });

    assert.strictEqual(delivered, true);
    assert.strictEqual(postCalls.length, 1);
    assert.strictEqual(postCalls[0].port, 23337);
    assert.strictEqual(postCalls[0].headers["x-clawd-routing-nonce"], "b".repeat(32));
    assert.strictEqual(postCalls[0].timeout, 5000);
  });

  it("fails closed for an invalid secure identity and never falls back to local ports", async () => {
    let requested = false;
    const delivered = await core.postStateToClawd({ agent_id: "pi", state: "error" }, {
      sshSecure: true,
      remoteIdentity: { ok: false, reason: "identity-invalid" },
      remoteLastLogPath: "/definitely-not-used-by-this-test",
      fs: {
        statSync() { throw new Error("missing"); },
        mkdirSync() {},
        writeFileSync() {},
        chmodSync() {},
        renameSync() {},
        unlinkSync() {},
      },
      httpRequest() {
        requested = true;
        throw new Error("must not request when identity is invalid");
      },
    });

    assert.strictEqual(delivered, false);
    assert.strictEqual(requested, false);
  });
});

describe("Managed remote Pi chat correlation", () => {
  const validRemoteIdentity = Object.freeze({
    ok: true,
    version: 2,
    layoutVersion: 1,
    runtimeKey: "account-default",
    profileId: "remote-pi",
    installId: "a".repeat(64),
    remotePort: 23337,
    routingNonce: "b".repeat(32),
    deployedAt: 1,
  });

  const testPeerToken = "c".repeat(64);
  const testCapabilityToken = "d".repeat(64);

  function attachForChat(pi, deps) {
    return core.attach(pi, { now: () => 10_000, ...deps });
  }

  function createMockHttpCapture(posts) {
    return (options, callback) => {
      const chunks = [];
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = (data) => {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        const bodyStr = Buffer.concat(chunks).toString("utf8");
        let body = null;
        try { body = JSON.parse(bodyStr); } catch {}
        posts.push({
          path: options.path,
          method: options.method,
          headers: options.headers,
          port: options.port,
          body,
        });
        queueMicrotask(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = { "x-clawd-server": "clawd-on-desk" };
          callback(res);
          res.emit("data", JSON.stringify({ ok: true, status: "completed" }));
          res.emit("end");
        });
      };
      return req;
    };
  }

  it("busy misattribution: queued input during busy turn never activates before current turn completes", async () => {
    const httpPosts = [];
    const httpRequest = createMockHttpCapture(httpPosts);
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
      sendUserMessage() {
        return Promise.resolve();
      },
    };

    const attached = attachForChat(pi, {
      remoteIdentity: validRemoteIdentity,
      peerCapabilityToken: testPeerToken,
      capabilityToken: testCapabilityToken,
      httpRequest,
      shouldReport: () => true,
      postState: () => Promise.resolve(true),
    });

    const tracker = attached.getTracker();
    const ctx = makeCtx({
      sessionManager: { getSessionId: () => "sess-busy" },
    });

    // Start session
    await handlers.session_start({}, ctx);

    // 1. Turn 1 dispatched via remote consumer
    tracker.noteDispatchedUserMessage({
      commandId: "cmd-turn-1",
      text: "turn 1 request",
      rawSessionId: "pi:sess-busy",
      dispatchedAtMs: 1000,
    });

    // 2. Pi emits input event for Turn 1 (source: extension)
    handlers.input({ source: "extension", text: "turn 1 request" }, ctx);

    // 3. Pi begins Turn 1 with message_end (user)
    handlers.message_end({
      message: { role: "user", content: "turn 1 request" },
    }, ctx);

    assert.ok(tracker.getActiveCandidate());
    assert.strictEqual(tracker.getActiveCandidate().commandId, "cmd-turn-1");

    // 4. While Turn 1 is responding, Turn 2 is dispatched and queued
    tracker.noteDispatchedUserMessage({
      commandId: "cmd-turn-2",
      text: "turn 2 request",
      rawSessionId: "pi:sess-busy",
      dispatchedAtMs: 2000,
    });
    handlers.input({ source: "extension", text: "turn 2 request" }, ctx);

    // CRITICAL: Merely queued input must NOT activate Turn 2 while Turn 1 is still active
    assert.strictEqual(
      tracker.getActiveCandidate().commandId,
      "cmd-turn-1",
      "Queued input must never activate while current turn is active"
    );

    // 5. Turn 1 assistant responds
    handlers.message_end({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Turn 1 answer" }],
      },
    }, ctx);

    // 6. Turn 1 completes via agent_end
    await handlers.agent_end({}, ctx);

    // Verify Turn 1 was posted to /pet-chat/complete
    const completePosts = httpPosts.filter((p) => p.path === "/pet-chat/complete");
    assert.strictEqual(completePosts.length, 1);
    assert.strictEqual(completePosts[0].body.commandId, "cmd-turn-1");
    assert.strictEqual(completePosts[0].body.assistantText, "Turn 1 answer");
    assert.strictEqual(completePosts[0].body.rawSessionId, "pi:sess-busy");

    // 7. Now Turn 2 begins with message_end (user)
    handlers.message_end({
      message: { role: "user", content: "turn 2 request" },
    }, ctx);

    assert.ok(tracker.getActiveCandidate());
    assert.strictEqual(tracker.getActiveCandidate().commandId, "cmd-turn-2");

    // 8. Turn 2 assistant responds
    handlers.message_end({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Turn 2 answer" }],
      },
    }, ctx);

    // 9. Turn 2 completes via agent_end
    await handlers.agent_end({}, ctx);

    const allCompletePosts = httpPosts.filter((p) => p.path === "/pet-chat/complete");
    assert.strictEqual(allCompletePosts.length, 2);
    assert.strictEqual(allCompletePosts[1].body.commandId, "cmd-turn-2");
    assert.strictEqual(allCompletePosts[1].body.assistantText, "Turn 2 answer");

    attached.stopHeartbeat();
  });

  it("interactive input isolation: interactive user inputs never trigger chat complete posts", async () => {
    const httpPosts = [];
    const httpRequest = createMockHttpCapture(httpPosts);
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };

    const attached = attachForChat(pi, {
      remoteIdentity: validRemoteIdentity,
      peerCapabilityToken: testPeerToken,
      capabilityToken: testCapabilityToken,
      httpRequest,
      shouldReport: () => true,
      postState: () => Promise.resolve(true),
    });

    const tracker = attached.getTracker();
    const ctx = makeCtx({
      sessionManager: { getSessionId: () => "sess-interactive" },
    });

    await handlers.session_start({}, ctx);

    // Interactive user input (source is interactive / user / undefined)
    handlers.input({ source: "interactive", text: "human typed message" }, ctx);
    handlers.message_end({
      message: { role: "user", content: "human typed message" },
    }, ctx);

    // Tracker must NOT have an active pet candidate
    assert.strictEqual(tracker.getActiveCandidate(), null);

    // Assistant responds to the human
    handlers.message_end({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "assistant response to human" }],
      },
    }, ctx);

    // Agent ends turn
    await handlers.agent_end({}, ctx);

    // No /pet-chat/complete posts should ever be made for interactive input
    const completePosts = httpPosts.filter((p) => p.path === "/pet-chat/complete");
    assert.strictEqual(completePosts.length, 0);

    attached.stopHeartbeat();
  });

  it("exact authenticated body: verifies all properties and headers sent to /pet-chat/complete", async () => {
    const httpPosts = [];
    const httpRequest = createMockHttpCapture(httpPosts);
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };

    const attached = attachForChat(pi, {
      remoteIdentity: validRemoteIdentity,
      peerCapabilityToken: testPeerToken,
      capabilityToken: testCapabilityToken,
      httpRequest,
      shouldReport: () => true,
      postState: () => Promise.resolve(true),
    });

    const tracker = attached.getTracker();
    const ctx = makeCtx({
      sessionManager: { getSessionId: () => "sess-exact-auth" },
    });

    await handlers.session_start({}, ctx);

    tracker.noteDispatchedUserMessage({
      commandId: "cmd-exact-99",
      text: "tell me a secret",
      rawSessionId: "pi:sess-exact-auth",
      dispatchedAtMs: 5000,
    });

    handlers.input({ source: "extension", text: "tell me a secret" }, ctx);
    handlers.message_end({
      message: { role: "user", content: "tell me a secret" },
    }, ctx);
    handlers.message_end({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "The secret is chocolate." },
        ],
      },
    }, ctx);

    await handlers.agent_end({}, ctx);

    const completePosts = httpPosts.filter((p) => p.path === "/pet-chat/complete");
    assert.strictEqual(completePosts.length, 1);
    const post = completePosts[0];

    // Transport headers
    assert.strictEqual(post.path, "/pet-chat/complete");
    assert.strictEqual(post.method, "POST");
    assert.strictEqual(post.port, 23337);
    assert.strictEqual(post.headers["x-clawd-routing-nonce"], "b".repeat(32));
    assert.strictEqual(post.headers["Content-Type"], "application/json");

    // Exact authenticated body
    assert.deepStrictEqual(post.body, {
      schemaVersion: "1",
      kind: "pet_chat_complete",
      rawSessionId: "pi:sess-exact-auth",
      capabilityToken: testPeerToken,
      commandId: "cmd-exact-99",
      assistantText: "The secret is chocolate.",
    });

    // Check exact keys
    assert.deepStrictEqual(
      Object.keys(post.body).sort(),
      ["assistantText", "capabilityToken", "commandId", "kind", "rawSessionId", "schemaVersion"]
    );

    attached.stopHeartbeat();
  });

  it("thinking/tool privacy: filters out thinking and tool blocks, handles error/abort", async () => {
    const httpPosts = [];
    const httpRequest = createMockHttpCapture(httpPosts);
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };

    const attached = attachForChat(pi, {
      remoteIdentity: validRemoteIdentity,
      peerCapabilityToken: testPeerToken,
      capabilityToken: testCapabilityToken,
      httpRequest,
      shouldReport: () => true,
      postState: () => Promise.resolve(true),
    });

    const tracker = attached.getTracker();
    const ctx = makeCtx({
      sessionManager: { getSessionId: () => "sess-privacy" },
    });

    await handlers.session_start({}, ctx);

    // Turn 1: mixed thinking, tool_use, and text blocks
    tracker.noteDispatchedUserMessage({
      commandId: "cmd-privacy-1",
      text: "check files",
      rawSessionId: "pi:sess-privacy",
      dispatchedAtMs: 1000,
    });
    handlers.input({ source: "extension", text: "check files" }, ctx);
    handlers.message_end({
      message: { role: "user", content: "check files" },
    }, ctx);

    // Intermediate tool call message (no text blocks)
    handlers.message_end({
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I need to run ls" },
          { type: "tool_use", name: "bash", input: { command: "ls -la" } },
        ],
      },
    }, ctx);

    // Final response message (thinking + text blocks)
    handlers.message_end({
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Now summarizing results" },
          { type: "text", text: "Found\u0000" },
          { type: "text", text: "3 files." },
        ],
      },
    }, ctx);

    await handlers.agent_end({}, ctx);

    const completePosts = httpPosts.filter((p) => p.path === "/pet-chat/complete");
    assert.strictEqual(completePosts.length, 1);
    assert.strictEqual(completePosts[0].body.assistantText, "Found\n3 files.");
    // Ensure thinking / tool fields are never present
    assert.strictEqual(completePosts[0].body.thinking, undefined);
    assert.strictEqual(completePosts[0].body.tool_use, undefined);
    assert.strictEqual(completePosts[0].body.toolName, undefined);

    // Turn 2: error/aborted assistant is not final
    tracker.noteDispatchedUserMessage({
      commandId: "cmd-privacy-2",
      text: "error turn",
      rawSessionId: "pi:sess-privacy",
      dispatchedAtMs: 2000,
    });
    handlers.input({ source: "extension", text: "error turn" }, ctx);
    handlers.message_end({
      message: { role: "user", content: "error turn" },
    }, ctx);

    handlers.message_end({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial output before crash" }],
        stop_reason: "error",
      },
    }, ctx);

    await handlers.agent_end({}, ctx);

    // Turn 2 should NOT have posted because it was errored/aborted
    const afterTurn2 = httpPosts.filter((p) => p.path === "/pet-chat/complete");
    assert.strictEqual(afterTurn2.length, 1);

    // Turn 3: agent_end itself has error/abort
    tracker.noteDispatchedUserMessage({
      commandId: "cmd-privacy-3",
      text: "aborted turn",
      rawSessionId: "pi:sess-privacy",
      dispatchedAtMs: 3000,
    });
    handlers.input({ source: "extension", text: "aborted turn" }, ctx);
    handlers.message_end({
      message: { role: "user", content: "aborted turn" },
    }, ctx);
    handlers.message_end({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "some text" }],
      },
    }, ctx);

    await handlers.agent_end({ aborted: true }, ctx);

    const afterTurn3 = httpPosts.filter((p) => p.path === "/pet-chat/complete");
    assert.strictEqual(afterTurn3.length, 1);

    attached.stopHeartbeat();
  });

  it("resets tracker on session_start, session_shutdown, and reload", async () => {
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };

    const attached = attachForChat(pi, {
      remoteIdentity: validRemoteIdentity,
      peerCapabilityToken: testPeerToken,
      capabilityToken: testCapabilityToken,
      shouldReport: () => true,
      postState: () => Promise.resolve(true),
    });

    const tracker = attached.getTracker();
    const ctx = makeCtx({
      sessionManager: { getSessionId: () => "sess-reset" },
    });

    // Populate tracker
    tracker.noteDispatchedUserMessage({ commandId: "c1", text: "t1", dispatchedAtMs: 100 });
    handlers.input({ source: "extension", text: "t1" }, ctx);
    assert.strictEqual(tracker.getPendingOrigins().length, 1);

    // 1. Reset on session_start
    await handlers.session_start({}, ctx);
    assert.strictEqual(tracker.getPendingDispatches().length, 0);
    assert.strictEqual(tracker.getPendingOrigins().length, 0);
    assert.strictEqual(tracker.getActiveCandidate(), null);

    // Populate again
    tracker.noteDispatchedUserMessage({ commandId: "c2", text: "t2", dispatchedAtMs: 200 });
    handlers.input({ source: "extension", text: "t2" }, ctx);
    assert.strictEqual(tracker.getPendingOrigins().length, 1);

    // 2. Reset on extension reload (shutdown with reason: reload)
    await handlers.session_shutdown({ reason: "reload" }, ctx);
    assert.strictEqual(tracker.getPendingDispatches().length, 0);
    assert.strictEqual(tracker.getPendingOrigins().length, 0);
    assert.strictEqual(tracker.getActiveCandidate(), null);

    // Populate again
    tracker.noteDispatchedUserMessage({ commandId: "c3", text: "t3", dispatchedAtMs: 300 });
    handlers.input({ source: "extension", text: "t3" }, ctx);
    assert.strictEqual(tracker.getPendingOrigins().length, 1);

    // 3. Reset on normal session_shutdown
    await handlers.session_shutdown({}, ctx);
    assert.strictEqual(tracker.getPendingDispatches().length, 0);
    assert.strictEqual(tracker.getPendingOrigins().length, 0);
    assert.strictEqual(tracker.getActiveCandidate(), null);

    attached.stopHeartbeat();
  });

  it("chat completion post failure is swallowed and never alters settlement", async () => {
    let completeRequested = false;
    const httpRequest = (options, callback) => {
      if (options.path === "/pet-chat/complete") {
        completeRequested = true;
        const req = new EventEmitter();
        req.destroy = () => {};
        req.end = () => {
          queueMicrotask(() => {
            req.emit("error", new Error("network partition during complete"));
          });
        };
        return req;
      }
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = () => {
        queueMicrotask(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = { "x-clawd-server": "clawd-on-desk" };
          callback(res);
          res.emit("end");
        });
      };
      return req;
    };

    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };

    const attached = attachForChat(pi, {
      remoteIdentity: validRemoteIdentity,
      peerCapabilityToken: testPeerToken,
      capabilityToken: testCapabilityToken,
      httpRequest,
      shouldReport: () => true,
      postState: () => Promise.resolve(true),
    });

    const tracker = attached.getTracker();
    const ctx = makeCtx({
      sessionManager: { getSessionId: () => "sess-swallow" },
    });

    await handlers.session_start({}, ctx);

    tracker.noteDispatchedUserMessage({
      commandId: "cmd-swallow",
      text: "trigger complete error",
      rawSessionId: "pi:sess-swallow",
      dispatchedAtMs: 1000,
    });
    handlers.input({ source: "extension", text: "trigger complete error" }, ctx);
    handlers.message_end({
      message: { role: "user", content: "trigger complete error" },
    }, ctx);
    handlers.message_end({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "output before failure" }],
      },
    }, ctx);

    // agent_end should not throw or reject
    await assert.doesNotReject(async () => {
      await handlers.agent_end({}, ctx);
    });

    assert.strictEqual(completeRequested, true);
    attached.stopHeartbeat();
  });
});
