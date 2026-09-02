"use strict";

// This module deliberately delegates state delivery to the same transport used
// by every other Clawd hook. In particular, server-config detects a colocated
// clawd-remote.json and then pins the remote forward port, attaches the routing
// nonce, and fails closed rather than scanning local ports.
const serverConfig = require("./server-config");

const PI_AGENT_ID = "pi";
const PI_HOOK_SOURCE = "pi-extension";
const HEARTBEAT_INTERVAL_MS = 60_000;

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
    session_id: `${PI_AGENT_ID}:${readSessionId(ctx)}`,
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

function attach(pi, deps = {}) {
  if (!pi || typeof pi.on !== "function") {
    throw new Error("Pi extension API missing on()");
  }

  const shouldReportFn = typeof deps.shouldReport === "function" ? deps.shouldReport : shouldReport;
  const buildPayloadFn = typeof deps.buildPayload === "function" ? deps.buildPayload : buildPayload;
  const postStateFn = typeof deps.postState === "function" ? deps.postState : () => false;
  const setIntervalFn = typeof deps.setInterval === "function" ? deps.setInterval : setInterval;
  const clearIntervalFn = typeof deps.clearInterval === "function" ? deps.clearInterval : clearInterval;
  const heartbeatIntervalMs = Number.isFinite(deps.heartbeatIntervalMs)
    ? Math.max(1, Math.floor(deps.heartbeatIntervalMs))
    : HEARTBEAT_INTERVAL_MS;
  const deliveryChains = new Map();
  let heartbeatTimer = null;
  let latestCtx = null;
  let lifecycleIdle = true;

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
      payload = buildPayloadFn({ state, event, nativeEvent, ctx, ...sendOptions });
    } catch {
      return waitForDelivery ? Promise.resolve(false) : false;
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
      if (!ctx || !contextIsIdle(ctx)) return;
      send(
        "idle",
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
      if (nativeName === "session_start") startHeartbeat();
      return send(state, clawdEvent, nativeEvent, ctx, wait);
    });
  }

  pi.on("session_shutdown", (nativeEvent, ctx) => {
    rememberContext(ctx);
    stopHeartbeat();
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

  return { deliveryChains, send, startHeartbeat, stopHeartbeat };
}

const api = {
  DEFAULT_EVENT_BINDINGS,
  PI_AGENT_ID,
  PI_HOOK_SOURCE,
  attach,
  buildPayload,
  isInteractiveMode,
  parseMode,
  postStateToClawd,
  shouldReport,
};

module.exports = api;
module.exports.default = api;
