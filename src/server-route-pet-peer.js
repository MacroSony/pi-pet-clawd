"use strict";

const crypto = require("node:crypto");
const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");
const { isValidSessionProfileId } = require("./session-key");
const {
  isValidRawSessionId,
  timingSafeTokenMatch,
} = require("./server-route-pet-inbox");
const { loadRuntime } = require("./pet-presentation-bridge");

const MAX_PET_PEER_BODY_BYTES = 16 * 1024; // 16 KiB
const MAX_RESPONSE_BYTES = 64 * 1024; // 64 KiB
const PEER_HANDLE_TTL_MS = 5 * 60 * 1000; // 5 minutes (300,000 ms)
const PEER_SEND_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 60 seconds
const PEER_SEND_RATE_LIMIT_MAX = 10; // 10 accepted sends per rolling 60s
const MAX_UNICODE_CODE_POINTS = 2000;
const MAX_SETTLE_REASON_CODE_POINTS = 1024;
const PEER_MESSAGE_TTL_MS = 60000; // 60s

const ALLOWED_CATALOG_KEYS = Object.freeze(new Set([
  "schemaVersion",
  "kind",
  "rawSessionId",
  "capabilityToken",
  "state",
  "host",
]));

const ALLOWED_SEND_KEYS = Object.freeze(new Set([
  "schemaVersion",
  "kind",
  "rawSessionId",
  "capabilityToken",
  "target",
  "text",
]));

const ALLOWED_CLAIM_KEYS = Object.freeze(new Set([
  "schemaVersion",
  "kind",
  "rawSessionId",
  "capabilityToken",
]));

const ALLOWED_SETTLE_KEYS = Object.freeze(new Set([
  "schemaVersion",
  "kind",
  "rawSessionId",
  "capabilityToken",
  "messageId",
  "claimToken",
  "status",
  "reason",
]));

const ALLOWED_RECEIPT_QUERY_KEYS = Object.freeze(new Set([
  "schemaVersion",
  "kind",
  "rawSessionId",
  "capabilityToken",
  "messageId",
]));

const VALID_SETTLE_STATUS_VALUES = Object.freeze(new Set(["dispatched", "failed", "expired"]));

const INACTIVE_STATES = Object.freeze(new Set([
  "closed",
  "offline",
  "sleeping",
  "dozing",
  "yawning",
  "collapsing",
]));

function isValidPeerRawSessionId(value) {
  if (!isValidRawSessionId(value)) {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed === "default" || trimmed === "pi:" || trimmed === "pi:default") {
    return false;
  }
  return true;
}

function countUnicodeCodePoints(value) {
  if (typeof value !== "string") return 0;
  return Array.from(value).length;
}

function sanitizeText(value, maxLength = 120) {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > maxLength ? chars.slice(0, maxLength).join("") : cleaned;
}

function sanitizeDisplayName(value, fallback = "Pi") {
  const cleaned = sanitizeText(value, 120);
  const candidate = cleaned || sanitizeText(fallback, 120) || "Pi";

  // Strip trailing " · Pi" / "· Pi" / "• Pi" to avoid double suffix
  let base = candidate.replace(/(\s*[\u00b7\u2022\u2219]\s*Pi)+$/i, "").trim();
  if (!base || base.toLowerCase() === "pi") {
    return "Pi";
  }

  const suffix = " · Pi";
  const suffixLen = Array.from(suffix).length; // 5
  const maxBaseLength = 120 - suffixLen; // 115
  const baseChars = Array.from(base);
  const boundedBase = baseChars.length > maxBaseLength ? baseChars.slice(0, maxBaseLength).join("").trim() : base;
  return `${boundedBase}${suffix}`;
}

function sanitizeHost(value, fallback = "local") {
  const sanitized = sanitizeText(value, 120);
  return sanitized || fallback;
}

function sanitizeState(value, fallback = "idle") {
  if (typeof value !== "string") return fallback;
  const sanitized = value
    .toLowerCase()
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, "")
    .trim()
    .slice(0, 64);
  return sanitized || fallback;
}

function isInactiveState(state) {
  const normalized = sanitizeState(state);
  return INACTIVE_STATES.has(normalized);
}

function projectSendReceipt(receipt, fallbackMeta = {}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return {
      schemaVersion: "1",
      kind: "peer_message",
      status: "failed",
      reason: "invalid receipt",
    };
  }

  const out = {
    schemaVersion: typeof receipt.schemaVersion === "string" ? receipt.schemaVersion : "1",
    kind: typeof receipt.kind === "string" ? receipt.kind : "peer_message",
    messageId: typeof receipt.messageId === "string" ? receipt.messageId : (fallbackMeta.messageId || ""),
    status: typeof receipt.status === "string" ? receipt.status : "failed",
  };

  if (receipt.reason !== undefined && receipt.reason !== null) {
    out.reason = typeof receipt.reason === "string" ? receipt.reason : String(receipt.reason);
  }

  const threadId = typeof receipt.threadId === "string" ? receipt.threadId : fallbackMeta.threadId;
  if (typeof threadId === "string") {
    out.threadId = threadId;
  }

  const hopCount = typeof receipt.hopCount === "number" ? receipt.hopCount : fallbackMeta.hopCount;
  if (typeof hopCount === "number") {
    out.hopCount = hopCount;
  }

  const maxHops = typeof receipt.maxHops === "number" ? receipt.maxHops : fallbackMeta.maxHops;
  if (typeof maxHops === "number") {
    out.maxHops = maxHops;
  }

  const createdAtMs = typeof receipt.createdAtMs === "number" ? receipt.createdAtMs : fallbackMeta.createdAtMs;
  if (typeof createdAtMs === "number") {
    out.createdAtMs = createdAtMs;
  }

  if (typeof receipt.updatedAtMs === "number") {
    out.updatedAtMs = receipt.updatedAtMs;
  }

  const expiresAtMs = typeof receipt.expiresAtMs === "number" ? receipt.expiresAtMs : fallbackMeta.expiresAtMs;
  if (typeof expiresAtMs === "number") {
    out.expiresAtMs = expiresAtMs;
  }

  return out;
}

function sendJsonResponse(res, statusCode, payload) {
  if (!res || res.headersSent || res.writableEnded) {
    return;
  }

  let body;
  try {
    body = JSON.stringify(payload);
  } catch {
    body = JSON.stringify({ status: "failed", reason: "json serialization error" });
    statusCode = 500;
  }

  let bodyBuffer = Buffer.from(body, "utf8");
  if (bodyBuffer.length > MAX_RESPONSE_BYTES) {
    statusCode = 500;
    bodyBuffer = Buffer.from(
      JSON.stringify({ status: "failed", reason: "response payload too large" }),
      "utf8"
    );
  }

  try {
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
    });
    res.end(bodyBuffer);
  } catch {}
}

function createPetPeerCapabilityRegistry() {
  const entries = new Map();
  let nextGeneration = 1;

  function makeKey(profileId, agentId, rawSessionId) {
    const prof = typeof profileId === "string" ? profileId : "local";
    return `${prof}\0${agentId}\0${rawSessionId}`;
  }

  function registerCapability({ profileId = "local", agentId, rawSessionId, token } = {}) {
    if (!isValidSessionProfileId(profileId)) return false;
    if (agentId !== "pi") return false;
    if (!isValidPeerRawSessionId(rawSessionId)) return false;
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return false;

    const key = makeKey(profileId, "pi", rawSessionId);
    const entry = entries.get(key);

    if (!entry) {
      entries.set(key, {
        activeToken: token,
        generation: nextGeneration++,
        retiredTokens: new Set(),
      });
      return true;
    }

    if (entry.retiredTokens.has(token)) {
      return false;
    }

    if (entry.activeToken !== null) {
      if (timingSafeTokenMatch(token, entry.activeToken)) {
        // Repeated registration of the SAME token must NOT rotate generation
        return true;
      }
      // Token changed: retire active token and assign fresh generation
      entry.retiredTokens.add(entry.activeToken);
      entry.activeToken = token;
      entry.generation = nextGeneration++;
      return true;
    }

    entry.activeToken = token;
    entry.generation = nextGeneration++;
    return true;
  }

  function revokeCapability({ profileId = "local", agentId, rawSessionId, token } = {}) {
    if (!isValidSessionProfileId(profileId)) return false;
    if (agentId !== "pi") return false;
    if (!isValidPeerRawSessionId(rawSessionId)) return false;
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return false;

    const key = makeKey(profileId, "pi", rawSessionId);
    const entry = entries.get(key);
    if (!entry || entry.activeToken === null) {
      return false;
    }

    if (!timingSafeTokenMatch(token, entry.activeToken)) {
      return false;
    }

    entry.retiredTokens.add(entry.activeToken);
    entry.activeToken = null;
    entry.generation = null;
    return true;
  }

  function verifyCapability({ profileId = "local", agentId, rawSessionId, token } = {}) {
    if (!isValidSessionProfileId(profileId)) return false;
    if (agentId !== "pi") return false;
    if (!isValidPeerRawSessionId(rawSessionId)) return false;
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return false;

    const key = makeKey(profileId, "pi", rawSessionId);
    const entry = entries.get(key);
    if (!entry || entry.activeToken === null) return false;

    return timingSafeTokenMatch(token, entry.activeToken);
  }

  function getGeneration({ profileId = "local", agentId = "pi", rawSessionId } = {}) {
    if (!isValidSessionProfileId(profileId)) return null;
    if (agentId !== "pi") return null;
    if (!isValidPeerRawSessionId(rawSessionId)) return null;

    const key = makeKey(profileId, "pi", rawSessionId);
    const entry = entries.get(key);
    return (entry && entry.activeToken !== null) ? entry.generation : null;
  }

  function hasCapability({ profileId = "local", agentId = "pi", rawSessionId } = {}) {
    if (!isValidSessionProfileId(profileId)) return false;
    if (agentId !== "pi") return false;
    if (!isValidPeerRawSessionId(rawSessionId)) return false;

    const key = makeKey(profileId, "pi", rawSessionId);
    const entry = entries.get(key);
    return Boolean(entry && entry.activeToken !== null);
  }

  function clear() {
    entries.clear();
  }

  return {
    registerCapability,
    revokeCapability,
    verifyCapability,
    getGeneration,
    hasCapability,
    clear,
    get size() {
      let count = 0;
      for (const entry of entries.values()) {
        if (entry.activeToken !== null) {
          count++;
        }
      }
      return count;
    },
  };
}

function createPetPeerHandleStore(options = {}) {
  const handles = new Map();
  const ttlMs = options.ttlMs || PEER_HANDLE_TTL_MS;
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();

  function generateHandleId() {
    return `psh_${crypto.randomBytes(24).toString("base64url")}`;
  }

  function createCatalogHandle({ caller, callerGeneration, target, targetGeneration, nowMs }) {
    const currentNow = nowMs !== undefined ? nowMs : nowFn();
    const handle = generateHandleId();
    const expiresAtMs = currentNow + ttlMs;

    const entry = Object.freeze({
      handle,
      type: "catalog",
      caller: Object.freeze({
        profileId: caller.profileId || "local",
        agentId: "pi",
        rawSessionId: caller.rawSessionId,
      }),
      callerGeneration,
      target: Object.freeze({
        profileId: target.profileId || "local",
        agentId: "pi",
        rawSessionId: target.rawSessionId,
        displayName: sanitizeDisplayName(target.displayName),
        host: sanitizeHost(target.host),
      }),
      targetGeneration,
      threadId: null,
      hopCount: 0,
      maxHops: 1,
      createdAtMs: currentNow,
      expiresAtMs,
    });

    handles.set(handle, entry);
    return { handle, expiresAtMs };
  }

  function createReplyHandle({ caller, callerGeneration, target, targetGeneration, threadId, nowMs }) {
    const currentNow = nowMs !== undefined ? nowMs : nowFn();
    const handle = generateHandleId();
    const expiresAtMs = currentNow + ttlMs;

    const entry = Object.freeze({
      handle,
      type: "reply",
      caller: Object.freeze({
        profileId: caller.profileId || "local",
        agentId: "pi",
        rawSessionId: caller.rawSessionId,
      }),
      callerGeneration,
      target: Object.freeze({
        profileId: target.profileId || "local",
        agentId: "pi",
        rawSessionId: target.rawSessionId,
        displayName: sanitizeDisplayName(target.displayName),
        host: sanitizeHost(target.host),
      }),
      targetGeneration,
      threadId,
      hopCount: 1,
      maxHops: 1,
      createdAtMs: currentNow,
      expiresAtMs,
    });

    handles.set(handle, entry);
    return { handle, expiresAtMs };
  }

  function resolveAndConsumeHandle(handleId, { caller, registry, nowMs } = {}) {
    if (typeof handleId !== "string" || !/^psh_[A-Za-z0-9_-]{1,124}$/.test(handleId)) {
      return { ok: false, reason: "invalid_handle" };
    }

    const currentNow = nowMs !== undefined ? nowMs : nowFn();
    const entry = handles.get(handleId);

    if (!entry) {
      return { ok: false, reason: "not_found" };
    }

    // Check expiry (expiresAtMs <= now: currentNow >= entry.expiresAtMs)
    if (currentNow >= entry.expiresAtMs) {
      handles.delete(handleId);
      return { ok: false, reason: "expired" };
    }

    // Check caller match (exact profileId, agentId='pi', rawSessionId)
    const callerProf = (caller && caller.profileId) || "local";
    const callerRaw = caller && caller.rawSessionId;
    if (
      entry.caller.profileId !== callerProf
      || entry.caller.agentId !== "pi"
      || entry.caller.rawSessionId !== callerRaw
    ) {
      return { ok: false, reason: "caller_mismatch" };
    }

    // Check capability generations if registry is provided
    if (registry) {
      const currentCallerGen = registry.getGeneration(entry.caller);
      if (currentCallerGen === null || currentCallerGen !== entry.callerGeneration) {
        handles.delete(handleId);
        return { ok: false, reason: "capability_rotated" };
      }

      const currentTargetGen = registry.getGeneration(entry.target);
      if (currentTargetGen === null || currentTargetGen !== entry.targetGeneration) {
        handles.delete(handleId);
        return { ok: false, reason: "target_capability_rotated" };
      }

      if (!registry.hasCapability(entry.target)) {
        handles.delete(handleId);
        return { ok: false, reason: "target_inactive" };
      }
    }

    // Concurrency-safe atomic take: single use
    handles.delete(handleId);
    return { ok: true, entry };
  }

  function pruneExpired(nowMs) {
    const currentNow = nowMs !== undefined ? nowMs : nowFn();
    for (const [id, entry] of handles) {
      if (currentNow >= entry.expiresAtMs) {
        handles.delete(id);
      }
    }
  }

  function clear() {
    handles.clear();
  }

  return {
    createCatalogHandle,
    createReplyHandle,
    resolveAndConsumeHandle,
    pruneExpired,
    clear,
    get size() {
      return handles.size;
    },
  };
}

function createPeerSendRateLimiter(options = {}) {
  const windowMs = options.windowMs || PEER_SEND_RATE_LIMIT_WINDOW_MS;
  const maxSends = options.maxSends || PEER_SEND_RATE_LIMIT_MAX;
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();
  const records = new Map();

  function makeKey(source) {
    const profileId = (source && source.profileId) || "local";
    const agentId = (source && source.agentId) || "pi";
    const rawSessionId = (source && source.rawSessionId) || "";
    return `${profileId}\0${agentId}\0${rawSessionId}`;
  }

  function check(source, nowMs) {
    const currentNow = nowMs !== undefined ? nowMs : nowFn();
    const key = makeKey(source);
    const timestamps = records.get(key);
    if (!timestamps || timestamps.length === 0) {
      return { allowed: true, count: 0, remaining: maxSends };
    }

    // Filter to active rolling window
    const cutoff = currentNow - windowMs;
    const active = timestamps.filter((t) => t > cutoff);
    records.set(key, active);

    if (active.length >= maxSends) {
      const oldestInWindow = active[0];
      const resetMs = (oldestInWindow + windowMs) - currentNow;
      return {
        allowed: false,
        count: active.length,
        remaining: 0,
        resetMs: Math.max(0, resetMs),
      };
    }

    return {
      allowed: true,
      count: active.length,
      remaining: maxSends - active.length,
    };
  }

  function record(source, nowMs) {
    const currentNow = nowMs !== undefined ? nowMs : nowFn();
    const key = makeKey(source);
    const timestamps = records.get(key) || [];
    const cutoff = currentNow - windowMs;
    const active = timestamps.filter((t) => t > cutoff);
    active.push(currentNow);
    records.set(key, active);
  }

  function clear() {
    records.clear();
  }

  return {
    check,
    record,
    clear,
  };
}

function validatePetPeerCatalogPayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "Payload must be an object" };
  }

  for (const key of Object.keys(data)) {
    if (!ALLOWED_CATALOG_KEYS.has(key)) {
      return { ok: false, reason: `Unknown property: "${key}"` };
    }
  }

  if (data.schemaVersion !== "1") {
    return { ok: false, reason: "schemaVersion must be '1'" };
  }

  if (data.kind !== "peer_catalog_query") {
    return { ok: false, reason: "kind must be 'peer_catalog_query'" };
  }

  if (!isValidPeerRawSessionId(data.rawSessionId)) {
    return { ok: false, reason: "rawSessionId must be a non-empty string up to 4096 characters without null, newline, or carriage return characters" };
  }

  if (
    typeof data.capabilityToken !== "string"
    || !/^[0-9a-f]{64}$/.test(data.capabilityToken)
  ) {
    return { ok: false, reason: "capabilityToken must be a 64-character lowercase hex string" };
  }

  if (data.state !== undefined) {
    if (typeof data.state !== "string" || data.state.length < 1 || data.state.length > 64) {
      return { ok: false, reason: "state filter must be a non-empty string up to 64 characters" };
    }
  }

  if (data.host !== undefined) {
    if (typeof data.host !== "string" || data.host.length < 1 || data.host.length > 128) {
      return { ok: false, reason: "host filter must be a non-empty string up to 128 characters" };
    }
  }

  return { ok: true };
}

function validatePetPeerSendPayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "Payload must be an object" };
  }

  for (const key of Object.keys(data)) {
    if (!ALLOWED_SEND_KEYS.has(key)) {
      return { ok: false, reason: `Unknown property: "${key}"` };
    }
  }

  if (data.schemaVersion !== "1") {
    return { ok: false, reason: "schemaVersion must be '1'" };
  }

  if (data.kind !== "peer_send") {
    return { ok: false, reason: "kind must be 'peer_send'" };
  }

  if (!isValidPeerRawSessionId(data.rawSessionId)) {
    return { ok: false, reason: "rawSessionId must be a non-empty string up to 4096 characters without null, newline, or carriage return characters" };
  }

  if (
    typeof data.capabilityToken !== "string"
    || !/^[0-9a-f]{64}$/.test(data.capabilityToken)
  ) {
    return { ok: false, reason: "capabilityToken must be a 64-character lowercase hex string" };
  }

  if (
    typeof data.target !== "string"
    || !/^psh_[A-Za-z0-9_-]{1,124}$/.test(data.target)
  ) {
    return { ok: false, reason: "target must be a valid psh_ handle" };
  }

  if (typeof data.text !== "string") {
    return { ok: false, reason: "text must be a string" };
  }

  const codePointCount = countUnicodeCodePoints(data.text);
  if (codePointCount < 1 || codePointCount > MAX_UNICODE_CODE_POINTS) {
    return { ok: false, reason: `text length must be between 1 and ${MAX_UNICODE_CODE_POINTS} Unicode characters` };
  }

  return { ok: true };
}

function validatePetPeerClaimPayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "Payload must be an object" };
  }

  for (const key of Object.keys(data)) {
    if (!ALLOWED_CLAIM_KEYS.has(key)) {
      return { ok: false, reason: `Unknown property: "${key}"` };
    }
  }

  if (data.schemaVersion !== "1") {
    return { ok: false, reason: "schemaVersion must be '1'" };
  }

  if (data.kind !== "peer_message_claim") {
    return { ok: false, reason: "kind must be 'peer_message_claim'" };
  }

  if (!isValidPeerRawSessionId(data.rawSessionId)) {
    return { ok: false, reason: "rawSessionId must be a non-empty string up to 4096 characters without null, newline, or carriage return characters" };
  }

  if (
    typeof data.capabilityToken !== "string"
    || !/^[0-9a-f]{64}$/.test(data.capabilityToken)
  ) {
    return { ok: false, reason: "capabilityToken must be a 64-character lowercase hex string" };
  }

  return { ok: true };
}

function validatePetPeerSettlePayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "Payload must be an object" };
  }

  for (const key of Object.keys(data)) {
    if (!ALLOWED_SETTLE_KEYS.has(key)) {
      return { ok: false, reason: `Unknown property: "${key}"` };
    }
  }

  if (data.schemaVersion !== "1") {
    return { ok: false, reason: "schemaVersion must be '1'" };
  }

  if (data.kind !== "peer_message_settle") {
    return { ok: false, reason: "kind must be 'peer_message_settle'" };
  }

  if (!isValidPeerRawSessionId(data.rawSessionId)) {
    return { ok: false, reason: "rawSessionId must be a non-empty string up to 4096 characters without null, newline, or carriage return characters" };
  }

  if (
    typeof data.capabilityToken !== "string"
    || !/^[0-9a-f]{64}$/.test(data.capabilityToken)
  ) {
    return { ok: false, reason: "capabilityToken must be a 64-character lowercase hex string" };
  }

  if (
    typeof data.messageId !== "string"
    || data.messageId.length < 1
    || data.messageId.length > 64
    || !/^[A-Za-z0-9_-]{1,64}$/.test(data.messageId)
  ) {
    return { ok: false, reason: "messageId must be a valid identifier between 1 and 64 characters" };
  }

  if (
    typeof data.claimToken !== "string"
    || data.claimToken.length < 1
    || data.claimToken.length > 128
  ) {
    return { ok: false, reason: "claimToken must be a non-empty string up to 128 characters" };
  }

  if (
    typeof data.status !== "string"
    || !VALID_SETTLE_STATUS_VALUES.has(data.status)
  ) {
    return { ok: false, reason: "status must be one of: dispatched, failed, expired" };
  }

  if (data.reason !== undefined && data.reason !== null) {
    if (typeof data.reason !== "string") {
      return { ok: false, reason: "reason must be a string or null if provided" };
    }
    const reasonCodePoints = countUnicodeCodePoints(data.reason);
    if (reasonCodePoints > MAX_SETTLE_REASON_CODE_POINTS) {
      return { ok: false, reason: `reason length must not exceed ${MAX_SETTLE_REASON_CODE_POINTS} Unicode characters` };
    }
  }

  return { ok: true };
}

function validatePetPeerReceiptQueryPayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "Payload must be an object" };
  }

  for (const key of Object.keys(data)) {
    if (!ALLOWED_RECEIPT_QUERY_KEYS.has(key)) {
      return { ok: false, reason: `Unknown property: "${key}"` };
    }
  }

  if (data.schemaVersion !== "1") {
    return { ok: false, reason: "schemaVersion must be '1'" };
  }

  if (data.kind !== "peer_message_receipt_query") {
    return { ok: false, reason: "kind must be 'peer_message_receipt_query'" };
  }

  if (!isValidPeerRawSessionId(data.rawSessionId)) {
    return { ok: false, reason: "rawSessionId must be a non-empty string up to 4096 characters without null, newline, or carriage return characters" };
  }

  if (
    typeof data.capabilityToken !== "string"
    || !/^[0-9a-f]{64}$/.test(data.capabilityToken)
  ) {
    return { ok: false, reason: "capabilityToken must be a 64-character lowercase hex string" };
  }

  if (
    typeof data.messageId !== "string"
    || data.messageId.length < 1
    || data.messageId.length > 64
    || !/^[A-Za-z0-9_-]{1,64}$/.test(data.messageId)
  ) {
    return { ok: false, reason: "messageId must be a valid identifier between 1 and 64 characters" };
  }

  return { ok: true };
}

const defaultPeerCapabilityRegistry = createPetPeerCapabilityRegistry();
const defaultPeerHandleStore = createPetPeerHandleStore();
const defaultPeerSendRateLimiter = createPeerSendRateLimiter();

function handlePetPeerCatalogPost(req, res, options = {}) {
  const { ctx, remoteProfile = null } = options;

  const chunks = [];
  let bodySize = 0;
  let tooLarge = false;

  req.on("data", (chunk) => {
    if (tooLarge) return;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : (typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    bodySize += buf.length;
    if (bodySize > MAX_PET_PEER_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      return;
    }
    chunks.push(buf);
  });

  req.on("end", async () => {
    if (tooLarge) {
      sendJsonResponse(res, 413, { status: "rejected", reason: "payload too large" });
      return;
    }

    let data;
    try {
      const body = Buffer.concat(chunks).toString("utf8");
      data = JSON.parse(body);
    } catch {
      sendJsonResponse(res, 400, { status: "rejected", reason: "bad json" });
      return;
    }

    const validation = validatePetPeerCatalogPayload(data);
    if (!validation.ok) {
      sendJsonResponse(res, 400, { status: "rejected", reason: validation.reason });
      return;
    }

    const callerProfileId = (remoteProfile && typeof remoteProfile.profileId === "string" && remoteProfile.profileId.trim())
      ? remoteProfile.profileId
      : "local";

    if (!isValidSessionProfileId(callerProfileId)) {
      sendJsonResponse(res, 403, { status: "rejected", reason: "invalid profileId" });
      return;
    }

    const registry = options.peerCapabilityRegistry
      || (ctx && ctx.peerCapabilityRegistry)
      || defaultPeerCapabilityRegistry;

    const callerVerified = typeof registry.verifyCapability === "function" && registry.verifyCapability({
      profileId: callerProfileId,
      agentId: "pi",
      rawSessionId: data.rawSessionId,
      token: data.capabilityToken,
    });

    if (!callerVerified) {
      sendJsonResponse(res, 403, { status: "rejected", reason: "invalid or expired capability token" });
      return;
    }

    const callerGeneration = registry.getGeneration({
      profileId: callerProfileId,
      agentId: "pi",
      rawSessionId: data.rawSessionId,
    });

    const handleStore = options.peerHandleStore
      || (ctx && ctx.peerHandleStore)
      || defaultPeerHandleStore;

    const nowMs = typeof options.now === "function" ? options.now() : Date.now();

    // Scan sessions from snapshot
    let candidateSessions = [];
    const getSnapshotFn = options.getSessionSnapshot
      || (ctx && ctx.getSessionSnapshot);

    if (typeof getSnapshotFn === "function") {
      try {
        const snapshot = getSnapshotFn();
        if (snapshot && Array.isArray(snapshot.sessions)) {
          candidateSessions = snapshot.sessions;
        } else if (Array.isArray(snapshot)) {
          candidateSessions = snapshot;
        } else if (snapshot instanceof Map) {
          candidateSessions = Array.from(snapshot.values());
        } else {
          sendJsonResponse(res, 500, { status: "failed", reason: "invalid session snapshot" });
          return;
        }
      } catch {
        sendJsonResponse(res, 500, { status: "failed", reason: "failed to retrieve session snapshot" });
        return;
      }
    } else if (Array.isArray(options.sessions)) {
      candidateSessions = options.sessions;
    } else if (ctx && Array.isArray(ctx.sessions)) {
      candidateSessions = ctx.sessions;
    } else {
      sendJsonResponse(res, 503, { status: "failed", reason: "session snapshot unavailable" });
      return;
    }

    const results = [];

    for (const session of candidateSessions) {
      if (!session || typeof session !== "object") continue;

      // Only interactive Pi sessions
      if (session.agentId !== "pi") continue;

      const targetProfileId = (typeof session.profileId === "string" && session.profileId.trim())
        ? session.profileId
        : "local";
      const targetRawSessionId = session.rawSessionId || session.id;

      // Exclude caller itself
      if (targetProfileId === callerProfileId && targetRawSessionId === data.rawSessionId) {
        continue;
      }

      // Exclude headless, startupRecovered, hiddenFromHud
      if (session.headless === true || session.startupRecovered === true || session.hiddenFromHud === true) {
        continue;
      }

      // Exclude sleeping / offline / closed
      if (isInactiveState(session.state)) {
        continue;
      }

      // Target must currently have an active capability in registry
      const hasCap = typeof registry.hasCapability === "function" && registry.hasCapability({
        profileId: targetProfileId,
        agentId: "pi",
        rawSessionId: targetRawSessionId,
      });
      if (!hasCap) {
        continue;
      }

      const targetGeneration = registry.getGeneration({
        profileId: targetProfileId,
        agentId: "pi",
        rawSessionId: targetRawSessionId,
      });

      // Sanitized projections: bounded "<sanitized title> · Pi"
      const displayName = sanitizeDisplayName(session.displayTitle || session.sessionTitle || session.agentName || "Pi");
      const host = sanitizeHost(session.sourceDisplayLabel || session.host || "local");
      const state = sanitizeState(session.state || "idle");

      // Apply optional query filters on sanitized fields
      if (data.state !== undefined && state !== sanitizeState(data.state)) {
        continue;
      }
      if (data.host !== undefined && host.toLowerCase() !== sanitizeHost(data.host).toLowerCase()) {
        continue;
      }

      // Create handle scoped to caller & target generations
      const { handle, expiresAtMs } = handleStore.createCatalogHandle({
        caller: {
          profileId: callerProfileId,
          agentId: "pi",
          rawSessionId: data.rawSessionId,
        },
        callerGeneration,
        target: {
          profileId: targetProfileId,
          agentId: "pi",
          rawSessionId: targetRawSessionId,
          displayName,
          host,
        },
        targetGeneration,
        nowMs,
      });

      results.push({
        handle,
        displayName,
        host,
        state,
        capabilities: ["receive_peer_message"],
        canMessage: true,
        expiresAtMs,
      });
    }

    sendJsonResponse(res, 200, {
      schemaVersion: "1",
      kind: "peer_catalog",
      sessions: results,
    });
  });

  req.on("error", (err) => {
    try {
      sendJsonResponse(res, 500, { status: "failed", reason: (err && err.message) || "request stream error" });
    } catch {}
  });
}

function handlePetPeerSendPost(req, res, options = {}) {
  const { ctx, remoteProfile = null } = options;

  const chunks = [];
  let bodySize = 0;
  let tooLarge = false;

  req.on("data", (chunk) => {
    if (tooLarge) return;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : (typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    bodySize += buf.length;
    if (bodySize > MAX_PET_PEER_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      return;
    }
    chunks.push(buf);
  });

  req.on("end", async () => {
    if (tooLarge) {
      sendJsonResponse(res, 413, { status: "rejected", reason: "payload too large" });
      return;
    }

    let data;
    try {
      const body = Buffer.concat(chunks).toString("utf8");
      data = JSON.parse(body);
    } catch {
      sendJsonResponse(res, 400, { status: "rejected", reason: "bad json" });
      return;
    }

    const validation = validatePetPeerSendPayload(data);
    if (!validation.ok) {
      sendJsonResponse(res, 400, { status: "rejected", reason: validation.reason });
      return;
    }

    const callerProfileId = (remoteProfile && typeof remoteProfile.profileId === "string" && remoteProfile.profileId.trim())
      ? remoteProfile.profileId
      : "local";

    if (!isValidSessionProfileId(callerProfileId)) {
      sendJsonResponse(res, 403, { status: "rejected", reason: "invalid profileId" });
      return;
    }

    const callerIdentity = {
      profileId: callerProfileId,
      agentId: "pi",
      rawSessionId: data.rawSessionId,
    };

    const registry = options.peerCapabilityRegistry
      || (ctx && ctx.peerCapabilityRegistry)
      || defaultPeerCapabilityRegistry;

    const callerVerified = typeof registry.verifyCapability === "function" && registry.verifyCapability({
      profileId: callerProfileId,
      agentId: "pi",
      rawSessionId: data.rawSessionId,
      token: data.capabilityToken,
    });

    if (!callerVerified) {
      sendJsonResponse(res, 403, { status: "rejected", reason: "invalid or expired capability token" });
      return;
    }

    const nowMs = typeof options.now === "function" ? options.now() : Date.now();

    const rateLimiter = options.peerSendRateLimiter
      || (ctx && ctx.peerSendRateLimiter)
      || defaultPeerSendRateLimiter;

    const rateCheck = rateLimiter.check(callerIdentity, nowMs);
    if (!rateCheck.allowed) {
      sendJsonResponse(res, 429, {
        status: "rejected",
        reason: "rate limit exceeded",
        retryAfterMs: rateCheck.resetMs,
      });
      return;
    }

    const handleStore = options.peerHandleStore
      || (ctx && ctx.peerHandleStore)
      || defaultPeerHandleStore;

    // Atomically resolve and consume handle (single use, concurrency-safe)
    const handleResult = handleStore.resolveAndConsumeHandle(data.target, {
      caller: callerIdentity,
      registry,
      nowMs,
    });

    if (!handleResult.ok) {
      if (handleResult.reason === "expired") {
        sendJsonResponse(res, 422, { status: "rejected", reason: "handle expired" });
        return;
      }
      if (handleResult.reason === "capability_rotated" || handleResult.reason === "target_capability_rotated") {
        sendJsonResponse(res, 403, { status: "rejected", reason: "capability token rotated" });
        return;
      }
      sendJsonResponse(res, 422, { status: "rejected", reason: `invalid handle: ${handleResult.reason}` });
      return;
    }

    const handleEntry = handleResult.entry;
    const targetIdentity = handleEntry.target;

    // Self-send forbidden
    if (targetIdentity.profileId === callerProfileId && targetIdentity.rawSessionId === data.rawSessionId) {
      sendJsonResponse(res, 422, { status: "rejected", reason: "self-send forbidden" });
      return;
    }

    // Target re-checked active & capable in capability registry
    const targetCapable = typeof registry.hasCapability === "function" && registry.hasCapability(targetIdentity);
    if (!targetCapable) {
      sendJsonResponse(res, 422, { status: "rejected", reason: "target session is not capable or inactive" });
      return;
    }

    // Snapshot check: getSessionSnapshot is strictly required, fails closed if missing or throws
    const getSnapshotFn = options.getSessionSnapshot
      || (ctx && ctx.getSessionSnapshot);

    if (typeof getSnapshotFn !== "function") {
      sendJsonResponse(res, 503, { status: "failed", reason: "session snapshot unavailable" });
      return;
    }

    let candidateSessions = [];
    try {
      const snapshot = getSnapshotFn();
      if (snapshot && Array.isArray(snapshot.sessions)) {
        candidateSessions = snapshot.sessions;
      } else if (Array.isArray(snapshot)) {
        candidateSessions = snapshot;
      } else if (snapshot instanceof Map) {
        candidateSessions = Array.from(snapshot.values());
      } else {
        candidateSessions = [];
      }
    } catch {
      sendJsonResponse(res, 500, { status: "failed", reason: "failed to retrieve session snapshot" });
      return;
    }

    let callerSnapshotEntry = null;
    let targetSnapshotEntry = null;

    for (const s of candidateSessions) {
      if (!s || typeof s !== "object") continue;
      const sProf = (typeof s.profileId === "string" && s.profileId.trim()) ? s.profileId : "local";
      const sRaw = s.rawSessionId || s.id;

      if (sProf === callerProfileId && sRaw === data.rawSessionId) {
        callerSnapshotEntry = s;
      }
      if (sProf === targetIdentity.profileId && sRaw === targetIdentity.rawSessionId) {
        targetSnapshotEntry = s;
      }
    }

    // Caller exact snapshot entry must exist and be eligible
    if (
      !callerSnapshotEntry
      || callerSnapshotEntry.agentId !== "pi"
      || callerSnapshotEntry.headless === true
      || callerSnapshotEntry.startupRecovered === true
      || callerSnapshotEntry.hiddenFromHud === true
      || isInactiveState(callerSnapshotEntry.state)
    ) {
      sendJsonResponse(res, 422, { status: "rejected", reason: "caller session is inactive, closed, or ineligible" });
      return;
    }

    // Target exact snapshot entry must exist, be Pi, and be active/eligible
    if (
      !targetSnapshotEntry
      || targetSnapshotEntry.agentId !== "pi"
      || targetSnapshotEntry.headless === true
      || targetSnapshotEntry.startupRecovered === true
      || targetSnapshotEntry.hiddenFromHud === true
      || isInactiveState(targetSnapshotEntry.state)
    ) {
      sendJsonResponse(res, 422, { status: "rejected", reason: "target session is inactive, closed, or not found" });
      return;
    }

    // Derive sourceDisplayName and sourceHost strictly from caller snapshot provenance
    const sourceDisplayName = sanitizeDisplayName(
      callerSnapshotEntry.displayTitle || callerSnapshotEntry.sessionTitle || callerSnapshotEntry.agentName || "Pi"
    );
    const sourceHost = sanitizeHost(
      callerSnapshotEntry.sourceDisplayLabel || callerSnapshotEntry.host || "local"
    );

    // Determine threadId, hopCount, maxHops, replyHandle
    let threadId;
    let hopCount;
    const maxHops = 1;
    let replyHandle = null;

    if (handleEntry.type === "catalog") {
      // Hop 0 initial note
      hopCount = 0;
      threadId = `thr_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

      // Create single reply handle scoped to receiver -> original sender
      const callerGen = registry.getGeneration(callerIdentity);
      const targetGen = registry.getGeneration(targetIdentity);

      const createdReply = handleStore.createReplyHandle({
        caller: targetIdentity,
        callerGeneration: targetGen,
        target: {
          profileId: callerProfileId,
          agentId: "pi",
          rawSessionId: data.rawSessionId,
          displayName: sourceDisplayName,
          host: sourceHost,
        },
        targetGeneration: callerGen,
        threadId,
        nowMs,
      });
      replyHandle = createdReply.handle;
    } else {
      // Hop 1 reply note -> creates NO next reply handle
      hopCount = 1;
      threadId = handleEntry.threadId;
      replyHandle = null;
    }

    // Coordinator-authored metadata
    const messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const dedupKey = messageId;
    const ttlMs = PEER_MESSAGE_TTL_MS;
    const createdAtMs = nowMs;
    const deliverAs = "followUp";

    const env = options.env || (ctx && ctx.env) || process.env;

    // Resolve derivePetId and enqueuePeerMessage (prefer loading runtime once)
    let derivePetIdFn = typeof options.derivePetId === "function"
      ? options.derivePetId
      : (ctx && typeof ctx.derivePetId === "function" ? ctx.derivePetId : null);
    let enqueuePeerMessageFn = typeof options.enqueuePeerMessage === "function"
      ? options.enqueuePeerMessage
      : (ctx && typeof ctx.enqueuePeerMessage === "function" ? ctx.enqueuePeerMessage : null);

    if (!derivePetIdFn || !enqueuePeerMessageFn) {
      const loadRuntimeFn = options.loadRuntime
        || (ctx && ctx.loadRuntime)
        || loadRuntime;

      let runtimeModule = null;
      try {
        runtimeModule = loadRuntimeFn(env);
      } catch {
        sendJsonResponse(res, 503, { status: "failed", reason: "peer runtime not configured" });
        return;
      }

      if (!runtimeModule) {
        sendJsonResponse(res, 503, { status: "failed", reason: "peer runtime not configured" });
        return;
      }

      if (!derivePetIdFn) {
        if (typeof runtimeModule.derivePetId !== "function") {
          sendJsonResponse(res, 503, { status: "failed", reason: "peer runtime not configured" });
          return;
        }
        derivePetIdFn = runtimeModule.derivePetId;
      }

      if (!enqueuePeerMessageFn) {
        if (typeof runtimeModule.enqueuePeerMessage !== "function") {
          sendJsonResponse(res, 503, { status: "failed", reason: "peer runtime not configured" });
          return;
        }
        enqueuePeerMessageFn = runtimeModule.enqueuePeerMessage;
      }
    }

    let sourcePetId;
    let targetPetId;
    try {
      sourcePetId = derivePetIdFn(callerIdentity);
      targetPetId = derivePetIdFn(targetIdentity);
    } catch (err) {
      sendJsonResponse(res, 500, { status: "failed", reason: (err && err.message) || "failed to derive petId" });
      return;
    }

    // Call enqueuePeerMessage strictly synchronously (no await)
    let receipt;
    try {
      receipt = enqueuePeerMessageFn({
        targetPetId,
        sourcePetId,
        sourceDisplayName,
        sourceHost,
        text: data.text,
        deliverAs,
        messageId,
        dedupKey,
        threadId,
        hopCount,
        maxHops,
        ...(replyHandle ? { replyHandle } : {}),
        ttlMs,
        createdAtMs,
        ...(options.dataDir ? { dataDir: options.dataDir } : {}),
        ...(env ? { env } : {}),
      });
    } catch (err) {
      sendJsonResponse(res, 500, { status: "failed", reason: (err && err.message) || "unexpected enqueue error" });
      return;
    }

    // Reject Promise/thenable as invalid runtime result
    if (receipt && (typeof receipt.then === "function" || typeof receipt.catch === "function" || receipt instanceof Promise)) {
      sendJsonResponse(res, 500, { status: "failed", reason: "enqueuePeerMessage returned a Promise but must be synchronous" });
      return;
    }

    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      sendJsonResponse(res, 500, { status: "failed", reason: "invalid receipt from peer runtime" });
      return;
    }

    const fallbackMeta = {
      messageId,
      threadId,
      hopCount,
      maxHops,
      createdAtMs,
      expiresAtMs: createdAtMs + ttlMs,
    };
    const sanitizedReceipt = projectSendReceipt(receipt, fallbackMeta);

    if (sanitizedReceipt.status === "queued") {
      rateLimiter.record(callerIdentity, nowMs);
      sendJsonResponse(res, 202, sanitizedReceipt);
    } else if (sanitizedReceipt.status === "dispatched") {
      rateLimiter.record(callerIdentity, nowMs);
      sendJsonResponse(res, 200, sanitizedReceipt);
    } else if (sanitizedReceipt.status === "rejected" || sanitizedReceipt.status === "expired") {
      sendJsonResponse(res, 422, sanitizedReceipt);
    } else if (sanitizedReceipt.status === "failed") {
      sendJsonResponse(res, 500, sanitizedReceipt);
    } else {
      sendJsonResponse(res, 500, sanitizedReceipt.status ? sanitizedReceipt : { status: "failed", reason: sanitizedReceipt.reason || "unexpected receipt status" });
    }
  });

  req.on("error", (err) => {
    try {
      sendJsonResponse(res, 500, { status: "failed", reason: (err && err.message) || "request stream error" });
    } catch {}
  });
}

function handlePetPeerClaimPost(req, res, options = {}) {
  const { ctx, remoteProfile = null } = options;

  const callerProfileId = (remoteProfile && typeof remoteProfile.profileId === "string" && remoteProfile.profileId.trim())
    ? remoteProfile.profileId
    : "local";

  if (!isValidSessionProfileId(callerProfileId)) {
    sendJsonResponse(res, 403, { status: "rejected", reason: "invalid profileId" });
    return;
  }

  const chunks = [];
  let bodySize = 0;
  let tooLarge = false;

  req.on("data", (chunk) => {
    if (tooLarge) return;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : (typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    bodySize += buf.length;
    if (bodySize > MAX_PET_PEER_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      return;
    }
    chunks.push(buf);
  });

  req.on("end", async () => {
    if (tooLarge) {
      sendJsonResponse(res, 413, { status: "rejected", reason: "payload too large" });
      return;
    }

    let data;
    try {
      const body = Buffer.concat(chunks).toString("utf8");
      data = JSON.parse(body);
    } catch {
      sendJsonResponse(res, 400, { status: "rejected", reason: "bad json" });
      return;
    }

    const validation = validatePetPeerClaimPayload(data);
    if (!validation.ok) {
      sendJsonResponse(res, 400, { status: "rejected", reason: validation.reason });
      return;
    }

    const registry = options.peerCapabilityRegistry
      || (ctx && ctx.peerCapabilityRegistry)
      || defaultPeerCapabilityRegistry;

    const callerVerified = typeof registry.verifyCapability === "function" && registry.verifyCapability({
      profileId: callerProfileId,
      agentId: "pi",
      rawSessionId: data.rawSessionId,
      token: data.capabilityToken,
    });

    if (!callerVerified) {
      sendJsonResponse(res, 403, { status: "rejected", reason: "invalid or expired capability token" });
      return;
    }

    const env = options.env || (ctx && ctx.env) || process.env;

    let claimNextPeerMessageFn = typeof options.claimNextPeerMessage === "function"
      ? options.claimNextPeerMessage
      : (ctx && typeof ctx.claimNextPeerMessage === "function" ? ctx.claimNextPeerMessage : null);
    let derivePetIdFn = typeof options.derivePetId === "function"
      ? options.derivePetId
      : (ctx && typeof ctx.derivePetId === "function" ? ctx.derivePetId : null);

    if (!claimNextPeerMessageFn || !derivePetIdFn) {
      const loadRuntimeFn = options.loadRuntime
        || (ctx && ctx.loadRuntime)
        || loadRuntime;

      let runtimeModule = null;
      try {
        runtimeModule = loadRuntimeFn(env);
      } catch {
        sendJsonResponse(res, 503, { status: "failed", reason: "peer runtime not configured" });
        return;
      }

      if (!runtimeModule) {
        sendJsonResponse(res, 503, { status: "failed", reason: "peer runtime not configured" });
        return;
      }

      if (!claimNextPeerMessageFn) {
        if (typeof runtimeModule.claimNextPeerMessage !== "function") {
          sendJsonResponse(res, 503, { status: "failed", reason: "peer runtime not configured" });
          return;
        }
        claimNextPeerMessageFn = runtimeModule.claimNextPeerMessage;
      }

      if (!derivePetIdFn) {
        if (typeof runtimeModule.derivePetId !== "function") {
          sendJsonResponse(res, 503, { status: "failed", reason: "peer runtime not configured" });
          return;
        }
        derivePetIdFn = runtimeModule.derivePetId;
      }
    }

    try {
      const targetPetId = derivePetIdFn({
        profileId: callerProfileId,
        agentId: "pi",
        rawSessionId: data.rawSessionId,
      });

      const claimResult = await claimNextPeerMessageFn({
        targetPetId,
        profileId: callerProfileId,
        agentId: "pi",
        rawSessionId: data.rawSessionId,
        ...(options.dataDir ? { dataDir: options.dataDir } : {}),
        ...(env ? { env } : {}),
      });

      if (!claimResult) {
        sendJsonResponse(res, 200, { status: "empty" });
        return;
      }

      if (typeof claimResult !== "object" || Array.isArray(claimResult)) {
        sendJsonResponse(res, 500, { status: "failed", reason: "invalid claim result from peer runtime" });
        return;
      }

      const canonicalClaimed = {
        schemaVersion: typeof claimResult.schemaVersion === "string" ? claimResult.schemaVersion : "1",
        kind: typeof claimResult.kind === "string" ? claimResult.kind : "peer_message",
        status: "claimed",
        messageId: claimResult.messageId || "",
        sourceDisplayName: claimResult.sourceDisplayName || "Pi",
        sourceHost: claimResult.sourceHost || "local",
        text: typeof claimResult.text === "string" ? claimResult.text : "",
        deliverAs: claimResult.deliverAs || "followUp",
        threadId: claimResult.threadId || "",
        hopCount: typeof claimResult.hopCount === "number" ? claimResult.hopCount : 0,
        maxHops: typeof claimResult.maxHops === "number" ? claimResult.maxHops : 1,
        replyHandle: claimResult.replyHandle || null,
        createdAtMs: typeof claimResult.createdAtMs === "number" ? claimResult.createdAtMs : 0,
        expiresAtMs: typeof claimResult.expiresAtMs === "number" ? claimResult.expiresAtMs : 0,
        claimToken: claimResult.claimToken || "",
        claimedAtMs: typeof claimResult.claimedAtMs === "number" ? claimResult.claimedAtMs : 0,
      };

      sendJsonResponse(res, 200, canonicalClaimed);
    } catch (err) {
      sendJsonResponse(res, 500, { status: "failed", reason: (err && err.message) || "unexpected error" });
    }
  });

  req.on("error", (err) => {
    try {
      sendJsonResponse(res, 500, { status: "failed", reason: (err && err.message) || "request stream error" });
    } catch {}
  });
}

function handlePetPeerSettlePost(req, res, options = {}) {
  const { ctx, remoteProfile = null } = options;

  const callerProfileId = (remoteProfile && typeof remoteProfile.profileId === "string" && remoteProfile.profileId.trim())
    ? remoteProfile.profileId
    : "local";

  if (!isValidSessionProfileId(callerProfileId)) {
    sendJsonResponse(res, 403, { status: "rejected", reason: "invalid profileId" });
    return;
  }

  const chunks = [];
  let bodySize = 0;
  let tooLarge = false;

  req.on("data", (chunk) => {
    if (tooLarge) return;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : (typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    bodySize += buf.length;
    if (bodySize > MAX_PET_PEER_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      return;
    }
    chunks.push(buf);
  });

  req.on("end", async () => {
    if (tooLarge) {
      sendJsonResponse(res, 413, { status: "rejected", reason: "payload too large" });
      return;
    }

    let data;
    try {
      const body = Buffer.concat(chunks).toString("utf8");
      data = JSON.parse(body);
    } catch {
      sendJsonResponse(res, 400, { status: "rejected", reason: "bad json" });
      return;
    }

    const validation = validatePetPeerSettlePayload(data);
    if (!validation.ok) {
      sendJsonResponse(res, 400, { status: "rejected", reason: validation.reason });
      return;
    }

    const registry = options.peerCapabilityRegistry
      || (ctx && ctx.peerCapabilityRegistry)
      || defaultPeerCapabilityRegistry;

    const callerVerified = typeof registry.verifyCapability === "function" && registry.verifyCapability({
      profileId: callerProfileId,
      agentId: "pi",
      rawSessionId: data.rawSessionId,
      token: data.capabilityToken,
    });

    if (!callerVerified) {
      sendJsonResponse(res, 403, { status: "rejected", reason: "invalid or expired capability token" });
      return;
    }

    const env = options.env || (ctx && ctx.env) || process.env;

    let settlePeerMessageFn = typeof options.settlePeerMessage === "function"
      ? options.settlePeerMessage
      : (ctx && typeof ctx.settlePeerMessage === "function" ? ctx.settlePeerMessage : null);
    let derivePetIdFn = typeof options.derivePetId === "function"
      ? options.derivePetId
      : (ctx && typeof ctx.derivePetId === "function" ? ctx.derivePetId : null);

    if (!settlePeerMessageFn || !derivePetIdFn) {
      const loadRuntimeFn = options.loadRuntime
        || (ctx && ctx.loadRuntime)
        || loadRuntime;

      let runtimeModule = null;
      try {
        runtimeModule = loadRuntimeFn(env);
      } catch {
        sendJsonResponse(res, 503, { status: "failed", reason: "peer runtime not configured" });
        return;
      }

      if (!runtimeModule) {
        sendJsonResponse(res, 503, { status: "failed", reason: "peer runtime not configured" });
        return;
      }

      if (!settlePeerMessageFn) {
        if (typeof runtimeModule.settlePeerMessage !== "function") {
          sendJsonResponse(res, 503, { status: "failed", reason: "peer runtime not configured" });
          return;
        }
        settlePeerMessageFn = runtimeModule.settlePeerMessage;
      }

      if (!derivePetIdFn) {
        if (typeof runtimeModule.derivePetId !== "function") {
          sendJsonResponse(res, 503, { status: "failed", reason: "peer runtime not configured" });
          return;
        }
        derivePetIdFn = runtimeModule.derivePetId;
      }
    }

    try {
      const targetPetId = derivePetIdFn({
        profileId: callerProfileId,
        agentId: "pi",
        rawSessionId: data.rawSessionId,
      });

      const receipt = await settlePeerMessageFn({
        targetPetId,
        profileId: callerProfileId,
        agentId: "pi",
        rawSessionId: data.rawSessionId,
        messageId: data.messageId,
        claimToken: data.claimToken,
        status: data.status,
        ...(data.reason !== undefined && data.reason !== null ? { reason: data.reason } : {}),
        ...(options.dataDir ? { dataDir: options.dataDir } : {}),
        ...(env ? { env } : {}),
      });

      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
        sendJsonResponse(res, 500, { status: "failed", reason: "invalid receipt from peer runtime" });
        return;
      }

      const sanitizedReceipt = projectSendReceipt(receipt, { messageId: data.messageId });
      if (sanitizedReceipt.status === "dispatched" || sanitizedReceipt.status === "failed" || sanitizedReceipt.status === "expired") {
        sendJsonResponse(res, 200, sanitizedReceipt);
      } else if (sanitizedReceipt.status === "rejected") {
        sendJsonResponse(res, 422, sanitizedReceipt);
      } else {
        sendJsonResponse(res, 500, sanitizedReceipt.status ? sanitizedReceipt : { status: "failed", reason: sanitizedReceipt.reason || "unexpected receipt status" });
      }
    } catch (err) {
      sendJsonResponse(res, 500, { status: "failed", reason: (err && err.message) || "unexpected error" });
    }
  });

  req.on("error", (err) => {
    try {
      sendJsonResponse(res, 500, { status: "failed", reason: (err && err.message) || "request stream error" });
    } catch {}
  });
}

function handlePetPeerReceiptPost(req, res, options = {}) {
  const { ctx, remoteProfile = null } = options;

  const callerProfileId = (remoteProfile && typeof remoteProfile.profileId === "string" && remoteProfile.profileId.trim())
    ? remoteProfile.profileId
    : "local";

  if (!isValidSessionProfileId(callerProfileId)) {
    sendJsonResponse(res, 403, { status: "rejected", reason: "invalid profileId" });
    return;
  }

  const chunks = [];
  let bodySize = 0;
  let tooLarge = false;

  req.on("data", (chunk) => {
    if (tooLarge) return;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : (typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    bodySize += buf.length;
    if (bodySize > MAX_PET_PEER_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      return;
    }
    chunks.push(buf);
  });

  req.on("end", async () => {
    if (tooLarge) {
      sendJsonResponse(res, 413, { status: "rejected", reason: "payload too large" });
      return;
    }

    let data;
    try {
      const body = Buffer.concat(chunks).toString("utf8");
      data = JSON.parse(body);
    } catch {
      sendJsonResponse(res, 400, { status: "rejected", reason: "bad json" });
      return;
    }

    const validation = validatePetPeerReceiptQueryPayload(data);
    if (!validation.ok) {
      sendJsonResponse(res, 400, { status: "rejected", reason: validation.reason });
      return;
    }

    const registry = options.peerCapabilityRegistry
      || (ctx && ctx.peerCapabilityRegistry)
      || defaultPeerCapabilityRegistry;

    const callerVerified = typeof registry.verifyCapability === "function" && registry.verifyCapability({
      profileId: callerProfileId,
      agentId: "pi",
      rawSessionId: data.rawSessionId,
      token: data.capabilityToken,
    });

    if (!callerVerified) {
      sendJsonResponse(res, 403, { status: "rejected", reason: "invalid or expired capability token" });
      return;
    }

    const env = options.env || (ctx && ctx.env) || process.env;

    let getPeerMessageReceiptFn = typeof options.getPeerMessageReceipt === "function"
      ? options.getPeerMessageReceipt
      : (ctx && typeof ctx.getPeerMessageReceipt === "function" ? ctx.getPeerMessageReceipt : null);
    let derivePetIdFn = typeof options.derivePetId === "function"
      ? options.derivePetId
      : (ctx && typeof ctx.derivePetId === "function" ? ctx.derivePetId : null);

    if (!getPeerMessageReceiptFn || !derivePetIdFn) {
      const loadRuntimeFn = options.loadRuntime
        || (ctx && ctx.loadRuntime)
        || loadRuntime;

      let runtimeModule = null;
      try {
        runtimeModule = loadRuntimeFn(env);
      } catch {
        sendJsonResponse(res, 503, { status: "failed", reason: "peer runtime receipt query not available" });
        return;
      }

      if (!runtimeModule) {
        sendJsonResponse(res, 503, { status: "failed", reason: "peer runtime receipt query not available" });
        return;
      }

      if (!getPeerMessageReceiptFn) {
        if (typeof runtimeModule.getPeerMessageReceipt !== "function") {
          sendJsonResponse(res, 503, { status: "failed", reason: "peer runtime receipt query not available" });
          return;
        }
        getPeerMessageReceiptFn = runtimeModule.getPeerMessageReceipt;
      }

      if (!derivePetIdFn) {
        if (typeof runtimeModule.derivePetId !== "function") {
          sendJsonResponse(res, 503, { status: "failed", reason: "peer runtime receipt query not available" });
          return;
        }
        derivePetIdFn = runtimeModule.derivePetId;
      }
    }

    try {
      const sourcePetId = derivePetIdFn({
        profileId: callerProfileId,
        agentId: "pi",
        rawSessionId: data.rawSessionId,
      });

      const receipt = await getPeerMessageReceiptFn({
        sourcePetId,
        messageId: data.messageId,
        ...(options.dataDir ? { dataDir: options.dataDir } : {}),
        ...(env ? { env } : {}),
      });

      if (!receipt || receipt.status === "not_found") {
        sendJsonResponse(res, 404, { status: "not_found" });
        return;
      }

      if (typeof receipt !== "object" || Array.isArray(receipt)) {
        sendJsonResponse(res, 500, { status: "failed", reason: "invalid receipt from peer runtime" });
        return;
      }

      const sanitizedReceipt = projectSendReceipt(receipt, { messageId: data.messageId });
      sendJsonResponse(res, 200, sanitizedReceipt);
    } catch (err) {
      sendJsonResponse(res, 500, { status: "failed", reason: (err && err.message) || "unexpected error" });
    }
  });

  req.on("error", (err) => {
    try {
      sendJsonResponse(res, 500, { status: "failed", reason: (err && err.message) || "request stream error" });
    } catch {}
  });
}

module.exports = {
  MAX_PET_PEER_BODY_BYTES,
  MAX_RESPONSE_BYTES,
  PEER_HANDLE_TTL_MS,
  PEER_SEND_RATE_LIMIT_WINDOW_MS,
  PEER_SEND_RATE_LIMIT_MAX,
  MAX_UNICODE_CODE_POINTS,
  MAX_SETTLE_REASON_CODE_POINTS,
  PEER_MESSAGE_TTL_MS,
  ALLOWED_CATALOG_KEYS,
  ALLOWED_SEND_KEYS,
  ALLOWED_CLAIM_KEYS,
  ALLOWED_SETTLE_KEYS,
  ALLOWED_RECEIPT_QUERY_KEYS,
  VALID_SETTLE_STATUS_VALUES,
  countUnicodeCodePoints,
  sanitizeDisplayName,
  sanitizeHost,
  sanitizeState,
  isInactiveState,
  isValidRawSessionId,
  isValidPeerRawSessionId,
  isValidSessionProfileId,
  timingSafeTokenMatch,
  projectSendReceipt,
  sendJsonResponse,
  createPetPeerCapabilityRegistry,
  createPetPeerHandleStore,
  createPeerSendRateLimiter,
  validatePetPeerCatalogPayload,
  validatePetPeerSendPayload,
  validatePetPeerClaimPayload,
  validatePetPeerSettlePayload,
  validatePetPeerReceiptQueryPayload,
  handlePetPeerCatalogPost,
  handlePetPeerSendPost,
  handlePetPeerClaimPost,
  handlePetPeerSettlePost,
  handlePetPeerReceiptPost,
};
