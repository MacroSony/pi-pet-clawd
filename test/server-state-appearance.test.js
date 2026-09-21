"use strict";

// Integration tests for the /state endpoint's optional appearance_context
// trust boundary. These exercise the real server route, not a helper.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { EventEmitter } = require("node:events");

const initServer = require("../src/server");
const { resolveSessionIdentity } = require("../src/session-key");

const PROJECT_KEY = "a".repeat(64);

function makeFakeHttp() {
  let capturedHandler = null;
  function createHttpServer(handler) {
    capturedHandler = handler;
    const server = new EventEmitter();
    server.listen = function () { this.emit("listening"); };
    server.close = function () {};
    return server;
  }
  return { createHttpServer, getHandler: () => capturedHandler };
}

function makeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  setImmediate(() => {
    if (body != null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function callHandler(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: null,
      headers: {},
      body: "",
      writeHead(code, headers) {
        this.statusCode = code;
        if (headers) this.headers = headers;
      },
      end(data) {
        if (data) this.body += String(data);
        resolve(this);
      },
    };
    handler(req, res);
  });
}

function postJsonThroughIngress(port, body, nonce) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/state",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "x-clawd-routing-nonce": nonce,
      },
    }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { responseBody += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, body: responseBody }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function makeCtx(overrides = {}) {
  const updateSessionCalls = [];
  const updateSessionMetadataCalls = [];
  const ctx = {
    createHttpServer: null,
    setImmediate: () => {},
    getPortCandidates: () => [23333],
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    readRuntimePort: () => null,
    syncClawdHooksImpl: () => {},
    syncGeminiHooksImpl: () => {},
    syncCursorHooksImpl: () => {},
    syncCodeBuddyHooksImpl: () => {},
    syncKiroHooksImpl: () => {},
    syncQwenHooksImpl: () => {},
    syncOpencodePluginImpl: () => {},
    STATE_SVGS: { idle: "x.svg", working: "x.svg", thinking: "x.svg", attention: "x.svg", sweeping: "x.svg" },
    pendingPermissions: [],
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    setState: () => {},
    updateSession: (...args) => updateSessionCalls.push(args),
    updateSessionMetadata: (...args) => { updateSessionMetadataCalls.push(args); return true; },
    resolvePermissionEntry: () => {},
    permLog: () => {},
    updateLog: () => {},
    ...overrides,
  };
  return { ctx, updateSessionCalls, updateSessionMetadataCalls };
}

function startServer(overrides) {
  const http = makeFakeHttp();
  const { ctx, updateSessionCalls, updateSessionMetadataCalls } = makeCtx(overrides);
  ctx.createHttpServer = http.createHttpServer;
  const api = initServer(ctx);
  api.startHttpServer();
  return { handler: http.getHandler(), updateSessionCalls, updateSessionMetadataCalls, api };
}

const FORGE_CONTEXT = {
  schemaVersion: "1",
  source: "pi-forge",
  instanceId: "publisher-a",
  revision: 3,
  stackKey: "global:work",
  profileKey: "project:reviewer",
  projectKey: PROJECT_KEY,
};

describe("/state appearance_context handling", () => {
  it("passes a validated Pi appearance context through to updateSession", async () => {
    const { handler, updateSessionCalls } = startServer();
    const res = await callHandler(handler, makeReq("POST", "/state", JSON.stringify({
      state: "working",
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: "pi:s1",
      event: "SessionStart",
      appearance_context: FORGE_CONTEXT,
    })));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(updateSessionCalls.length, 1);
    assert.deepStrictEqual(updateSessionCalls[0][3].appearanceContext, FORGE_CONTEXT);
  });

  it("drops a malformed appearance context instead of clearing it", async () => {
    const { handler, updateSessionCalls } = startServer();
    await callHandler(handler, makeReq("POST", "/state", JSON.stringify({
      state: "working",
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: "pi:s1",
      event: "PreToolUse",
      // Path/prompt-like extra keys and an invalid project key must be dropped.
      appearance_context: { ...FORGE_CONTEXT, projectKey: "not-a-sha", prompt: "SECRET" },
    })));
    assert.strictEqual(updateSessionCalls[0][3].appearanceContext, undefined);
  });

  it("does not accept appearance context from a non-Pi agent", async () => {
    const { handler, updateSessionCalls } = startServer();
    await callHandler(handler, makeReq("POST", "/state", JSON.stringify({
      state: "working",
      agent_id: "claude-code",
      session_id: "claude:s1",
      event: "PreToolUse",
      appearance_context: FORGE_CONTEXT,
    })));
    assert.strictEqual(updateSessionCalls[0][3].appearanceContext, undefined);
  });

  it("routes metadata-only appearance updates through updateSessionMetadata", async () => {
    const { handler, updateSessionMetadataCalls, updateSessionCalls } = startServer();
    const res = await callHandler(handler, makeReq("POST", "/state", JSON.stringify({
      state: "idle",
      metadata_only: true,
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: "pi:s1",
      event: "SessionUpdate",
      appearance_context: { ...FORGE_CONTEXT, revision: 4 },
    })));
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(updateSessionCalls.length, 0, "metadata-only must not enter the lifecycle machine");
    assert.strictEqual(updateSessionMetadataCalls.length, 1);
    assert.strictEqual(
      updateSessionMetadataCalls[0][0],
      resolveSessionIdentity("pi:s1", "local").sessionId
    );
    assert.deepStrictEqual(updateSessionMetadataCalls[0][1].appearanceContext, { ...FORGE_CONTEXT, revision: 4 });
  });

  it("forwards an explicit null clear on the metadata-only channel", async () => {
    const { handler, updateSessionMetadataCalls } = startServer();
    await callHandler(handler, makeReq("POST", "/state", JSON.stringify({
      state: "idle",
      metadata_only: true,
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: "pi:s1",
      event: "SessionUpdate",
      appearance_context: null,
    })));
    assert.strictEqual(updateSessionMetadataCalls.length, 1);
    assert.strictEqual(updateSessionMetadataCalls[0][1].appearanceContext, null);
  });

  it("retains a validated appearance context through the real remote SSH ingress HTTP path", async () => {
    const { api, updateSessionCalls } = startServer();
    const nonce = "f".repeat(32);
    const ingress = api.openRemoteSshIngress({
      remoteProfile: { profileId: "remote-mac", displayHost: "macbook" },
      getAcceptedNonces: () => [nonce],
    });
    const port = await ingress.start();
    try {
      const res = await postJsonThroughIngress(port, JSON.stringify({
        state: "working",
        agent_id: "pi",
        hook_source: "pi-extension",
        session_id: "pi:remote-s1",
        event: "SessionStart",
        appearance_context: FORGE_CONTEXT,
      }), nonce);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(updateSessionCalls.length, 1, "remote ingress must reach updateSession once");
      assert.deepStrictEqual(updateSessionCalls[0][3].appearanceContext, FORGE_CONTEXT);
    } finally {
      ingress.close();
    }
  });
});
