"use strict";

const crypto = require("node:crypto");
const http = require("node:http");

// This module deliberately delegates state delivery to the same transport used
// by every other Clawd hook. In particular, server-config detects a colocated
// clawd-remote.json and then pins the remote forward port, attaches the routing
// nonce, and fails closed rather than scanning local ports.
const serverConfig = require("./server-config");

const PI_AGENT_ID = "pi";
const PI_HOOK_SOURCE = "pi-extension";
const PEER_CAPABILITY_SLOT_SYMBOL = Symbol.for("pi-pet.peer-capability.v1");
const HEARTBEAT_INTERVAL_MS = 60_000;
const INBOX_POLL_INTERVAL_MS = 1_000;
const INBOX_RETRY_INTERVAL_MS = 1_000;
const INBOX_SETTLE_DEADLINE_MS = 60_000;
const MAX_INBOX_REQUEST_BYTES = 16 * 1024;
const MAX_INBOX_RESPONSE_BYTES = 64 * 1024;
const INBOX_HTTP_TIMEOUT_MS = 5_000;

// Kept in step with hooks/shared-process.js NESTED_TERMINAL_ENV; duplicated
// rather than imported because this module ships standalone in the Pi extension.
const NESTED_TERMINAL_ENV = [
  "WT_SESSION",
  "ALACRITTY_WINDOW_ID",
  "WEZTERM_PANE",
  "KITTY_WINDOW_ID",
  "KONSOLE_VERSION",
  "GNOME_TERMINAL_SCREEN",
  "ConEmuPID",
  "TMUX",
  "STY",
  "ZELLIJ",
];

const DEFAULT_EVENT_BINDINGS = Object.freeze([
  Object.freeze(["session_start", "SessionStart", "idle"]),
  Object.freeze(["before_agent_start", "UserPromptSubmit", "thinking"]),
  Object.freeze(["agent_end", "Stop", "attention"]),
  Object.freeze(["session_before_compact", "PreCompact", "sweeping"]),
  Object.freeze(["session_compact", "PostCompact", "attention"]),
]);

function parseMode(argv = process.argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-p" || arg === "--print") return "print";
    if (arg === "--mode") {
      const value = args[i + 1];
      if (value === "print" || value === "json" || value === "rpc") return value;
    }
    if (typeof arg === "string" && arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (value === "print" || value === "json" || value === "rpc") return value;
    }
  }
  return "interactive";
}

function isInteractiveMode(runtime = {}) {
  const mode = parseMode(runtime.argv || process.argv);
  if (mode !== "interactive") return false;
  const stdin = runtime.stdin || process.stdin;
  const stdout = runtime.stdout || process.stdout;
  return !!(stdin && stdin.isTTY && stdout && stdout.isTTY);
}

function shouldReport(ctx, runtime = {}) {
  if (ctx && typeof ctx.hasUI === "boolean") return ctx.hasUI;
  return isInteractiveMode(runtime);
}

function safeString(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function safePositiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function safeCall(fn) {
  if (typeof fn !== "function") return null;
  try {
    return fn();
  } catch {
    return null;
  }
}

function readSessionId(ctx) {
  const manager = ctx && ctx.sessionManager;
  const candidates = [
    safeCall(manager && manager.getSessionId && manager.getSessionId.bind(manager)),
    safeCall(manager && manager.getSessionFile && manager.getSessionFile.bind(manager)),
  ];
  for (const candidate of candidates) {
    const value = safeString(candidate, "");
    if (value) return value;
  }
  return "default";
}

function getCanonicalRawSessionId(ctx) {
  const raw = readSessionId(ctx);
  if (!raw || raw === "default") return `${PI_AGENT_ID}:default`;
  if (raw.startsWith(`${PI_AGENT_ID}:`)) return raw;
  return `${PI_AGENT_ID}:${raw}`;
}

function isStartableRawSessionId(rawSessionId) {
  if (typeof rawSessionId !== "string") return false;
  const trimmed = rawSessionId.trim();
  if (
    !trimmed
    || trimmed === "default"
    || trimmed === `${PI_AGENT_ID}:default`
    || trimmed === `${PI_AGENT_ID}:`
  ) {
    return false;
  }
  if (/[\0\r\n]/.test(rawSessionId) || rawSessionId.length > 4096) {
    return false;
  }
  return true;
}

function generateCapabilityToken() {
  return crypto.randomBytes(32).toString("hex");
}

function isValidCapabilityToken(token) {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token);
}

function isUsableRemoteIdentity(identity) {
  return Boolean(
    identity
    && identity.ok === true
    && Number.isInteger(identity.remotePort)
    && identity.remotePort >= 1
    && identity.remotePort <= 65_535
    && typeof identity.routingNonce === "string"
    && /^[0-9a-f]{32}$/.test(identity.routingNonce)
  );
}

function validateClaimedMessage(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "claimed payload must be an object" };
  }
  const commandId = typeof data.commandId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(data.commandId)
    ? data.commandId
    : null;
  const claimToken = typeof data.claimToken === "string" && data.claimToken.length >= 1 && data.claimToken.length <= 128
    ? data.claimToken
    : null;
  const text = typeof data.text === "string" && data.text.length >= 1 && data.text.length <= 2000
    ? data.text
    : null;
  const deliverAs = data.deliverAs === "followUp" ? data.deliverAs : null;
  const expiresAtMs = typeof data.expiresAtMs === "number" && Number.isFinite(data.expiresAtMs) && data.expiresAtMs > 0
    ? data.expiresAtMs
    : null;

  if (!commandId || !claimToken || !text || !deliverAs || expiresAtMs === null) {
    return {
      ok: false,
      reason: "invalid claimed message payload",
      commandId,
      claimToken,
    };
  }

  const claimedAtMs = typeof data.claimedAtMs === "number" && Number.isFinite(data.claimedAtMs) && data.claimedAtMs > 0
    ? data.claimedAtMs
    : null;

  return {
    ok: true,
    commandId,
    claimToken,
    text,
    deliverAs,
    expiresAtMs,
    claimedAtMs,
  };
}

function addToolFields(payload, nativeEvent) {
  if (!nativeEvent || typeof nativeEvent !== "object") return;
  const toolName = safeString(nativeEvent.toolName, "");
  const toolCallId = safeString(nativeEvent.toolCallId, "");
  if (toolName) payload.tool_name = toolName;
  if (toolCallId) payload.tool_use_id = toolCallId;
}

function buildPayload(options = {}) {
  const ctx = options.ctx || {};
  const metadata = options.metadata || {};
  const payload = {
    agent_id: PI_AGENT_ID,
    hook_source: PI_HOOK_SOURCE,
    event: safeString(options.event, "SessionStart"),
    state: safeString(options.state, "idle"),
    session_id: getCanonicalRawSessionId(ctx),
  };

  const agentPid = safePositiveInteger(options.agentPid);
  if (agentPid) payload.agent_pid = agentPid;

  const cwd = safeString(metadata.cwd, "") || safeString(ctx.cwd, "");
  if (cwd) payload.cwd = cwd;

  const sourcePid = safePositiveInteger(metadata.sourcePid);
  if (sourcePid) payload.source_pid = sourcePid;

  const pidChain = Array.isArray(metadata.pidChain)
    ? metadata.pidChain.map(safePositiveInteger).filter(Boolean).slice(0, 12)
    : [];
  if (pidChain.length > 0) payload.pid_chain = pidChain;

  const tmuxSocket = typeof metadata.tmuxSocket === "string" && /^[\w.-]{1,64}$/.test(metadata.tmuxSocket)
    ? metadata.tmuxSocket : (
      typeof metadata.tmuxSocket === "string"
        && metadata.tmuxSocket.startsWith("/")
        && metadata.tmuxSocket.length <= 4096
        && !/[\0\r\n]/.test(metadata.tmuxSocket)
        ? metadata.tmuxSocket : null
    );
  if (tmuxSocket) payload.tmux_socket = tmuxSocket;

  const tmuxClient = typeof metadata.tmuxClient === "string"
    && metadata.tmuxClient.length <= 256
    && !metadata.tmuxClient.startsWith("-")
    && /^[\w./:-]+$/.test(metadata.tmuxClient)
    ? metadata.tmuxClient : null;
  if (tmuxClient) payload.tmux_client = tmuxClient;

  // Unlike the fields above, this one is not resolver metadata — the extension
  // runs in-process with the Pi CLI, so Orca's pane key is simply in the env.
  // Validated locally rather than imported because this module ships standalone
  // inside the Pi extension. `options.env` keeps payload assertions hermetic.
  // A terminal that advertises itself in the environment means a real terminal
  // inherited the pane key from the Orca pane it was launched from and lives in
  // its own window — see orcaPaneKeyFromEnv in shared-process.js for the list and
  // the residual gap.
  const env = options.env || process.env;
  const inOrcaPane = !!env && env.TERM_PROGRAM === "Orca" && !NESTED_TERMINAL_ENV.some((key) => env[key]);
  const rawPaneKey = inOrcaPane && typeof env.ORCA_PANE_KEY === "string"
    ? env.ORCA_PANE_KEY.trim() : null;
  const orcaPaneKey = rawPaneKey
    && rawPaneKey.length <= 256
    && /^[\w-]+:[\w-]+$/.test(rawPaneKey)
    ? rawPaneKey : null;
  if (orcaPaneKey) payload.orca_pane_key = orcaPaneKey;

  if (metadata.editor === "code" || metadata.editor === "cursor") {
    payload.editor = metadata.editor;
  }

  addToolFields(payload, options.nativeEvent);
  if (options.livenessOnly === true) payload.liveness_only = true;

  if (options.capabilityToken && isValidCapabilityToken(options.capabilityToken)) {
    payload.pet_inbox_capability = {
      version: 1,
      receiveUserMessage: true,
      token: options.capabilityToken,
    };
  }

  if (
    options.peerCapabilityToken
    && isValidCapabilityToken(options.peerCapabilityToken)
    && isStartableRawSessionId(payload.session_id)
  ) {
    payload.pet_peer_capability = {
      version: 1,
      receivePeerMessage: true,
      token: options.peerCapabilityToken,
    };
  }

  return payload;
}

function postStateToClawd(payload, options = {}) {
  // A Pi extension is loaded in a fresh Pi process, so it does not inherit the
  // deployer's CLAWD_REMOTE environment. Preserve server-config's normal local
  // behavior, but explicitly select its remote timeout when its colocated
  // identity activates secure transport.
  const deliveryOptions = serverConfig.isSshSecureMode(options)
    ? { ...options, remote: true }
    : options;
  return new Promise((resolve) => {
    try {
      serverConfig.postStateToRunningServer(payload, deliveryOptions, (ok) => resolve(ok === true));
    } catch {
      resolve(false);
    }
  });
}

function chainDelivery(chains, key, task) {
  const previous = chains.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .catch(() => {});
  chains.set(key, next);
  const cleanup = () => {
    if (chains.get(key) === next) chains.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

function postInboxJson({
  identity,
  path: reqPath,
  payload,
  httpRequest = http.request,
  timeoutMs = INBOX_HTTP_TIMEOUT_MS,
}) {
  return new Promise((resolve) => {
    if (!isUsableRemoteIdentity(identity)) {
      resolve({ ok: false, status: 0, reason: "invalid-identity" });
      return;
    }

    let bodyStr;
    try {
      bodyStr = typeof payload === "string" ? payload : JSON.stringify(payload);
    } catch {
      resolve({ ok: false, status: 0, reason: "bad-json-payload" });
      return;
    }

    const bodyLen = Buffer.byteLength(bodyStr, "utf8");
    if (bodyLen > MAX_INBOX_REQUEST_BYTES) {
      resolve({ ok: false, status: 0, reason: "request-too-large" });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let req;
    try {
      req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: identity.remotePort,
          path: reqPath,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": bodyLen,
            [serverConfig.ROUTING_NONCE_HEADER]: identity.routingNonce,
          },
          timeout: timeoutMs,
        },
        (res) => {
          const serverHeader = res.headers && (
            res.headers[serverConfig.CLAWD_SERVER_HEADER]
            || res.headers[serverConfig.CLAWD_SERVER_HEADER.toLowerCase()]
          );
          const headerVal = Array.isArray(serverHeader) ? serverHeader[0] : serverHeader;
          if (headerVal !== serverConfig.CLAWD_SERVER_ID) {
            try { res.destroy(); } catch {}
            finish({ ok: false, status: res.statusCode || 0, reason: "invalid-server-header" });
            return;
          }

          let receivedBytes = 0;
          const chunks = [];
          let tooLarge = false;

          res.on("data", (chunk) => {
            if (tooLarge) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            receivedBytes += buf.length;
            if (receivedBytes > MAX_INBOX_RESPONSE_BYTES) {
              tooLarge = true;
              chunks.length = 0;
              try { req.destroy(); } catch {}
              try { res.destroy(); } catch {}
              finish({ ok: false, status: res.statusCode || 0, reason: "response-too-large" });
              return;
            }
            chunks.push(buf);
          });

          res.on("end", () => {
            if (tooLarge) return;
            const responseText = Buffer.concat(chunks).toString("utf8");
            let data = null;
            if (responseText) {
              try {
                data = JSON.parse(responseText);
              } catch {
                finish({ ok: false, status: res.statusCode || 0, reason: "bad-json-response" });
                return;
              }
            }
            const ok = Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300);
            finish({ ok, status: res.statusCode || 0, data });
          });

          res.on("aborted", () => {
            finish({ ok: false, status: 0, reason: "response-aborted" });
          });
          res.on("error", (err) => {
            finish({ ok: false, status: 0, reason: (err && err.message) || "stream-error" });
          });
        }
      );
    } catch (err) {
      finish({ ok: false, status: 0, reason: (err && err.message) || "request-init-error" });
      return;
    }

    req.on("error", (err) => {
      finish({ ok: false, status: 0, reason: (err && err.message) || "transport-error" });
    });

    req.on("timeout", () => {
      try { req.destroy(); } catch {}
      finish({ ok: false, status: 0, reason: "timeout" });
    });

    try {
      req.end(bodyStr);
    } catch (err) {
      finish({ ok: false, status: 0, reason: (err && err.message) || "request-write-error" });
    }
  });
}

function createRemoteInboxConsumer({
  pi,
  identity,
  rawSessionId,
  capabilityToken,
  httpRequest = http.request,
  setTimeout: setTimeoutFn = setTimeout,
  clearTimeout: clearTimeoutFn = clearTimeout,
  now: nowFn = Date.now,
  pollIntervalMs = INBOX_POLL_INTERVAL_MS,
  retryIntervalMs = INBOX_RETRY_INTERVAL_MS,
  settleDeadlineMs = INBOX_SETTLE_DEADLINE_MS,
}) {
  let active = true;
  let timer = null;
  let inFlight = false;
  let pendingSettlement = null;

  function stop() {
    active = false;
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function scheduleNext(delayMs) {
    if (!active) return;
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
    timer = setTimeoutFn(tick, delayMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  }

  async function tick() {
    if (!active || inFlight) return;
    inFlight = true;
    try {
      if (pendingSettlement) {
        await processPendingSettlement();
      } else {
        await processClaim();
      }
    } catch {
      if (active) {
        scheduleNext(pollIntervalMs);
      }
    } finally {
      inFlight = false;
    }
  }

  async function processPendingSettlement() {
    const currentNow = nowFn();
    if (currentNow >= pendingSettlement.deadlineMs) {
      pendingSettlement = null;
      if (active) scheduleNext(pollIntervalMs);
      return;
    }

    const settleBody = {
      schemaVersion: "1",
      kind: "user_message_settle",
      rawSessionId,
      capabilityToken,
      commandId: pendingSettlement.commandId,
      claimToken: pendingSettlement.claimToken,
      status: pendingSettlement.status,
      ...(pendingSettlement.reason ? { reason: pendingSettlement.reason } : {}),
    };

    const result = await postInboxJson({
      identity,
      path: "/pet-inbox/settle",
      payload: settleBody,
      httpRequest,
    });

    if (!active) return;

    const responseStatus = result.data && typeof result.data === "object"
      ? result.data.status
      : null;
    const acceptedTerminal = result.ok
      && ["dispatched", "failed", "expired", "rejected"].includes(responseStatus);
    const trustedPermanentRejection = [400, 404, 422].includes(result.status)
      && responseStatus === "rejected";
    if (acceptedTerminal || trustedPermanentRejection) {
      pendingSettlement = null;
      scheduleNext(pollIntervalMs);
      return;
    }

    if (nowFn() >= pendingSettlement.deadlineMs) {
      pendingSettlement = null;
      scheduleNext(pollIntervalMs);
    } else {
      scheduleNext(retryIntervalMs);
    }
  }

  async function processClaim() {
    const claimBody = {
      schemaVersion: "1",
      kind: "user_message_claim",
      rawSessionId,
      capabilityToken,
    };

    const result = await postInboxJson({
      identity,
      path: "/pet-inbox/claim",
      payload: claimBody,
      httpRequest,
    });

    if (!active) return;

    if (!result.ok) {
      scheduleNext(pollIntervalMs);
      return;
    }

    const data = result.data;
    if (!data || typeof data !== "object") {
      scheduleNext(pollIntervalMs);
      return;
    }

    if (data.status === "empty") {
      scheduleNext(pollIntervalMs);
      return;
    }

    if (data.status !== "claimed") {
      scheduleNext(pollIntervalMs);
      return;
    }

    const validation = validateClaimedMessage(data);
    if (!validation.ok) {
      if (validation.commandId && validation.claimToken) {
        const claimTime = nowFn();
        pendingSettlement = {
          commandId: validation.commandId,
          claimToken: validation.claimToken,
          status: "failed",
          reason: "invalid claimed message payload",
          deadlineMs: claimTime + settleDeadlineMs,
        };
        await processPendingSettlement();
        return;
      }
      scheduleNext(pollIntervalMs);
      return;
    }

    const { commandId, claimToken, text, expiresAtMs, claimedAtMs } = validation;
    const claimTime = nowFn();
    const deadlineMs = (claimedAtMs && claimedAtMs > 0 ? claimedAtMs : claimTime) + settleDeadlineMs;

    // A response that arrives after the coordinator's claim lease may already
    // have been finalized as delivery-unknown. Never inject such a late claim.
    if (claimTime >= deadlineMs) {
      scheduleNext(pollIntervalMs);
      return;
    }

    if (claimTime >= expiresAtMs) {
      pendingSettlement = {
        commandId,
        claimToken,
        status: "expired",
        reason: "message ttl expired before dispatch",
        deadlineMs,
      };
      await processPendingSettlement();
      return;
    }

    let dispatchSuccess = false;
    let dispatchError = null;
    try {
      if (typeof pi.sendUserMessage === "function") {
        const dispatchResult = pi.sendUserMessage(text, {
          deliverAs: "followUp",
          expandPromptTemplates: false,
        });
        if (dispatchResult && typeof dispatchResult.then === "function") {
          await dispatchResult;
        }
        dispatchSuccess = true;
      } else {
        dispatchError = "pi.sendUserMessage is not a function";
      }
    } catch (err) {
      dispatchSuccess = false;
      dispatchError = (err && err.message) ? err.message : "dispatch failed";
    }

    if (!active) return;

    pendingSettlement = {
      commandId,
      claimToken,
      status: dispatchSuccess ? "dispatched" : "failed",
      ...(dispatchError ? { reason: dispatchError } : {}),
      deadlineMs,
    };

    await processPendingSettlement();
  }

  scheduleNext(0);

  return {
    stop,
    getPendingSettlement: () => pendingSettlement,
    isActive: () => active,
  };
}

function attach(pi, deps = {}) {
  if (!pi || typeof pi.on !== "function") {
    throw new Error("Pi extension API missing on()");
  }

  const shouldReportFn = typeof deps.shouldReport === "function" ? deps.shouldReport : shouldReport;
  const buildPayloadFn = typeof deps.buildPayload === "function" ? deps.buildPayload : buildPayload;
  const postStateFn = typeof deps.postState === "function" ? deps.postState : () => false;
  const setIntervalFn = typeof deps.setInterval === "function" ? deps.setInterval : setInterval;
  const clearIntervalFn = typeof deps.clearInterval === "function" ? deps.clearInterval : clearInterval;
  const setTimeoutFn = typeof deps.setTimeout === "function" ? deps.setTimeout : setTimeout;
  const clearTimeoutFn = typeof deps.clearTimeout === "function" ? deps.clearTimeout : clearTimeout;
  const nowFn = typeof deps.now === "function" ? deps.now : Date.now;
  const httpRequestFn = deps.httpRequest || http.request;
  const heartbeatIntervalMs = Number.isFinite(deps.heartbeatIntervalMs)
    ? Math.max(1, Math.floor(deps.heartbeatIntervalMs))
    : HEARTBEAT_INTERVAL_MS;
  const pollIntervalMs = Number.isFinite(deps.pollIntervalMs)
    ? Math.max(1, Math.floor(deps.pollIntervalMs))
    : INBOX_POLL_INTERVAL_MS;
  const retryIntervalMs = Number.isFinite(deps.retryIntervalMs)
    ? Math.max(1, Math.floor(deps.retryIntervalMs))
    : INBOX_RETRY_INTERVAL_MS;
  const settleDeadlineMs = Number.isFinite(deps.settleDeadlineMs)
    ? Math.max(1, Math.floor(deps.settleDeadlineMs))
    : INBOX_SETTLE_DEADLINE_MS;

  const identity = deps.remoteIdentity !== undefined
    ? deps.remoteIdentity
    : (typeof deps.readRemoteIdentity === "function"
      ? deps.readRemoteIdentity()
      : serverConfig.readRemoteIdentity(deps));
  const isRemote = isUsableRemoteIdentity(identity);

  const capabilityToken = isRemote
    ? (isValidCapabilityToken(deps.capabilityToken) ? deps.capabilityToken : generateCapabilityToken())
    : null;

  const peerCapabilityToken = isValidCapabilityToken(deps.peerCapabilityToken)
    ? deps.peerCapabilityToken
    : generateCapabilityToken();

  const globalTarget = deps.globalObject || globalThis;
  try {
    globalTarget[PEER_CAPABILITY_SLOT_SYMBOL] = Object.freeze({
      version: 1,
      token: peerCapabilityToken,
    });
  } catch {
    // Shared slot write failure fails closed silently
  }

  const deliveryChains = new Map();
  let heartbeatTimer = null;
  let latestCtx = null;
  let lifecycleIdle = true;
  let activeConsumer = null;

  function send(state, event, nativeEvent, ctx, waitForDelivery = false, sendOptions = {}) {
    let report;
    try {
      report = shouldReportFn(ctx);
    } catch {
      report = false;
    }
    if (!report) return waitForDelivery ? Promise.resolve(false) : false;
    let payload;
    try {
      payload = buildPayloadFn({
        state,
        event,
        nativeEvent,
        ctx,
        ...sendOptions,
        ...(capabilityToken ? { capabilityToken } : {}),
        ...(peerCapabilityToken ? { peerCapabilityToken } : {}),
      });
    } catch {
      return waitForDelivery ? Promise.resolve(false) : false;
    }
    if (payload && typeof payload === "object") {
      if (isRemote && capabilityToken) {
        payload.pet_inbox_capability = {
          version: 1,
          receiveUserMessage: true,
          token: capabilityToken,
        };
      } else {
        delete payload.pet_inbox_capability;
      }
    }
    const sessionKey = payload && payload.session_id ? payload.session_id : "pi:default";
    const task = () => Promise.resolve(postStateFn(payload));
    if (waitForDelivery) return chainDelivery(deliveryChains, sessionKey, task);
    task().catch(() => {});
    return true;
  }

  function rememberContext(ctx) {
    if (ctx) latestCtx = ctx;
  }

  function contextIsIdle(ctx) {
    if (ctx && typeof ctx.isIdle === "function") {
      try { return ctx.isIdle() === true; } catch { return false; }
    }
    return lifecycleIdle;
  }

  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    clearIntervalFn(heartbeatTimer);
    heartbeatTimer = null;
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setIntervalFn(() => {
      const ctx = latestCtx;
      if (!ctx) return;
      // The heartbeat must also fire during active turns: a long-running tool
      // call produces no hook events for many minutes, and without a liveness
      // bump Clawd's stale sweep force-idles (then deletes) the session while
      // the agent is genuinely working. livenessOnly keeps this cheap on the
      // server (touchSessionActivity only bumps updatedAt) and the reported
      // state mirrors the real lifecycle so a rehydrated session is not
      // wrongly rewritten as idle mid-turn.
      send(
        contextIsIdle(ctx) ? "idle" : "working",
        "SessionHeartbeat",
        { type: "session_heartbeat" },
        ctx,
        false,
        { livenessOnly: true }
      );
    }, heartbeatIntervalMs);
    // A liveness timer must never keep a CLI process alive on its own.
    if (heartbeatTimer && typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  }

  function startInboxConsumer(ctx) {
    if (!isRemote) return;
    const rawSessionId = getCanonicalRawSessionId(ctx);
    if (!isStartableRawSessionId(rawSessionId)) return;

    if (activeConsumer) {
      activeConsumer.stop();
      activeConsumer = null;
    }

    activeConsumer = createRemoteInboxConsumer({
      pi,
      identity,
      rawSessionId,
      capabilityToken,
      httpRequest: httpRequestFn,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
      now: nowFn,
      pollIntervalMs,
      retryIntervalMs,
      settleDeadlineMs,
    });
  }

  function handleToolCall(nativeEvent, ctx) {
    try {
      rememberContext(ctx);
      lifecycleIdle = false;
      send("working", "PreToolUse", nativeEvent, ctx);
      return undefined;
    } catch {
      return undefined;
    }
  }

  for (const [nativeName, clawdEvent, state] of DEFAULT_EVENT_BINDINGS) {
    const wait = nativeName === "agent_end";
    pi.on(nativeName, (nativeEvent, ctx) => {
      rememberContext(ctx);
      if (nativeName === "session_start" || nativeName === "agent_end" || nativeName === "session_compact") {
        lifecycleIdle = true;
      } else if (nativeName === "before_agent_start" || nativeName === "session_before_compact") {
        lifecycleIdle = false;
      }
      if (nativeName === "session_start") {
        startHeartbeat();
        const sendResult = send(state, clawdEvent, nativeEvent, ctx, wait);
        if (sendResult !== false) startInboxConsumer(ctx);
        return sendResult;
      }
      return send(state, clawdEvent, nativeEvent, ctx, wait);
    });
  }

  pi.on("session_shutdown", (nativeEvent, ctx) => {
    rememberContext(ctx);
    stopHeartbeat();
    if (activeConsumer) {
      activeConsumer.stop();
      activeConsumer = null;
    }
    // Pi emits session_shutdown for an extension reload as well as for a real
    // logical session replacement/quit. Reload must not retire a live pet.
    if (nativeEvent && nativeEvent.reason === "reload") return false;
    return send("sleeping", "SessionEnd", nativeEvent, ctx, true);
  });

  pi.on("tool_call", handleToolCall);

  pi.on("tool_result", (nativeEvent, ctx) => {
    rememberContext(ctx);
    const isError = !!(nativeEvent && nativeEvent.isError);
    // Await failed tool delivery so a following lifecycle event cannot hide
    // the error state before Clawd receives it.
    return send(
      isError ? "error" : "working",
      isError ? "PostToolUseFailure" : "PostToolUse",
      nativeEvent,
      ctx,
      isError
    );
  });

  return {
    deliveryChains,
    send,
    startHeartbeat,
    stopHeartbeat,
    getInboxConsumer: () => activeConsumer,
  };
}

const api = {
  DEFAULT_EVENT_BINDINGS,
  PEER_CAPABILITY_SLOT_SYMBOL,
  PEER_CAPABILITY_SLOT: PEER_CAPABILITY_SLOT_SYMBOL,
  PI_AGENT_ID,
  PI_HOOK_SOURCE,
  attach,
  buildPayload,
  createRemoteInboxConsumer,
  getCanonicalRawSessionId,
  isInteractiveMode,
  isStartableRawSessionId,
  parseMode,
  postInboxJson,
  postStateToClawd,
  shouldReport,
};

module.exports = api;
module.exports.default = api;
