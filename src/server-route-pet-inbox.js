"use strict";

const crypto = require("node:crypto");
const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");
const { loadRuntime } = require("./pet-presentation-bridge");

const MAX_PET_INBOX_BODY_BYTES = 16 * 1024; // 16 KiB

const ALLOWED_SCHEMA_KEYS = Object.freeze(new Set([
  "schemaVersion",
  "kind",
  "petId",
  "text",
  "deliverAs",
  "commandId",
  "dedupKey",
  "ttlMs",
]));

const CLAIM_ALLOWED_KEYS = Object.freeze(new Set([
  "schemaVersion",
  "kind",
  "rawSessionId",
  "capabilityToken",
]));

const SETTLE_ALLOWED_KEYS = Object.freeze(new Set([
  "schemaVersion",
  "kind",
  "rawSessionId",
  "capabilityToken",
  "commandId",
  "claimToken",
  "status",
  "reason",
]));

const RECEIPT_QUERY_ALLOWED_KEYS = Object.freeze(new Set([
  "schemaVersion",
  "kind",
  "petId",
  "commandId",
]));

const VALID_SETTLE_STATUS_VALUES = Object.freeze(new Set(["dispatched", "failed", "expired"]));

function isValidRawSessionId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    return false;
  }
  if (!value.trim()) {
    return false;
  }
  if (/[\0\r\n]/.test(value)) {
    return false;
  }
  return true;
}

function timingSafeTokenMatch(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  if (!/^[0-9a-f]{64}$/.test(candidate) || !/^[0-9a-f]{64}$/.test(expected)) return false;
  const candidateBuf = Buffer.from(candidate, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (candidateBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(candidateBuf, expectedBuf);
}

function createPetInboxCapabilityRegistry() {
  const entries = new Map();

  function makeKey(profileId, agentId, rawSessionId) {
    return `${profileId}\0${agentId}\0${rawSessionId}`;
  }

  function registerCapability({ profileId, agentId, rawSessionId, token }) {
    if (!profileId || typeof profileId !== "string" || !profileId.trim() || /[\0\r\n]/.test(profileId)) return false;
    if (agentId !== "pi") return false;
    if (!isValidRawSessionId(rawSessionId)) return false;
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return false;

    const key = makeKey(profileId, "pi", rawSessionId);
    entries.set(key, token);
    return true;
  }

  function revokeCapability({ profileId, agentId, rawSessionId }) {
    if (!profileId || typeof profileId !== "string" || !profileId.trim() || /[\0\r\n]/.test(profileId)) return false;
    if (agentId !== "pi") return false;
    if (!isValidRawSessionId(rawSessionId)) return false;

    const key = makeKey(profileId, "pi", rawSessionId);
    return entries.delete(key);
  }

  function verifyCapability({ profileId, agentId, rawSessionId, token }) {
    if (!profileId || typeof profileId !== "string" || !profileId.trim() || /[\0\r\n]/.test(profileId)) return false;
    if (agentId !== "pi") return false;
    if (!isValidRawSessionId(rawSessionId)) return false;
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return false;

    const key = makeKey(profileId, "pi", rawSessionId);
    const expected = entries.get(key);
    if (!expected) return false;

    return timingSafeTokenMatch(token, expected);
  }

  function clear() {
    entries.clear();
  }

  return {
    registerCapability,
    revokeCapability,
    verifyCapability,
    clear,
    get size() {
      return entries.size;
    },
  };
}

function validatePetInboxPayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "Payload must be an object" };
  }

  for (const key of Object.keys(data)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) {
      return { ok: false, reason: `Unknown property: "${key}"` };
    }
  }

  if (data.schemaVersion !== "1") {
    return { ok: false, reason: "schemaVersion must be '1'" };
  }

  if (data.kind !== "user_message") {
    return { ok: false, reason: "kind must be 'user_message'" };
  }

  if (
    typeof data.petId !== "string"
    || data.petId.length < 1
    || data.petId.length > 128
    || !/^[A-Za-z0-9_-]{1,128}$/.test(data.petId)
  ) {
    return { ok: false, reason: "petId must be a valid identifier between 1 and 128 characters" };
  }

  if (typeof data.text !== "string" || data.text.length < 1 || data.text.length > 2000) {
    return { ok: false, reason: "text must be a string between 1 and 2000 characters" };
  }

  if (data.deliverAs !== undefined) {
    if (data.deliverAs !== "followUp") {
      return { ok: false, reason: "deliverAs must be 'followUp'" };
    }
  }

  if (data.commandId !== undefined) {
    if (
      typeof data.commandId !== "string"
      || data.commandId.length < 1
      || data.commandId.length > 64
      || !/^[A-Za-z0-9_-]{1,64}$/.test(data.commandId)
    ) {
      return { ok: false, reason: "commandId must be a valid identifier between 1 and 64 characters" };
    }
  }

  if (data.dedupKey !== undefined) {
    if (
      typeof data.dedupKey !== "string"
      || data.dedupKey.length < 1
      || data.dedupKey.length > 64
      || !/^[A-Za-z0-9_-]{1,64}$/.test(data.dedupKey)
    ) {
      return { ok: false, reason: "dedupKey must be a valid identifier between 1 and 64 characters" };
    }
  }

  if (data.ttlMs !== undefined) {
    if (typeof data.ttlMs !== "number" || !Number.isInteger(data.ttlMs) || data.ttlMs < 1000 || data.ttlMs > 300000) {
      return { ok: false, reason: "ttlMs must be an integer between 1000 and 300000" };
    }
  }

  return { ok: true };
}

function validatePetInboxClaimPayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "Payload must be an object" };
  }

  for (const key of Object.keys(data)) {
    if (!CLAIM_ALLOWED_KEYS.has(key)) {
      return { ok: false, reason: `Unknown property: "${key}"` };
    }
  }

  if (data.schemaVersion !== "1") {
    return { ok: false, reason: "schemaVersion must be '1'" };
  }

  if (data.kind !== "user_message_claim") {
    return { ok: false, reason: "kind must be 'user_message_claim'" };
  }

  if (!isValidRawSessionId(data.rawSessionId)) {
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

function validatePetInboxSettlePayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "Payload must be an object" };
  }

  for (const key of Object.keys(data)) {
    if (!SETTLE_ALLOWED_KEYS.has(key)) {
      return { ok: false, reason: `Unknown property: "${key}"` };
    }
  }

  if (data.schemaVersion !== "1") {
    return { ok: false, reason: "schemaVersion must be '1'" };
  }

  if (data.kind !== "user_message_settle") {
    return { ok: false, reason: "kind must be 'user_message_settle'" };
  }

  if (!isValidRawSessionId(data.rawSessionId)) {
    return { ok: false, reason: "rawSessionId must be a non-empty string up to 4096 characters without null, newline, or carriage return characters" };
  }

  if (
    typeof data.capabilityToken !== "string"
    || !/^[0-9a-f]{64}$/.test(data.capabilityToken)
  ) {
    return { ok: false, reason: "capabilityToken must be a 64-character lowercase hex string" };
  }

  if (
    typeof data.commandId !== "string"
    || data.commandId.length < 1
    || data.commandId.length > 64
    || !/^[A-Za-z0-9_-]{1,64}$/.test(data.commandId)
  ) {
    return { ok: false, reason: "commandId must be a valid identifier between 1 and 64 characters" };
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

  if (data.reason !== undefined && data.reason !== null && typeof data.reason !== "string") {
    return { ok: false, reason: "reason must be a string or null if provided" };
  }

  return { ok: true };
}

function validatePetInboxReceiptQueryPayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "Payload must be an object" };
  }

  for (const key of Object.keys(data)) {
    if (!RECEIPT_QUERY_ALLOWED_KEYS.has(key)) {
      return { ok: false, reason: `Unknown property: "${key}"` };
    }
  }

  if (data.schemaVersion !== "1") {
    return { ok: false, reason: "schemaVersion must be '1'" };
  }

  if (data.kind !== "user_message_receipt_query") {
    return { ok: false, reason: "kind must be 'user_message_receipt_query'" };
  }

  if (
    typeof data.petId !== "string"
    || data.petId.length < 1
    || data.petId.length > 128
    || !/^[A-Za-z0-9_-]{1,128}$/.test(data.petId)
  ) {
    return { ok: false, reason: "petId must be a valid identifier between 1 and 128 characters" };
  }

  if (
    typeof data.commandId !== "string"
    || data.commandId.length < 1
    || data.commandId.length > 64
    || !/^[A-Za-z0-9_-]{1,64}$/.test(data.commandId)
  ) {
    return { ok: false, reason: "commandId must be a valid identifier between 1 and 64 characters" };
  }

  return { ok: true };
}

function sendJsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
  });
  res.end(JSON.stringify(payload));
}

function handlePetInboxPost(req, res, options = {}) {
  const { ctx, remoteProfile = null } = options;

  if (remoteProfile) {
    sendJsonResponse(res, 403, { status: "rejected", reason: "remote inbox delivery is not allowed" });
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
    if (bodySize > MAX_PET_INBOX_BODY_BYTES) {
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

    const validation = validatePetInboxPayload(data);
    if (!validation.ok) {
      sendJsonResponse(res, 400, { status: "rejected", reason: validation.reason });
      return;
    }

    const env = options.env || (ctx && ctx.env) || process.env;

    let enqueueUserMessageFn = null;
    if (typeof options.enqueueUserMessage === "function") {
      enqueueUserMessageFn = options.enqueueUserMessage;
    } else if (ctx && typeof ctx.enqueueUserMessage === "function") {
      enqueueUserMessageFn = ctx.enqueueUserMessage;
    } else {
      const loadRuntimeFn = options.loadRuntime
        || (ctx && ctx.loadRuntime)
        || loadRuntime;

      let runtimeModule = null;
      try {
        runtimeModule = loadRuntimeFn(env);
      } catch {
        sendJsonResponse(res, 503, { status: "failed", reason: "pet runtime not configured" });
        return;
      }

      if (!runtimeModule || typeof runtimeModule.enqueueUserMessage !== "function") {
        sendJsonResponse(res, 503, { status: "failed", reason: "pet runtime not configured" });
        return;
      }

      enqueueUserMessageFn = runtimeModule.enqueueUserMessage;
    }

    try {
      const receipt = await enqueueUserMessageFn({
        petId: data.petId,
        text: data.text,
        deliverAs: "followUp",
        ...(data.commandId !== undefined ? { commandId: data.commandId } : {}),
        ...(data.dedupKey !== undefined ? { dedupKey: data.dedupKey } : {}),
        ...(data.ttlMs !== undefined ? { ttlMs: data.ttlMs } : {}),
        ...(options.dataDir ? { dataDir: options.dataDir } : {}),
        ...(env ? { env } : {}),
      });

      if (!receipt || typeof receipt !== "object") {
        sendJsonResponse(res, 500, { status: "failed", reason: "invalid receipt from pet runtime" });
        return;
      }

      if (receipt.status === "queued") {
        sendJsonResponse(res, 202, receipt);
      } else if (receipt.status === "dispatched") {
        sendJsonResponse(res, 200, receipt);
      } else if (receipt.status === "rejected" || receipt.status === "expired") {
        sendJsonResponse(res, 422, receipt);
      } else if (receipt.status === "failed") {
        sendJsonResponse(res, 500, receipt);
      } else {
        sendJsonResponse(res, 500, receipt.status ? receipt : { status: "failed", reason: receipt.reason || "unexpected receipt status" });
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

function handlePetInboxClaimPost(req, res, options = {}) {
  const { ctx, remoteProfile = null } = options;

  if (!remoteProfile || typeof remoteProfile.profileId !== "string" || !remoteProfile.profileId.trim()) {
    sendJsonResponse(res, 403, { status: "rejected", reason: "profile-bound ingress required" });
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
    if (bodySize > MAX_PET_INBOX_BODY_BYTES) {
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

    const validation = validatePetInboxClaimPayload(data);
    if (!validation.ok) {
      sendJsonResponse(res, 400, { status: "rejected", reason: validation.reason });
      return;
    }

    const verifyCapabilityFn = options.verifyPetInboxCapability
      || (ctx && ctx.verifyPetInboxCapability);

    const verified = typeof verifyCapabilityFn === "function" && verifyCapabilityFn({
      profileId: remoteProfile.profileId,
      agentId: "pi",
      rawSessionId: data.rawSessionId,
      token: data.capabilityToken,
    });

    if (!verified) {
      sendJsonResponse(res, 403, { status: "rejected", reason: "invalid or expired capability token" });
      return;
    }

    const env = options.env || (ctx && ctx.env) || process.env;
    let claimNextUserMessageFn = null;
    let derivePetIdFn = null;

    if (typeof options.claimNextUserMessage === "function" || typeof options.derivePetId === "function") {
      if (typeof options.claimNextUserMessage === "function" && typeof options.derivePetId === "function") {
        claimNextUserMessageFn = options.claimNextUserMessage;
        derivePetIdFn = options.derivePetId;
      } else {
        sendJsonResponse(res, 503, { status: "failed", reason: "pet runtime not configured" });
        return;
      }
    } else if (ctx && (typeof ctx.claimNextUserMessage === "function" || typeof ctx.derivePetId === "function")) {
      if (typeof ctx.claimNextUserMessage === "function" && typeof ctx.derivePetId === "function") {
        claimNextUserMessageFn = ctx.claimNextUserMessage;
        derivePetIdFn = ctx.derivePetId;
      } else {
        sendJsonResponse(res, 503, { status: "failed", reason: "pet runtime not configured" });
        return;
      }
    } else {
      const loadRuntimeFn = options.loadRuntime
        || (ctx && ctx.loadRuntime)
        || loadRuntime;

      let runtimeModule = null;
      try {
        runtimeModule = loadRuntimeFn(env);
      } catch {
        sendJsonResponse(res, 503, { status: "failed", reason: "pet runtime not configured" });
        return;
      }

      if (
        !runtimeModule
        || typeof runtimeModule.claimNextUserMessage !== "function"
        || typeof runtimeModule.derivePetId !== "function"
      ) {
        sendJsonResponse(res, 503, { status: "failed", reason: "pet runtime not configured" });
        return;
      }

      claimNextUserMessageFn = runtimeModule.claimNextUserMessage;
      derivePetIdFn = runtimeModule.derivePetId;
    }

    try {
      const petId = derivePetIdFn({
        profileId: remoteProfile.profileId,
        agentId: "pi",
        rawSessionId: data.rawSessionId,
      });

      const claimResult = await claimNextUserMessageFn({
        petId,
        profileId: remoteProfile.profileId,
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
        sendJsonResponse(res, 500, { status: "failed", reason: "invalid claim result from pet runtime" });
        return;
      }

      const canonicalClaimed = {
        schemaVersion: typeof claimResult.schemaVersion === "string" ? claimResult.schemaVersion : "1",
        kind: typeof claimResult.kind === "string" ? claimResult.kind : "user_message",
        commandId: claimResult.commandId,
        dedupKey: claimResult.dedupKey,
        petId: claimResult.petId || petId,
        text: claimResult.text,
        deliverAs: claimResult.deliverAs || "followUp",
        createdAtMs: claimResult.createdAtMs,
        expiresAtMs: claimResult.expiresAtMs,
        claimToken: claimResult.claimToken,
        claimedAtMs: claimResult.claimedAtMs,
        ...(claimResult.message && typeof claimResult.message === "object" && !Array.isArray(claimResult.message) ? {
          message: {
            schemaVersion: typeof claimResult.message.schemaVersion === "string" ? claimResult.message.schemaVersion : "1",
            kind: typeof claimResult.message.kind === "string" ? claimResult.message.kind : "user_message",
            commandId: claimResult.message.commandId,
            dedupKey: claimResult.message.dedupKey,
            petId: claimResult.message.petId || petId,
            text: claimResult.message.text,
            deliverAs: claimResult.message.deliverAs || "followUp",
            createdAtMs: claimResult.message.createdAtMs,
            expiresAtMs: claimResult.message.expiresAtMs,
          },
        } : {}),
        status: "claimed",
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

function handlePetInboxSettlePost(req, res, options = {}) {
  const { ctx, remoteProfile = null } = options;

  if (!remoteProfile || typeof remoteProfile.profileId !== "string" || !remoteProfile.profileId.trim()) {
    sendJsonResponse(res, 403, { status: "rejected", reason: "profile-bound ingress required" });
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
    if (bodySize > MAX_PET_INBOX_BODY_BYTES) {
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

    const validation = validatePetInboxSettlePayload(data);
    if (!validation.ok) {
      sendJsonResponse(res, 400, { status: "rejected", reason: validation.reason });
      return;
    }

    const verifyCapabilityFn = options.verifyPetInboxCapability
      || (ctx && ctx.verifyPetInboxCapability);

    const verified = typeof verifyCapabilityFn === "function" && verifyCapabilityFn({
      profileId: remoteProfile.profileId,
      agentId: "pi",
      rawSessionId: data.rawSessionId,
      token: data.capabilityToken,
    });

    if (!verified) {
      sendJsonResponse(res, 403, { status: "rejected", reason: "invalid or expired capability token" });
      return;
    }

    const env = options.env || (ctx && ctx.env) || process.env;
    let settleUserMessageFn = null;
    let derivePetIdFn = null;

    if (typeof options.settleUserMessage === "function" || typeof options.derivePetId === "function") {
      if (typeof options.settleUserMessage === "function" && typeof options.derivePetId === "function") {
        settleUserMessageFn = options.settleUserMessage;
        derivePetIdFn = options.derivePetId;
      } else {
        sendJsonResponse(res, 503, { status: "failed", reason: "pet runtime not configured" });
        return;
      }
    } else if (ctx && (typeof ctx.settleUserMessage === "function" || typeof ctx.derivePetId === "function")) {
      if (typeof ctx.settleUserMessage === "function" && typeof ctx.derivePetId === "function") {
        settleUserMessageFn = ctx.settleUserMessage;
        derivePetIdFn = ctx.derivePetId;
      } else {
        sendJsonResponse(res, 503, { status: "failed", reason: "pet runtime not configured" });
        return;
      }
    } else {
      const loadRuntimeFn = options.loadRuntime
        || (ctx && ctx.loadRuntime)
        || loadRuntime;

      let runtimeModule = null;
      try {
        runtimeModule = loadRuntimeFn(env);
      } catch {
        sendJsonResponse(res, 503, { status: "failed", reason: "pet runtime not configured" });
        return;
      }

      if (
        !runtimeModule
        || typeof runtimeModule.settleUserMessage !== "function"
        || typeof runtimeModule.derivePetId !== "function"
      ) {
        sendJsonResponse(res, 503, { status: "failed", reason: "pet runtime not configured" });
        return;
      }

      settleUserMessageFn = runtimeModule.settleUserMessage;
      derivePetIdFn = runtimeModule.derivePetId;
    }

    try {
      const petId = derivePetIdFn({
        profileId: remoteProfile.profileId,
        agentId: "pi",
        rawSessionId: data.rawSessionId,
      });

      const receipt = await settleUserMessageFn({
        petId,
        profileId: remoteProfile.profileId,
        agentId: "pi",
        rawSessionId: data.rawSessionId,
        commandId: data.commandId,
        claimToken: data.claimToken,
        status: data.status,
        ...(data.reason !== undefined && data.reason !== null ? { reason: data.reason } : {}),
        ...(options.dataDir ? { dataDir: options.dataDir } : {}),
        ...(env ? { env } : {}),
      });

      if (!receipt || typeof receipt !== "object") {
        sendJsonResponse(res, 500, { status: "failed", reason: "invalid receipt from pet runtime" });
        return;
      }

      if (receipt.status === "dispatched" || receipt.status === "failed" || receipt.status === "expired") {
        sendJsonResponse(res, 200, receipt);
      } else if (receipt.status === "rejected") {
        sendJsonResponse(res, 422, receipt);
      } else {
        sendJsonResponse(res, 500, receipt.status ? receipt : { status: "failed", reason: receipt.reason || "unexpected receipt status" });
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

function handlePetInboxReceiptPost(req, res, options = {}) {
  const { ctx, remoteProfile = null } = options;

  if (remoteProfile) {
    sendJsonResponse(res, 403, { status: "rejected", reason: "remote receipt query is not allowed" });
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
    if (bodySize > MAX_PET_INBOX_BODY_BYTES) {
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

    const validation = validatePetInboxReceiptQueryPayload(data);
    if (!validation.ok) {
      sendJsonResponse(res, 400, { status: "rejected", reason: validation.reason });
      return;
    }

    const env = options.env || (ctx && ctx.env) || process.env;
    let getUserMessageReceiptFn = null;

    if (typeof options.getUserMessageReceipt === "function") {
      getUserMessageReceiptFn = options.getUserMessageReceipt;
    } else if (ctx && typeof ctx.getUserMessageReceipt === "function") {
      getUserMessageReceiptFn = ctx.getUserMessageReceipt;
    } else {
      const loadRuntimeFn = options.loadRuntime
        || (ctx && ctx.loadRuntime)
        || loadRuntime;

      let runtimeModule = null;
      try {
        runtimeModule = loadRuntimeFn(env);
      } catch {
        sendJsonResponse(res, 503, { status: "failed", reason: "pet runtime receipt query not available" });
        return;
      }

      if (!runtimeModule || typeof runtimeModule.getUserMessageReceipt !== "function") {
        sendJsonResponse(res, 503, { status: "failed", reason: "pet runtime receipt query not available" });
        return;
      }

      getUserMessageReceiptFn = runtimeModule.getUserMessageReceipt;
    }

    try {
      const receipt = await getUserMessageReceiptFn({
        petId: data.petId,
        commandId: data.commandId,
        ...(options.dataDir ? { dataDir: options.dataDir } : {}),
        ...(env ? { env } : {}),
      });

      if (!receipt || receipt.status === "not_found") {
        sendJsonResponse(res, 404, { status: "not_found" });
        return;
      }

      if (typeof receipt !== "object" || Array.isArray(receipt)) {
        sendJsonResponse(res, 500, { status: "failed", reason: "invalid receipt from pet runtime" });
        return;
      }

      sendJsonResponse(res, 200, receipt);
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
  MAX_PET_INBOX_BODY_BYTES,
  ALLOWED_SCHEMA_KEYS,
  CLAIM_ALLOWED_KEYS,
  SETTLE_ALLOWED_KEYS,
  RECEIPT_QUERY_ALLOWED_KEYS,
  VALID_SETTLE_STATUS_VALUES,
  isValidRawSessionId,
  timingSafeTokenMatch,
  createPetInboxCapabilityRegistry,
  validatePetInboxPayload,
  validatePetInboxClaimPayload,
  validatePetInboxSettlePayload,
  validatePetInboxReceiptQueryPayload,
  handlePetInboxPost,
  handlePetInboxClaimPost,
  handlePetInboxSettlePost,
  handlePetInboxReceiptPost,
};
