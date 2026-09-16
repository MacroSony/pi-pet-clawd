"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { handlePetActivityAreaPost } = require("../src/server-route-pet-activity-area");
const { createIngressRequestHandler } = require("../src/remote-ssh-ingress");
const initServer = require("../src/server");
const { createActivityAreaStore } = require("../../packages/runtime");
const area = { monitor: { name: "Display", workArea: { x: -1920, y: 0, width: 1920, height: 1040 }, scaleFactor: 1.5 }, rect: { x: -1000, y: 400, width: 800, height: 400 } };
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return async (endpoint, data, headers = {}) => {
    const result = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: typeof data === "string" ? data : JSON.stringify(data),
    });
    const text = await result.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { code: result.status, header: result.headers.get("x-clawd-server"), body };
  };
}
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-area-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store: createActivityAreaStore({ dataDir }) };
}
test("production server route resolves configured runtime and roundtrips one shared desktop setting", async (t) => {
  const { dataDir } = fixture(t);
  let handler;
  const coordinator = initServer({
    dataDir, env: { CLAWD_PET_RUNTIME_MODULE: path.resolve(__dirname, "../../packages/runtime") },
    createHttpServer(h) { handler = h; const s = new EventEmitter(); s.listen = () => s.emit("listening"); s.close = () => {}; return s; },
    setImmediate() {}, getPortCandidates: () => [23334], readRuntimePort: () => 23334,
    readRuntimeIdentity: () => null, clearRuntimeConfig() {}, writeRuntimeConfig: () => true,
    isAgentEnabled: () => false,
  });
  t.after(() => coordinator.cleanup());
  await coordinator.startHttpServer();
  const post = await serve(t, handler);
  const empty = await post("/pet-activity-area/read", { schemaVersion: "1" });
  assert.equal(empty.code, 200); assert.equal(empty.header, "clawd-on-desk");
  assert.equal(empty.body.area, null);
  const updated = await post("/pet-activity-area/write", { schemaVersion: "1", baseRevision: 0, area });
  assert.equal(updated.code, 200); assert.equal(updated.body.revision, 1);
  assert.deepEqual(createActivityAreaStore({ dataDir }).read().area, area);
  const stale = await post("/pet-activity-area/write", { schemaVersion: "1", baseRevision: 0, area: null });
  assert.equal(stale.code, 409);
  const read = await post("/pet-activity-area/read", { schemaVersion: "1" });
  assert.deepEqual(read.body.area, area);
  const disabled = await post("/pet-activity-area/write", { schemaVersion: "1", baseRevision: 1, area: null });
  assert.equal(disabled.body.area, null); assert.equal(disabled.body.revision, 2);
});
test("native-local only: rejects browser origins, fetch metadata, remote context and nonce", async (t) => {
  const { store } = fixture(t);
  const post = await serve(t, (req,res) => handlePetActivityAreaPost(req,res,{ activityAreaStore: store }));
  for (const headers of [{ origin: "https://untrusted.example" }, { origin: "null" }, { "sec-fetch-site": "same-origin" }, { "x-clawd-routing-nonce": "a".repeat(32) }]) {
    assert.equal((await post("/pet-activity-area/write", { schemaVersion: "1", baseRevision: 0, area }, headers)).code, 403);
  }
  const remote = await serve(t, (req,res) => handlePetActivityAreaPost(req,res,{ activityAreaStore: store, remoteProfile: { profileId: "remote" } }));
  assert.equal((await remote("/pet-activity-area/read", { schemaVersion: "1" })).code, 403);
  assert.equal(store.read().revision, 0);
});
test("malformed/oversized/extra properties and invalid geometry do not mutate", async (t) => {
  const { store } = fixture(t);
  const post = await serve(t, (req,res) => handlePetActivityAreaPost(req,res,{ activityAreaStore: store }));
  for (const body of ["{", {}, { schemaVersion: "1", baseRevision: 0, area, token: "no" }, { schemaVersion: "1", baseRevision: 0, area: { ...area, rect: { ...area.rect, x: 0 } } }]) {
    assert.equal((await post("/pet-activity-area/write", body)).code, 400);
  }
  assert.equal((await post("/pet-activity-area/write", " ".repeat(4097))).code, 413);
  assert.equal((await post("/pet-activity-area/read", { schemaVersion: "1" }, { "content-type": "text/plain" })).code, 415);
  assert.equal(store.read().revision, 0);
});
test("authenticated SSH ingress still cannot route activity-area settings", async (t) => {
  let called = false;
  const handler = createIngressRequestHandler({ remoteProfile: { profileId: "test" },
    getAcceptedNonces: () => ["a".repeat(32)], routeRequest: () => { called = true; },
  });
  const post = await serve(t, handler);
  for (const endpoint of ["/pet-activity-area/read", "/pet-activity-area/write"]) {
    const result = await post(endpoint, { schemaVersion: "1" }, { "x-clawd-routing-nonce": "a".repeat(32) });
    assert.notEqual(result.code, 200);
  }
  assert.equal(called, false);
});
test("store errors do not disclose filesystem paths", async (t) => {
  const post = await serve(t, (req,res) => handlePetActivityAreaPost(req,res,{ activityAreaStore: { read() { throw new Error("/private/secret/path"); } } }));
  const result = await post("/pet-activity-area/read", { schemaVersion: "1" });
  assert.equal(result.code, 503); assert.doesNotMatch(JSON.stringify(result.body), /private|secret/);
});
