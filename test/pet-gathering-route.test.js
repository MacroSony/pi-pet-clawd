"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { handlePetGatheringPost } = require("../src/server-route-pet-gathering");
const initServer = require("../src/server");

const monitor = { name: "Main", workArea: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 };
function body(petId, instanceId, seq) { return { schemaVersion: "1", petId, instanceId, seq, controlEpoch: 0, rect: { x: 1, y: 1, width: 80, height: 80 }, scaleFactor: 1, monitors: [monitor], blocked: false, cancelSceneId: null, outcome: null }; }
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return async (url, data, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof data === "string" ? data : JSON.stringify(data) });
    return { code: res.status, body: await res.json() };
  };
}
function activeTeam() {
  const record = { teamId: "team_a", status: "active", members: [{ petId: "p1" }, { petId: "p2" }] };
  return { createTeam() {}, listTeamsForPet({ petId }) { return ["p1", "p2"].includes(petId) ? [record] : []; } };
}
test("production routes share one local coordinator and expose only caller target", async (t) => {
  // The injected activity store keeps this wiring test ephemeral.
  let saved = { schemaVersion: "1", revision: 1, area: { monitor, rect: { x: 0, y: 0, width: 500, height: 300 } } };
  const areaStore = { read: () => saved };
  let handler;
  const ctx = { activityAreaStore: areaStore, teamStore: activeTeam(), derivePetId: ({ rawSessionId }) => rawSessionId,
    getSessionSnapshot: () => ({ sessions: [{ rawSessionId: "p1", agentId: "pi", state: "running" }, { rawSessionId: "p2", agentId: "pi", state: "running" }] }),
    env: { CLAWD_PET_RUNTIME_MODULE: path.resolve(__dirname, "../../packages/runtime") },
    createHttpServer(h) { handler = h; const server = new EventEmitter(); server.listen = () => server.emit("listening"); server.close = () => {}; return server; }, setImmediate() {}, getPortCandidates: () => [23335], readRuntimePort: () => 23335, readRuntimeIdentity: () => null, clearRuntimeConfig() {}, writeRuntimeConfig: () => true, isAgentEnabled: () => false };
  const coordinator = initServer(ctx); t.after(() => coordinator.cleanup()); await coordinator.startHttpServer();
  const post = await serve(t, handler);
  assert.equal((await post("/pet-gathering/report", body("p1", "one", 0))).body.scene, null);
  await post("/pet-gathering/report", body("p2", "two", 0));
  assert.deepEqual((await post("/pet-gathering/start", { schemaVersion: "1", petId: "p1", instanceId: "one" })).body, { status: "started", participants: 2 });
  const moving = await post("/pet-gathering/report", body("p1", "one", 1));
  assert.equal(moving.code, 200); assert.ok(moving.body.scene.sceneId); assert.doesNotMatch(JSON.stringify(moving.body), /p2/);
  assert.equal((await post("/pet-gathering/report", body("p1", "one", 1))).code, 409);
  assert.equal((await post("/pet-gathering/end", { schemaVersion: "1", petId: "p1", instanceId: "one" })).body.status, "ended");
  saved = { ...saved, revision: 2 };
});
test("route is native-loopback only and bounds malformed input", async (t) => {
  const scene = { report: () => ({ status: "ok", scene: null }), start: () => ({ status: "started", participants: 1 }), end: () => ({ status: "ended" }) };
  const post = await serve(t, (req, res) => handlePetGatheringPost(req, res, { scene }));
  assert.equal((await post("/pet-gathering/report", body("p1", "one", 0), { origin: "https://bad.test" })).code, 403);
  assert.equal((await post("/pet-gathering/report", body("p1", "one", 0), { "sec-fetch-site": "same-origin" })).code, 403);
  assert.equal((await post("/pet-gathering/report", "{")).code, 400);
  assert.equal((await post("/pet-gathering/report", " ".repeat(16 * 1024 + 1))).code, 413);
  assert.equal((await post("/pet-gathering/report", body("p1", "one", 0), { "content-type": "text/plain" })).code, 415);
});
