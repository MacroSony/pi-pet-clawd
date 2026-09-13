"use strict";

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");
const { isValidSessionProfileId } = require("./session-key");
const { loadRuntime } = require("./pet-presentation-bridge");

const MAX_PET_CHAT_BODY_BYTES = 16 * 1024; // 16 KiB
const MAX_CHAT_RESPONSE_BYTES = 64 * 1024; // 64 KiB
const MAX_ASSISTANT_TEXT_BYTES = 8192; // 8 KiB (8192 UTF-8 bytes)
const DISALLOWED_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

const ALLOWED_READ_KEYS = Object.freeze(new Set([
  "schemaVersion",
  "kind",
  "petId",
]));

const ALLOWED_CLEAR_KEYS = Object.freeze(new Set([
  "schemaVersion",
  "kind",
  "petId",
]));

const ALLOWED_COMPLETE_KEYS = Object.freeze(new Set([
  "schemaVersion",
  "kind",
  "rawSessionId",
  "capabilityToken",
  "commandId",
  "assistantText",
]));

function sendJsonResponse(res, statusCode, payload) {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") > MAX_CHAT_RESPONSE_BYTES) {
    const errorBody = JSON.stringify({
      status: "failed",
      reason: "Response payload exceeds 64 KiB",
    });
    res.writeHead(500, {
      "Content-Type": "application/json; charset=utf-8",
      [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
    });
    res.end(errorBody);
    return;
  }
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
  });
  res.end(json);
}

function isValidPetId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    return false;
  }
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) && !value.includes("..");
}

function isValidCommandId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    return false;
  }
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

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
  if (value === "default" || value === "pi:" || value === "pi:default") {
    return false;
  }
  return true;
}

function validatePetChatReadPayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "Payload must be an object" };
  }
  for (const key of Object.keys(data)) {
    if (!ALLOWED_READ_KEYS.has(key)) return { ok: false, reason: `Unknown property: "${key}"` };
  }
  if (data.schemaVersion !== "1") return { ok: false, reason: "schemaVersion must be '1'" };
  if (data.kind !== "pet_chat_read") return { ok: false, reason: "kind must be 'pet_chat_read'" };
  if (!isValidPetId(data.petId)) {
    return { ok: false, reason: "petId must be a valid identifier between 1 and 128 characters" };
  }
  return { ok: true };
}

function validatePetChatClearPayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "Payload must be an object" };
  }
  for (const key of Object.keys(data)) {
    if (!ALLOWED_CLEAR_KEYS.has(key)) return { ok: false, reason: `Unknown property: "${key}"` };
  }
  if (data.schemaVersion !== "1") return { ok: false, reason: "schemaVersion must be '1'" };
  if (data.kind !== "pet_chat_clear") return { ok: false, reason: "kind must be 'pet_chat_clear'" };
  if (!isValidPetId(data.petId)) {
    return { ok: false, reason: "petId must be a valid identifier between 1 and 128 characters" };
  }
  return { ok: true };
}

function validatePetChatCompletePayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "Payload must be an object" };
  }
  for (const key of Object.keys(data)) {
    if (!ALLOWED_COMPLETE_KEYS.has(key)) return { ok: false, reason: `Unknown property: "${key}"` };
  }
  if (data.schemaVersion !== "1") return { ok: false, reason: "schemaVersion must be '1'" };
  if (data.kind !== "pet_chat_complete") return { ok: false, reason: "kind must be 'pet_chat_complete'" };
  if (!isValidRawSessionId(data.rawSessionId)) {
    return { ok: false, reason: "rawSessionId must be a non-empty string up to 4096 characters without null, newline, or carriage return characters, and cannot be a default placeholder" };
  }
  if (typeof data.capabilityToken !== "string" || !/^[0-9a-f]{64}$/.test(data.capabilityToken)) {
    return { ok: false, reason: "capabilityToken must be a 64-character lowercase hex string" };
  }
  if (!isValidCommandId(data.commandId)) {
    return { ok: false, reason: "commandId must be a valid identifier between 1 and 64 characters" };
  }
  if (typeof data.assistantText !== "string") {
    return { ok: false, reason: "assistantText must be a string" };
  }
  if (Buffer.byteLength(data.assistantText, "utf8") > MAX_ASSISTANT_TEXT_BYTES) {
    return { ok: false, reason: `assistantText exceeds maximum byte size of ${MAX_ASSISTANT_TEXT_BYTES} bytes` };
  }
  if (DISALLOWED_CONTROL_RE.test(data.assistantText)) {
    return { ok: false, reason: "assistantText contains disallowed control characters" };
  }
  return { ok: true };
}

function buildSanitizedChatProjection(chat) {
  if (!chat || typeof chat !== "object" || Array.isArray(chat)) {
    return { revision: 0, messages: [], pending: false };
  }
  const revision = typeof chat.revision === "number" && Number.isSafeInteger(chat.revision) && chat.revision >= 0
    ? chat.revision
    : 0;
  const turns = Array.isArray(chat.turns) ? chat.turns : [];
  const messages = [];

  for (const turn of turns) {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) continue;
    if (typeof turn.userText === "string") {
      const createdAtMs = typeof turn.createdAtMs === "number" && Number.isSafeInteger(turn.createdAtMs) && turn.createdAtMs >= 0
        ? turn.createdAtMs
        : 0;
      messages.push({
        role: "user",
        text: turn.userText,
        createdAtMs,
      });
    }
    if (turn.assistantText !== null && turn.assistantText !== undefined && typeof turn.assistantText === "string") {
      const createdAtMs = typeof turn.completedAtMs === "number" && Number.isSafeInteger(turn.completedAtMs) && turn.completedAtMs >= 0
        ? turn.completedAtMs
        : (typeof turn.createdAtMs === "number" && Number.isSafeInteger(turn.createdAtMs) && turn.createdAtMs >= 0 ? turn.createdAtMs : 0);
      messages.push({
        role: "assistant",
        text: turn.assistantText,
        createdAtMs,
      });
    }
  }

  const pending = turns.some((turn) => (
    turn && typeof turn === "object"
    && (turn.assistantText === null || turn.assistantText === undefined)
  ));

  return {
    revision,
    messages,
    pending,
  };
}

function resolvePetChatStore(options = {}) {
  const { ctx, petChatStore, chatStore, env } = options;
  const direct = petChatStore || chatStore || (ctx && (ctx.petChatStore || ctx.chatStore));
  if (
    direct
    && (typeof direct.readChat === "function"
      || typeof direct.completeTurn === "function"
      || typeof direct.recordUserMessage === "function"
      || typeof direct.clearChat === "function")
  ) {
    return direct;
  }
  if (typeof options.createPetChatStore === "function") {
    return options.createPetChatStore(options);
  }
  if (ctx && typeof ctx.createPetChatStore === "function") {
    return ctx.createPetChatStore(options);
  }
  try {
    const loadRuntimeFn = options.loadRuntime || (ctx && ctx.loadRuntime) || loadRuntime;
    const runtimeEnv = env || (ctx && ctx.env) || process.env;
    const runtime = loadRuntimeFn(runtimeEnv);
    if (runtime && typeof runtime.createPetChatStore === "function") {
      const dataDir = options.dataDir || (ctx && ctx.dataDir);
      return runtime.createPetChatStore({
        env: runtimeEnv,
        ...(dataDir ? { dataDir } : {}),
      });
    }
  } catch {}
  return null;
}

function resolveDerivePetId(options = {}) {
  const { ctx, derivePetId, env } = options;
  if (typeof derivePetId === "function") return derivePetId;
  if (ctx && typeof ctx.derivePetId === "function") return ctx.derivePetId;
  try {
    const loadRuntimeFn = options.loadRuntime || (ctx && ctx.loadRuntime) || loadRuntime;
    const runtimeEnv = env || (ctx && ctx.env) || process.env;
    const runtime = loadRuntimeFn(runtimeEnv);
    if (runtime && typeof runtime.derivePetId === "function") return runtime.derivePetId;
  } catch {}
  return null;
}

function resolvePetPeerCapabilityRegistry(options = {}) {
  const { ctx, peerCapabilityRegistry, petPeerCapabilityRegistry } = options;
  if (peerCapabilityRegistry && typeof peerCapabilityRegistry.verifyCapability === "function") {
    return peerCapabilityRegistry;
  }
  if (petPeerCapabilityRegistry && typeof petPeerCapabilityRegistry.verifyCapability === "function") {
    return petPeerCapabilityRegistry;
  }
  if (ctx) {
    if (ctx.peerCapabilityRegistry && typeof ctx.peerCapabilityRegistry.verifyCapability === "function") {
      return ctx.peerCapabilityRegistry;
    }
    if (ctx.petPeerCapabilityRegistry && typeof ctx.petPeerCapabilityRegistry.verifyCapability === "function") {
      return ctx.petPeerCapabilityRegistry;
    }
  }
  return null;
}

function readJsonBody(req, res, validateFn, onParsed) {
  const chunks = [];
  let bodySize = 0;
  let tooLarge = false;

  req.on("data", (chunk) => {
    if (tooLarge) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : (typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    bodySize += buf.length;
    if (bodySize > MAX_PET_CHAT_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      return;
    }
    chunks.push(buf);
  });

  req.on("end", async () => {
    if (tooLarge) {
      sendJsonResponse(res, 413, { status: "rejected", reason: "Payload too large" });
      return;
    }

    let data;
    try {
      const raw = Buffer.concat(chunks).toString("utf8");
      data = JSON.parse(raw);
    } catch {
      sendJsonResponse(res, 400, { status: "rejected", reason: "Malformed JSON" });
      return;
    }

    const validation = validateFn(data);
    if (!validation.ok) {
      sendJsonResponse(res, 400, { status: "rejected", reason: validation.reason });
      return;
    }

    try {
      await onParsed(data);
    } catch (err) {
      sendJsonResponse(res, 500, {
        status: "failed",
        reason: (err && err.message) || "Internal server error",
      });
    }
  });

  req.on("error", (err) => {
    try {
      sendJsonResponse(res, 500, { status: "failed", reason: (err && err.message) || "Request stream error" });
    } catch {}
  });
}

function handlePetChatReadPost(req, res, options = {}) {
  const { remoteProfile = null } = options;
  if (remoteProfile) {
    sendJsonResponse(res, 403, { status: "rejected", reason: "Remote chat read is not allowed" });
    return;
  }

  readJsonBody(req, res, validatePetChatReadPayload, async (data) => {
    const store = resolvePetChatStore(options);
    if (!store || typeof store.readChat !== "function") {
      sendJsonResponse(res, 503, { status: "failed", reason: "Pet runtime chat store unavailable" });
      return;
    }

    let result = store.readChat({ petId: data.petId });
    if (result && typeof result.then === "function") {
      result = await result;
    }

    if (!result || result.ok === false) {
      if (result && result.error === "invalid_pet_id") {
        sendJsonResponse(res, 400, {
          schemaVersion: "1",
          kind: "pet_chat_read",
          status: "rejected",
          reason: result.reason || "Invalid petId",
        });
        return;
      }
      sendJsonResponse(res, 500, {
        schemaVersion: "1",
        kind: "pet_chat_read",
        status: "failed",
        reason: (result && result.reason) || "Chat read failed",
      });
      return;
    }

    const chatData = result.chat || result;
    const projectedChat = buildSanitizedChatProjection(chatData);

    sendJsonResponse(res, 200, {
      schemaVersion: "1",
      kind: "pet_chat_read",
      status: "ok",
      chat: projectedChat,
    });
  });
}

function handlePetChatClearPost(req, res, options = {}) {
  const { remoteProfile = null } = options;
  if (remoteProfile) {
    sendJsonResponse(res, 403, { status: "rejected", reason: "Remote chat clear is not allowed" });
    return;
  }

  readJsonBody(req, res, validatePetChatClearPayload, async (data) => {
    const store = resolvePetChatStore(options);
    if (!store || typeof store.clearChat !== "function") {
      sendJsonResponse(res, 503, { status: "failed", reason: "Pet runtime chat store unavailable" });
      return;
    }

    let result = store.clearChat({ petId: data.petId });
    if (result && typeof result.then === "function") {
      result = await result;
    }

    if (!result || result.ok === false) {
      if (result && result.error === "invalid_pet_id") {
        sendJsonResponse(res, 400, {
          schemaVersion: "1",
          kind: "pet_chat_clear",
          status: "rejected",
          reason: result.reason || "Invalid petId",
        });
        return;
      }
      sendJsonResponse(res, 500, {
        schemaVersion: "1",
        kind: "pet_chat_clear",
        status: "failed",
        reason: (result && result.reason) || "Chat clear failed",
      });
      return;
    }

    const revision = (result.chat && typeof result.chat.revision === "number") ? result.chat.revision : 0;

    sendJsonResponse(res, 200, {
      schemaVersion: "1",
      kind: "pet_chat_clear",
      status: "ok",
      chat: {
        revision,
        messages: [],
        pending: false,
      },
    });
  });
}

function handlePetChatCompletePost(req, res, options = {}) {
  const { remoteProfile = null } = options;
  const profileId = (remoteProfile && remoteProfile.profileId) ? remoteProfile.profileId : "local";
  if (!isValidSessionProfileId(profileId)) {
    sendJsonResponse(res, 403, {
      schemaVersion: "1",
      kind: "pet_chat_complete",
      status: "rejected",
      reason: "Invalid profile identity",
    });
    return;
  }

  readJsonBody(req, res, validatePetChatCompletePayload, async (data) => {
    const registry = resolvePetPeerCapabilityRegistry(options);
    if (!registry || typeof registry.verifyCapability !== "function") {
      sendJsonResponse(res, 503, {
        schemaVersion: "1",
        kind: "pet_chat_complete",
        status: "failed",
        reason: "Capability registry unavailable",
      });
      return;
    }

    const verified = registry.verifyCapability({
      profileId,
      agentId: "pi",
      rawSessionId: data.rawSessionId,
      token: data.capabilityToken,
    });

    if (!verified) {
      sendJsonResponse(res, 403, {
        schemaVersion: "1",
        kind: "pet_chat_complete",
        status: "rejected",
        reason: "Invalid or expired capability token",
      });
      return;
    }

    const derivePetId = resolveDerivePetId(options);
    if (typeof derivePetId !== "function") {
      sendJsonResponse(res, 503, {
        schemaVersion: "1",
        kind: "pet_chat_complete",
        status: "failed",
        reason: "derivePetId function unavailable",
      });
      return;
    }

    const callerPetId = derivePetId({
      profileId,
      agentId: "pi",
      rawSessionId: data.rawSessionId,
    });

    if (!isValidPetId(callerPetId)) {
      sendJsonResponse(res, 500, {
        schemaVersion: "1",
        kind: "pet_chat_complete",
        status: "failed",
        reason: "Derived invalid petId",
      });
      return;
    }

    const store = resolvePetChatStore(options);
    if (!store || typeof store.completeTurn !== "function") {
      sendJsonResponse(res, 503, {
        schemaVersion: "1",
        kind: "pet_chat_complete",
        status: "failed",
        reason: "Pet runtime chat store unavailable",
      });
      return;
    }

    let result = store.completeTurn({
      petId: callerPetId,
      commandId: data.commandId,
      assistantText: data.assistantText,
    });
    if (result && typeof result.then === "function") {
      result = await result;
    }

    if (!result || result.ok === false) {
      if (result && result.error === "turn_not_found") {
        sendJsonResponse(res, 404, {
          schemaVersion: "1",
          kind: "pet_chat_complete",
          status: "rejected",
          reason: result.reason || "Turn not found",
        });
        return;
      }
      if (result && result.error === "conflict") {
        sendJsonResponse(res, 409, {
          schemaVersion: "1",
          kind: "pet_chat_complete",
          status: "rejected",
          reason: result.reason || "Turn conflict",
        });
        return;
      }
      sendJsonResponse(res, 500, {
        schemaVersion: "1",
        kind: "pet_chat_complete",
        status: "failed",
        reason: (result && result.reason) || "Complete turn failed",
      });
      return;
    }

    sendJsonResponse(res, 200, {
      schemaVersion: "1",
      kind: "pet_chat_complete",
      status: "ok",
    });
  });
}

module.exports = {
  MAX_PET_CHAT_BODY_BYTES,
  MAX_CHAT_RESPONSE_BYTES,
  MAX_ASSISTANT_TEXT_BYTES,
  DISALLOWED_CONTROL_RE,
  validatePetChatReadPayload,
  validatePetChatClearPayload,
  validatePetChatCompletePayload,
  buildSanitizedChatProjection,
  resolvePetChatStore,
  handlePetChatReadPost,
  handlePetChatClearPost,
  handlePetChatCompletePost,
};
