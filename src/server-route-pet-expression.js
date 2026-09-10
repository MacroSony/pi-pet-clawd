"use strict";

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");
const { loadRuntime } = require("./pet-presentation-bridge");

const MAX_PET_EXPRESSION_BODY_BYTES = 16 * 1024; // 16 KiB
const VALID_EMOTIONS = new Set(["happy", "shy", "shocked", "sad", "celebrate"]);
const ALLOWED_SCHEMA_KEYS = new Set([
  "schemaVersion",
  "kind",
  "rawSessionId",
  "agentId",
  "text",
  "emotion",
  "dedupKey",
  "ttlMs",
  "createdAtMs",
]);

function validatePetExpressionPayload(data) {
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

  if (data.kind !== "pet_expression") {
    return { ok: false, reason: "kind must be 'pet_expression'" };
  }

  if (typeof data.rawSessionId !== "string" || data.rawSessionId.length < 1 || data.rawSessionId.length > 4096) {
    return { ok: false, reason: "rawSessionId must be a string between 1 and 4096 characters" };
  }

  if (data.agentId !== undefined) {
    if (typeof data.agentId !== "string" || data.agentId.length < 1 || data.agentId.length > 256) {
      return { ok: false, reason: "agentId must be a string between 1 and 256 characters" };
    }
  }

  if (data.text === undefined && data.emotion === undefined) {
    return { ok: false, reason: "At least one of text or emotion is required" };
  }

  if (data.text !== undefined) {
    if (typeof data.text !== "string" || data.text.length < 1 || data.text.length > 2000) {
      return { ok: false, reason: "text must be a string between 1 and 2000 characters" };
    }
  }

  if (data.emotion !== undefined) {
    if (typeof data.emotion !== "string" || !VALID_EMOTIONS.has(data.emotion)) {
      return { ok: false, reason: `emotion must be one of: ${Array.from(VALID_EMOTIONS).join(", ")}` };
    }
  }

  if (data.dedupKey !== undefined) {
    if (typeof data.dedupKey !== "string" || data.dedupKey.length < 1 || data.dedupKey.length > 64) {
      return { ok: false, reason: "dedupKey must be a string between 1 and 64 characters" };
    }
  }

  if (data.ttlMs !== undefined) {
    if (typeof data.ttlMs !== "number" || !Number.isInteger(data.ttlMs) || data.ttlMs < 1000 || data.ttlMs > 300000) {
      return { ok: false, reason: "ttlMs must be an integer between 1000 and 300000" };
    }
  }

  if (data.createdAtMs !== undefined) {
    if (typeof data.createdAtMs !== "number" || !Number.isFinite(data.createdAtMs)) {
      return { ok: false, reason: "createdAtMs must be a number" };
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

function handlePetExpressionPost(req, res, options = {}) {
  let body = "";
  let bodySize = 0;
  let tooLarge = false;

  req.on("data", (chunk) => {
    if (tooLarge) return;
    bodySize += chunk.length;
    if (bodySize > MAX_PET_EXPRESSION_BODY_BYTES) {
      tooLarge = true;
      return;
    }
    body += chunk;
  });

  req.on("end", () => {
    if (tooLarge) {
      sendJsonResponse(res, 413, { status: "rejected", reason: "payload too large" });
      return;
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      sendJsonResponse(res, 400, { status: "rejected", reason: "bad json" });
      return;
    }

    const validation = validatePetExpressionPayload(data);
    if (!validation.ok) {
      sendJsonResponse(res, 400, { status: "rejected", reason: validation.reason });
      return;
    }

    const { ctx, remoteProfile = null } = options;
    const profileId = (remoteProfile && typeof remoteProfile.profileId === "string" && remoteProfile.profileId)
      ? remoteProfile.profileId
      : "local";
    const agentId = (data.agentId !== undefined && typeof data.agentId === "string" && data.agentId)
      ? data.agentId
      : "pi";

    let expressExpressionFn = null;
    if (typeof options.expressExpression === "function") {
      expressExpressionFn = options.expressExpression;
    } else if (ctx && typeof ctx.expressExpression === "function") {
      expressExpressionFn = ctx.expressExpression;
    } else {
      const loadRuntimeFn = options.loadRuntime
        || (ctx && ctx.loadRuntime)
        || loadRuntime;
      const env = options.env || (ctx && ctx.env) || process.env;

      let runtimeModule = null;
      try {
        runtimeModule = loadRuntimeFn(env);
      } catch {
        sendJsonResponse(res, 503, { status: "failed", reason: "pet runtime not configured" });
        return;
      }

      if (!runtimeModule || typeof runtimeModule.expressExpression !== "function") {
        sendJsonResponse(res, 503, { status: "failed", reason: "pet runtime not configured" });
        return;
      }

      expressExpressionFn = runtimeModule.expressExpression;
    }

    try {
      const receipt = expressExpressionFn({
        profileId,
        agentId,
        rawSessionId: data.rawSessionId,
        ...(data.text !== undefined ? { text: data.text } : {}),
        ...(data.emotion !== undefined ? { emotion: data.emotion } : {}),
        ...(data.dedupKey !== undefined ? { dedupKey: data.dedupKey } : {}),
        ...(data.ttlMs !== undefined ? { ttlMs: data.ttlMs } : {}),
        ...(data.createdAtMs !== undefined ? { createdAtMs: data.createdAtMs } : {}),
        ...(options.dataDir ? { dataDir: options.dataDir } : {}),
      });

      if (!receipt || typeof receipt !== "object") {
        sendJsonResponse(res, 500, { status: "failed", reason: "invalid receipt from pet runtime" });
        return;
      }

      if (receipt.status === "delivered") {
        sendJsonResponse(res, 200, receipt);
      } else if (receipt.status === "rejected" || receipt.status === "expired") {
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

module.exports = {
  MAX_PET_EXPRESSION_BODY_BYTES,
  VALID_EMOTIONS,
  validatePetExpressionPayload,
  handlePetExpressionPost,
};
