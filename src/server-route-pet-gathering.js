"use strict";

const { CLAWD_SERVER_HEADER, CLAWD_SERVER_ID } = require("../hooks/server-config");
const { loadRuntime } = require("./pet-presentation-bridge");
const { resolveTeamStore, resolveDerivePetId } = require("./server-route-pet-team");
const { isInactiveState } = require("./server-route-pet-peer");

const MAX_GATHERING_BODY_BYTES = 16 * 1024;
const scenes = new WeakMap();

function reply(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
  res.end(JSON.stringify(payload));
}
function sessionsFrom(options) {
  const getter = options.getSessionSnapshot || (options.ctx && options.ctx.getSessionSnapshot);
  if (typeof getter !== "function") throw new Error("snapshot_unavailable");
  const snapshot = getter();
  if (Array.isArray(snapshot)) return snapshot;
  if (snapshot && Array.isArray(snapshot.sessions)) return snapshot.sessions;
  if (snapshot instanceof Map) return [...snapshot.values()];
  throw new Error("snapshot_unavailable");
}
function makeResolveTeam(options, runtime) {
  if (typeof options.resolveTeam === "function") return options.resolveTeam;
  const store = resolveTeamStore(options);
  const derivePetId = resolveDerivePetId(options) || runtime.derivePetId;
  if (!store || typeof store.listTeamsForPet !== "function" || typeof derivePetId !== "function") throw new Error("team_unavailable");
  return (petId) => {
    const teams = store.listTeamsForPet({ petId });
    if (!Array.isArray(teams)) throw new Error("team_unavailable");
    const active = teams.filter((team) => team && team.status === "active");
    if (active.length !== 1) return null;
    const team = active[0];
    if (!Array.isArray(team.members)) throw new Error("team_unavailable");
    const members = team.members.map((member) => member && member.petId);
    if (!members.every((member) => typeof member === "string")) throw new Error("team_unavailable");
    // A missing/failed snapshot is not an empty desktop. This keeps eligibility
    // authoritative rather than accidentally cancelling everyone on a read error.
    const sessions = sessionsFrom(options);
    const eligible = new Set();
    for (const session of sessions) {
      if (!session || typeof session !== "object" || session.agentId !== "pi" || session.headless === true
        || session.startupRecovered === true || session.hiddenFromHud === true || isInactiveState(session.state)) continue;
      const rawSessionId = session.rawSessionId || session.id;
      if (typeof rawSessionId !== "string" || !rawSessionId) continue;
      const profileId = typeof session.profileId === "string" && session.profileId.trim() ? session.profileId : "local";
      let candidate;
      try { candidate = derivePetId({ profileId, agentId: "pi", rawSessionId }); } catch { continue; }
      if (members.includes(candidate)) eligible.add(candidate);
    }
    return { teamId: team.teamId, members, eligible: members.filter((member) => eligible.has(member)) };
  };
}
function resolveAreaStore(options, runtime) {
  if (options.activityAreaStore && typeof options.activityAreaStore.read === "function") return options.activityAreaStore;
  const ctx = options.ctx || {};
  if (ctx.activityAreaStore && typeof ctx.activityAreaStore.read === "function") return ctx.activityAreaStore;
  const env = options.env || ctx.env || process.env;
  return runtime.createActivityAreaStore({ env, ...(ctx.dataDir ? { dataDir: ctx.dataDir } : {}) });
}
function resolveScene(options) {
  if (options.scene) return options.scene;
  const ctx = options.ctx;
  if (ctx && typeof ctx === "object" && scenes.has(ctx)) return scenes.get(ctx);
  const env = options.env || (ctx && ctx.env) || process.env;
  const runtime = loadRuntime(env);
  if (!runtime || typeof runtime.createGatheringScene !== "function") throw new Error("runtime_unavailable");
  const scene = runtime.createGatheringScene({
    readArea: () => resolveAreaStore(options, runtime).read(),
    resolveTeam: makeResolveTeam(options, runtime),
    now: typeof options.now === "function" ? options.now : undefined,
  });
  if (ctx && typeof ctx === "object") scenes.set(ctx, scene);
  return scene;
}
function readBody(req, res, done) {
  const chunks = [];
  let bytes = 0;
  let ended = false;
  const fail = (code, reason) => { if (!ended) { ended = true; reply(res, code, { status: "rejected", reason }); } };
  req.on("data", (chunk) => {
    if (ended) return;
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_GATHERING_BODY_BYTES) { chunks.length = 0; fail(413, "payload too large"); } else chunks.push(value);
  });
  req.on("error", () => fail(400, "request read failed"));
  req.on("end", () => {
    if (ended) return;
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail(400, "bad json"); return; }
    done(data);
  });
}
function rejectionCode(action, reason) {
  if (reason === "stale_seq" || reason === "other_team_active") return 409;
  // Start conflicts are intentionally limited to actual active-scene collisions;
  // stale/offline/area failures are malformed-or-no-longer-valid local attempts.
  return 400;
}
function handlePetGatheringPost(req, res, options = {}) {
  const address = req.socket && req.socket.remoteAddress;
  if (options.remoteProfile || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)
    || req.headers.origin || req.headers["sec-fetch-site"] || req.headers["x-clawd-routing-nonce"]) {
    reply(res, 403, { status: "rejected", reason: "Gathering requires a local native client" });
    return;
  }
  if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") {
    reply(res, 415, { status: "rejected", reason: "JSON required" });
    return;
  }
  const match = /^\/pet-gathering\/(report|start|end)$/.exec(req.url || "");
  if (!match) { reply(res, 404, { status: "rejected", reason: "not found" }); return; }
  readBody(req, res, (data) => {
    let coordinator;
    try { coordinator = resolveScene(options); } catch { reply(res, 503, { status: "failed", reason: "Gathering coordinator unavailable" }); return; }
    let result;
    try { result = coordinator[match[1]](data); } catch { reply(res, 503, { status: "failed", reason: "Gathering coordinator unavailable" }); return; }
    if (!result || result.status === "rejected") {
      reply(res, rejectionCode(match[1], result && result.reason), result || { status: "rejected", reason: "invalid request" });
      return;
    }
    reply(res, 200, result);
  });
}

module.exports = { MAX_GATHERING_BODY_BYTES, handlePetGatheringPost, resolveScene, makeResolveTeam };
