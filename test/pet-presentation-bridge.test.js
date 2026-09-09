"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const loader = require("../src/pet-presentation-bridge");
const {
  buildSessionSnapshot,
  sessionSnapshotSignature,
} = require("../src/state-session-snapshot");

const temporaryDirs = [];

afterEach(() => {
  while (temporaryDirs.length) fs.rmSync(temporaryDirs.pop(), { recursive: true, force: true });
});

function tempModule(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-loader-"));
  temporaryDirs.push(dir);
  const file = path.join(dir, "runtime.js");
  fs.writeFileSync(file, source, "utf8");
  return file;
}

describe("Pi Pet trusted-operator loader", () => {
  it("is inert when disabled, even with a throwing module and no parent repository", () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-disabled-"));
    temporaryDirs.push(isolated);
    const copiedShim = path.join(isolated, "pet-presentation-bridge.js");
    fs.copyFileSync(path.resolve(__dirname, "../src/pet-presentation-bridge.js"), copiedShim);
    const throwingModule = path.join(isolated, "must-not-load.js");
    fs.writeFileSync(throwingModule, "throw new Error('disabled loader loaded runtime');\n", "utf8");
    const result = spawnSync(process.execPath, ["-e", `
      process.chdir(${JSON.stringify(isolated)});
      const load = require(${JSON.stringify(copiedShim)});
      const bridge = load({ enabled: false, env: { CLAWD_PET_RUNTIME_MODULE: ${JSON.stringify(throwingModule)} } });
      if (bridge.enabled || bridge.onSnapshot().written !== 0) process.exit(2);
      console.log("disabled-ok");
    `], { encoding: "utf8" });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /disabled-ok/);
  });

  it("loads an enabled absolute module and passes bridge options to the stub", () => {
    const modulePath = tempModule(`
      module.exports = {
        API_CONTRACT_VERSION: "1",
        createClawdPresentationBridge(options) {
          return { enabled: options.enabled === true, marker: options.marker };
        },
      };
    `);
    const bridge = loader({
      enabled: true,
      marker: "stub-loaded",
      env: { CLAWD_PET_RUNTIME_MODULE: modulePath },
    });
    assert.deepStrictEqual(bridge, { enabled: true, marker: "stub-loaded" });
  });

  it("fails explicitly when enabled without a runtime module", () => {
    assert.throws(
      () => loader({ enabled: true, env: {} }),
      /CLAWD_PET_RUNTIME_MODULE is not set/
    );
  });

  it("fails explicitly for a missing absolute runtime module", () => {
    const missing = path.join(os.tmpdir(), `pi-pet-no-such-${process.pid}-${Date.now()}.js`);
    assert.throws(
      () => loader({ enabled: true, env: { CLAWD_PET_RUNTIME_MODULE: missing } }),
      new RegExp(`could not be loaded from ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  });

  it("fails explicitly when the enabled module has no factory", () => {
    const modulePath = tempModule(`module.exports = { API_CONTRACT_VERSION: "1" };`);
    assert.throws(
      () => loader({ enabled: true, env: { CLAWD_PET_RUNTIME_MODULE: modulePath } }),
      /createClawdPresentationBridge\(options\) is missing/
    );
  });

  it("restores Clawd toolName in snapshots and its signature", () => {
    const makeSnapshot = (toolName) => buildSessionSnapshot(new Map([["pi:session-a", {
      agentId: "pi",
      state: "working",
      lastToolName: toolName,
      recentEvents: [{ event: "PreToolUse", state: "working", at: 1 }],
    }]]));
    const editSnapshot = makeSnapshot("edit");
    const bashSnapshot = makeSnapshot("bash");
    assert.strictEqual(editSnapshot.sessions[0].toolName, "edit");
    assert.notStrictEqual(sessionSnapshotSignature(editSnapshot), sessionSnapshotSignature(bashSnapshot));
  });

  it("fails explicitly for an incompatible contract version", () => {
    const modulePath = tempModule(`
      module.exports = { API_CONTRACT_VERSION: "99", createClawdPresentationBridge() {} };
    `);
    assert.throws(
      () => loader({ enabled: true, env: { CLAWD_PET_RUNTIME_MODULE: modulePath } }),
      /incompatible API contract 99; expected 1/
    );
  });

  it("requires an absolute path rather than silently resolving a legacy copy", () => {
    assert.throws(
      () => loader({ enabled: true, env: { CLAWD_PET_RUNTIME_MODULE: "../packages/runtime" } }),
      /must be absolute/
    );
  });

  it("applies the native-pet hide flag only when both env flags are truthy", () => {
    const truthy = ["1", "true", "yes"];
    const falsey = [undefined, "", "0", "false", "no"];
    for (const bridge of truthy) {
      for (const hide of truthy) {
        assert.strictEqual(loader.shouldHideNativePetFromEnv({ CLAWD_PET_BRIDGE: bridge, CLAWD_PET_BRIDGE_HIDE_NATIVE_PET: hide }), true);
      }
      for (const hide of falsey) {
        assert.strictEqual(loader.shouldHideNativePetFromEnv({ CLAWD_PET_BRIDGE: bridge, CLAWD_PET_BRIDGE_HIDE_NATIVE_PET: hide }), false);
      }
    }
    for (const bridge of falsey) {
      assert.strictEqual(loader.shouldHideNativePetFromEnv({ CLAWD_PET_BRIDGE: bridge, CLAWD_PET_BRIDGE_HIDE_NATIVE_PET: "1" }), false);
    }
  });

  it("keeps the Pi default while allowing an explicit harness allowlist", () => {
    assert.deepStrictEqual(loader.agentIdsFromEnv({}), ["pi"]);
    assert.deepStrictEqual(loader.agentIdsFromEnv({ CLAWD_PET_BRIDGE_AGENT_IDS: "pi, codex" }), ["pi", "codex"]);
    assert.deepStrictEqual(loader.agentIdsFromEnv({ CLAWD_PET_BRIDGE_AGENT_IDS: " , " }), ["pi"]);
  });
});
