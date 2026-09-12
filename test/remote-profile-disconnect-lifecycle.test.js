"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

test("production Remote SSH status wiring fails closed for every non-connected profile", () => {
  const listenerStart = mainSource.indexOf('_remoteSshRuntime.on("status-changed"');
  const ipcStart = mainSource.indexOf("const _remoteSshIpc = registerRemoteSshIpc", listenerStart);
  assert.ok(listenerStart >= 0, "main.js must subscribe directly to Remote SSH runtime status changes");
  assert.ok(ipcStart > listenerStart, "disconnect lifecycle wiring must exist before renderer IPC wiring");

  const listener = mainSource.slice(listenerStart, ipcStart);
  assert.match(listener, /profileId\s*===\s*"local"/);
  assert.match(listener, /snapshot\.status\s*===\s*"connected"/);
  assert.match(listener, /_server\.deactivatePetProfile\(profileId\)/);
  assert.match(listener, /_state\.clearSessionsByProfile\(profileId\)/);
  assert.ok(
    listener.indexOf("deactivatePetProfile") < listener.indexOf("clearSessionsByProfile"),
    "messaging authority must be revoked before stale sessions disappear from presentation",
  );
});
