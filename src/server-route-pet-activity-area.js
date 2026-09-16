"use strict";

const { CLAWD_SERVER_HEADER, CLAWD_SERVER_ID } = require("../hooks/server-config");
const { loadRuntime } = require("./pet-presentation-bridge");

// Local desktop settings only. Do not add this route to Remote SSH ingress.
function handlePetActivityAreaPost(req, res, options = {}) {
  let ended = false;
  function respond(code, payload) {
    if (ended) return;
    ended = true;
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
    res.end(JSON.stringify(payload));
  }
  const address = req.socket && req.socket.remoteAddress;
  if (options.remoteProfile || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)
    || req.headers.origin || req.headers["sec-fetch-site"] || req.headers["x-clawd-routing-nonce"]) {
    respond(403, { status: "rejected", reason: "Activity area settings require a local native client" });
    return;
  }
  if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") {
    respond(415, { status: "rejected", reason: "JSON required" });
    return;
  }
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    if (ended) return;
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096) {
      chunks.length = 0;
      respond(413, { status: "rejected", reason: "Activity area request too large" });
    } else chunks.push(bytes);
  });
  req.on("error", () => respond(400, { status: "rejected", reason: "Request read failed" }));
  req.on("end", () => {
    if (ended) return;
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
      respond(400, { status: "rejected", reason: "Invalid JSON" }); return;
    }
    const writing = req.url === "/pet-activity-area/write";
    const keys = writing ? ["schemaVersion", "baseRevision", "area"] : ["schemaVersion"];
    if (!data || Array.isArray(data) || typeof data !== "object" || data.schemaVersion !== "1"
      || Object.keys(data).length !== keys.length || !keys.every((k) => Object.hasOwn(data, k))) {
      respond(400, { status: "rejected", reason: "Invalid activity area request" }); return;
    }
    let store;
    try {
      const ctx = options.ctx || {};
      store = options.activityAreaStore || ctx.activityAreaStore;
      if (!store) {
        const env = ctx.env || process.env;
        store = loadRuntime(env).createActivityAreaStore({ env, ...(ctx.dataDir ? { dataDir: ctx.dataDir } : {}) });
      }
    } catch {
      respond(503, { status: "failed", reason: "Activity area store unavailable" }); return;
    }
    try {
      const result = writing ? store.write({ baseRevision: data.baseRevision, area: data.area }) : { status: "ready", ...store.read() };
      respond(result.status === "conflict" ? 409 : 200, result);
    } catch (err) {
      const invalid = err.code === "invalid_activity_area";
      respond(invalid ? 400 : 503, {
        status: invalid ? "rejected" : "failed",
        reason: invalid ? "Invalid activity area geometry" : "Activity area could not be read or saved",
      });
    }
  });
}
module.exports = { handlePetActivityAreaPost };
