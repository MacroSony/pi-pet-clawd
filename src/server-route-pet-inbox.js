"use strict";

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");
const { loadRuntime } = require("./pet-presentation-bridge");

const MAX_PET_INBOX_BODY_BYTES = 16 * 1024; // 16 KiB
const ALLOWED_SCHEMA_KEYS = new Set([
  "schemaVersion",
  "kind",
  "petId",
  "text",
  "deliverAs",
  "commandId",
  "dedupKey",
  "ttlMs",
]);

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

module.exports = {
  MAX_PET_INBOX_BODY_BYTES,
  ALLOWED_SCHEMA_KEYS,
  validatePetInboxPayload,
  handlePetInboxPost,
};
