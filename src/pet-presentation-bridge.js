"use strict";

// Projects Clawd's authoritative per-session snapshots into claude-status-pet
// status files. It is intentionally an opt-in presentation consumer: agent
// connectors, Remote SSH, and Clawd's state machine remain the source of truth.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn: spawnChild } = require("node:child_process");

const DEFAULT_AGENT_IDS = ["pi"];
const STATUS_FILE_PREFIX = "status-";
const PET_ID_PREFIX = "pet_";
const PET_ID_HASH_LENGTH = 24;
const MAX_LABEL_LENGTH = 120;
const MAX_DETAIL_LENGTH = 180;

function isTruthyEnv(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isEnabledFromEnv(env = process.env) {
  return isTruthyEnv(env.CLAWD_PET_BRIDGE);
}

function shouldHideNativePetFromEnv(env = process.env) {
  return isEnabledFromEnv(env) && isTruthyEnv(env.CLAWD_PET_BRIDGE_HIDE_NATIVE_PET);
}

function defaultStatusDir(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, ".pi-pet", "status");
}

function normalizeText(value, maxLength = MAX_DETAIL_LENGTH) {
  if (typeof value !== "string") return "";
  return value.replace(/[\0\r\n]+/g, " ").trim().slice(0, maxLength);
}

function normalizeAgentIds(value) {
  if (!Array.isArray(value)) return new Set(DEFAULT_AGENT_IDS);
  const ids = value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return new Set(ids.length > 0 ? ids : DEFAULT_AGENT_IDS);
}

function stablePetSessionId(entry) {
  const profileId = normalizeText(entry && entry.profileId, 256) || "local";
  const agentId = normalizeText(entry && entry.agentId, 256) || "unknown";
  const rawSessionId = normalizeText(
    (entry && entry.rawSessionId) || (entry && entry.id),
    4096
  ) || "unknown";
  const digest = crypto
    .createHash("sha256")
    .update(`${profileId}\0${agentId}\0${rawSessionId}`, "utf8")
    .digest("hex")
    .slice(0, PET_ID_HASH_LENGTH);
  return `${PET_ID_PREFIX}${digest}`;
}

function statusForTool(toolName) {
  const tool = normalizeText(toolName, 120).toLowerCase();
  if (/(edit|write|replace|create|notebook)/.test(tool)) return "editing";
  if (/(read|view|fetch|list_dir|listdir)/.test(tool)) return "reading";
  if (/(grep|search|find|glob)/.test(tool)) return "searching";
  if (/(agent|skill|delegate|subagent|task)/.test(tool)) return "delegating";
  return "running";
}

function presentationState(entry) {
  const state = normalizeText(entry && entry.state, 80).toLowerCase();
  const rawEvent = normalizeText(entry && entry.lastEvent && entry.lastEvent.rawEvent, 120);

  if (rawEvent === "SessionEnd") return "closed";
  if (state === "error") return "error";
  if (state === "notification") return "waiting";
  if (state === "attention") return "idle";
  if (["sleeping", "dozing", "yawning", "collapsing"].includes(state)) return "offline";
  if (["thinking", "sweeping"].includes(state)) return "thinking";
  if (["carrying", "juggling"].includes(state)) return "delegating";
  if (state === "working") return statusForTool(entry && entry.toolName);
  return "idle";
}

function sessionName(entry) {
  const parts = [
    normalizeText(entry && entry.sourceDisplayLabel, 60),
    normalizeText(entry && entry.agentName, 60) || normalizeText(entry && entry.agentId, 60),
    normalizeText(entry && entry.displayFolder, 60),
  ].filter(Boolean);
  return (parts.join(" / ") || "Agent session").slice(0, MAX_LABEL_LENGTH);
}

function activityDetail(entry, state) {
  const project = normalizeText(entry && entry.displayFolder, 90) || "project";
  const tool = normalizeText(entry && entry.toolName, 80);
  switch (state) {
    case "editing": return `Editing ${project}`;
    case "reading": return `Reading ${project}`;
    case "searching": return "Searching…";
    case "delegating": return "Delegating…";
    case "running": return tool ? `Running ${tool}` : "Running tool…";
    case "thinking": return "Thinking…";
    case "waiting": return "Waiting for approval…";
    case "error": return "Something went wrong";
    case "closed": return "Session ended";
    case "offline": return "Sleeping";
    default: return "Waiting for input";
  }
}

function toStatusPayload(entry, now = new Date()) {
  const state = presentationState(entry);
  const updatedAt = Number(entry && entry.updatedAt);
  const timestamp = Number.isFinite(updatedAt) && updatedAt > 0
    ? new Date(updatedAt).toISOString()
    : now.toISOString();
  return {
    state,
    detail: activityDetail(entry, state),
    tool: normalizeText(entry && entry.toolName, 120),
    event: normalizeText(entry && entry.lastEvent && entry.lastEvent.rawEvent, 120),
    session_id: stablePetSessionId(entry),
    session_name: sessionName(entry),
    timestamp,
  };
}

// Presentation fields that justify a status-file rewrite. Broadcasts also fire
// for non-presentation reasons (quota freshness ticks, liveness ripples), and
// every rewrite trips the pet's file watcher, which downstream consumers (e.g.
// the pet's idle watchdog) read as session activity. `event` must stay in the
// list: alternating PreToolUse/PostToolUse with identical state/tool is real
// work and must keep refreshing the file.
const PRESENTATION_COMPARE_KEYS = ["state", "detail", "tool", "event", "session_id", "session_name"];

function presentationChanged(previous, next) {
  if (!previous) return true;
  for (const key of PRESENTATION_COMPARE_KEYS) {
    if (previous[key] !== next[key]) return true;
  }
  return false;
}

function writeStatusFile(statusPath, payload, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(statusPath), { recursive: true });
  const content = `${JSON.stringify(payload)}\n`;
  const temporaryPath = `${statusPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fsApi.writeFileSync(temporaryPath, content, "utf8");
  try {
    fsApi.renameSync(temporaryPath, statusPath);
  } catch {
    // A few Windows/filesystem combinations reject replacing an existing file
    // through rename. status-pet tolerates an in-place write after a brief
    // watcher retry, so retain a reliable fallback rather than dropping state.
    fsApi.writeFileSync(statusPath, content, "utf8");
    try { fsApi.unlinkSync(temporaryPath); } catch {}
  }
}

function createPetPresentationBridge(options = {}) {
  const enabled = options.enabled === true;
  const agentIds = normalizeAgentIds(options.agentIds);
  const statusDir = options.statusDir || defaultStatusDir(options.env);
  const rendererBinary = typeof options.rendererBinary === "string" && options.rendererBinary.trim()
    ? options.rendererBinary.trim()
    : null;
  const assetsDir = typeof options.assetsDir === "string" && options.assetsDir.trim()
    ? options.assetsDir.trim()
    : null;
  const fsApi = options.fsApi || fs;
  const spawn = options.spawn || spawnChild;
  const log = typeof options.log === "function" ? options.log : () => {};
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const launchedIds = new Set();
  const launchedProcesses = new Map();
  const known = new Map();

  function statusPathFor(petId) {
    return path.join(statusDir, `${STATUS_FILE_PREFIX}${petId}.json`);
  }

  function launchRenderer(payload, statusPath) {
    if (!rendererBinary || launchedIds.has(payload.session_id) || payload.state === "closed" || payload.state === "offline") return;
    launchedIds.add(payload.session_id);
    const args = ["run", "--status-file", statusPath, "--session-id", payload.session_id];
    if (assetsDir) args.push("--assets-dir", assetsDir);
    try {
      const child = spawn(rendererBinary, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      if (child) launchedProcesses.set(payload.session_id, child);
      const releaseLaunch = () => {
        if (launchedProcesses.get(payload.session_id) !== child) return;
        launchedProcesses.delete(payload.session_id);
        launchedIds.delete(payload.session_id);
      };
      if (child && typeof child.unref === "function") child.unref();
      if (child && typeof child.once === "function") {
        child.once("error", (error) => {
          releaseLaunch();
          log(`renderer launch failed for ${payload.session_id}: ${error.message}`);
        });
        // A clean exit (code 0, e.g. the pet's own idle watchdog or the user
        // closing the window) means "leave it dead": onSnapshot only relaunches
        // on a genuine presentation change. An abnormal exit is logged so crash
        // loops are diagnosable; relaunch still waits for the next real event.
        child.once("exit", (code, signal) => {
          releaseLaunch();
          if (code !== 0 || signal) {
            log(`renderer for ${payload.session_id} exited abnormally: code=${code} signal=${signal || "none"}`);
          }
        });
      }
    } catch (error) {
      log(`renderer launch threw for ${payload.session_id}: ${error.message}`);
    }
  }

  function markMissingSessionsOffline(seenIds) {
    for (const [petId, prior] of known) {
      if (seenIds.has(petId) || prior.state === "offline") continue;
      // A snapshot omission can mean stale cleanup, Remote SSH disconnect, or
      // a transient Clawd restart. It is not proof that the agent ended.
      const offline = {
        ...prior,
        state: "offline",
        detail: "Connection lost",
        event: "SessionMissing",
        timestamp: now().toISOString(),
      };
      writeStatusFile(statusPathFor(petId), offline, fsApi);
      known.set(petId, offline);
    }
  }

  function onSessionEnd(entry) {
    if (!enabled || !entry || entry.headless === true || !agentIds.has(entry.agentId)) return false;
    const petId = stablePetSessionId(entry);
    const prior = known.get(petId) || toStatusPayload(entry, now());
    const closed = {
      ...prior,
      state: "closed",
      detail: "Session ended",
      event: "SessionEnd",
      timestamp: now().toISOString(),
    };
    writeStatusFile(statusPathFor(petId), closed, fsApi);
    known.delete(petId);
    launchedIds.delete(petId);
    launchedProcesses.delete(petId);
    return true;
  }

  function onSnapshot(snapshot) {
    if (!enabled || !snapshot || !Array.isArray(snapshot.sessions)) return { written: 0, launched: 0 };
    const seenIds = new Set();
    let written = 0;
    let launched = 0;
    for (const entry of snapshot.sessions) {
      if (!entry || entry.headless === true || !agentIds.has(entry.agentId)) continue;
      const payload = toStatusPayload(entry, now());
      const statusPath = statusPathFor(payload.session_id);
      const prior = known.get(payload.session_id);
      const changed = presentationChanged(prior, payload);
      if (changed) {
        writeStatusFile(statusPath, payload, fsApi);
        written += 1;
      }
      if (payload.state === "closed") launchedIds.delete(payload.session_id);
      seenIds.add(payload.session_id);
      known.set(payload.session_id, payload);
      // Launch (or relaunch) only on genuine presentation activity. A renderer
      // that exited on its own — the pet's idle watchdog closing the window, or
      // the user dismissing it — must stay dead through heartbeat/quota-driven
      // rebroadcasts; the next real event brings it back.
      const isRunning = launchedProcesses.has(payload.session_id);
      if (changed && !isRunning && payload.state !== "closed" && payload.state !== "offline") {
        const wasLaunched = launchedIds.has(payload.session_id);
        launchRenderer(payload, statusPath);
        if (!wasLaunched && launchedIds.has(payload.session_id)) launched += 1;
      }
    }
    markMissingSessionsOffline(seenIds);
    return { written, launched };
  }

  return {
    onSessionEnd,
    onSnapshot,
    statusPathFor,
    get enabled() { return enabled; },
  };
}

module.exports = createPetPresentationBridge;
module.exports.activityDetail = activityDetail;
module.exports.defaultStatusDir = defaultStatusDir;
module.exports.isEnabledFromEnv = isEnabledFromEnv;
module.exports.shouldHideNativePetFromEnv = shouldHideNativePetFromEnv;
module.exports.presentationState = presentationState;
module.exports.stablePetSessionId = stablePetSessionId;
module.exports.statusForTool = statusForTool;
module.exports.toStatusPayload = toStatusPayload;
module.exports.writeStatusFile = writeStatusFile;
