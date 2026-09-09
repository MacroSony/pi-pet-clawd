"use strict";

// Trusted-operator shim only. The implementation lives in the explicitly
// configured absolute module supplied by the pi-pet launcher. In particular,
// do not add a ../ parent-repository fallback here: when disabled this file
// must be safe to load from a normal Clawd installation.

const os = require("node:os");
const path = require("node:path");

const API_CONTRACT_VERSION = "1";
const DEFAULT_AGENT_IDS = ["pi"];

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

function agentIdsFromEnv(env = process.env) {
  const raw = env.CLAWD_PET_BRIDGE_AGENT_IDS;
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_AGENT_IDS.slice();
  const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
  return ids.length > 0 ? ids : DEFAULT_AGENT_IDS.slice();
}

function disabledBridge(options = {}) {
  const env = options.env || process.env;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const statusDir = options.statusDir || path.join(home, ".pi-pet", "status");
  return {
    onSnapshot() { return { written: 0, launched: 0 }; },
    onSessionEnd() { return false; },
    statusPathFor(sessionId) { return path.join(statusDir, `status-${sessionId}.json`); },
    get enabled() { return false; },
  };
}

function loadRuntime(env = process.env) {
  const modulePath = env.CLAWD_PET_RUNTIME_MODULE;
  if (typeof modulePath !== "string" || modulePath.trim() === "") {
    throw new Error(
      "Pi Pet bridge is enabled, but CLAWD_PET_RUNTIME_MODULE is not set. "
      + "Run the pi-pet root launcher or set it to the absolute packages/runtime path."
    );
  }
  if (!path.isAbsolute(modulePath)) {
    throw new Error(
      `Pi Pet bridge is enabled, but CLAWD_PET_RUNTIME_MODULE must be absolute (got: ${modulePath}). `
      + "Run scripts/run-with-bridge.bat from the pi-pet root."
    );
  }

  let loaded;
  try {
    loaded = require(modulePath);
  } catch (error) {
    throw new Error(
      `Pi Pet bridge runtime could not be loaded from ${modulePath}: ${error.message}`,
      { cause: error }
    );
  }
  if (!loaded || loaded.API_CONTRACT_VERSION !== API_CONTRACT_VERSION) {
    const found = loaded && loaded.API_CONTRACT_VERSION
      ? loaded.API_CONTRACT_VERSION
      : "missing";
    throw new Error(
      `Pi Pet bridge runtime at ${modulePath} has incompatible API contract ${found}; `
      + `expected ${API_CONTRACT_VERSION}. Install/use the matching pi-pet packages/runtime.`
    );
  }
  if (typeof loaded.createClawdPresentationBridge !== "function") {
    throw new Error(
      `Pi Pet bridge runtime at ${modulePath} is incompatible: `
      + "createClawdPresentationBridge(options) is missing."
    );
  }
  return loaded;
}

function createPetPresentationBridge(options = {}) {
  if (options.enabled !== true) return disabledBridge(options);
  const env = options.env || process.env;
  const runtime = loadRuntime(env);
  return runtime.createClawdPresentationBridge(options);
}

module.exports = createPetPresentationBridge;
module.exports.API_CONTRACT_VERSION = API_CONTRACT_VERSION;
module.exports.DEFAULT_AGENT_IDS = DEFAULT_AGENT_IDS;
module.exports.agentIdsFromEnv = agentIdsFromEnv;
module.exports.isEnabledFromEnv = isEnabledFromEnv;
module.exports.shouldHideNativePetFromEnv = shouldHideNativePetFromEnv;
module.exports.loadRuntime = loadRuntime;
