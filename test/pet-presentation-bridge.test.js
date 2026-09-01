"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createPetPresentationBridge = require("../src/pet-presentation-bridge");
const {
  buildSessionSnapshot,
  sessionSnapshotSignature,
} = require("../src/state-session-snapshot");
const {
  presentationState,
  stablePetSessionId,
  toStatusPayload,
} = createPetPresentationBridge;

const temporaryDirs = [];

afterEach(() => {
  while (temporaryDirs.length) {
    fs.rmSync(temporaryDirs.pop(), { recursive: true, force: true });
  }
});

function makeSession(overrides = {}) {
  return {
    id: "pi:session-a",
    rawSessionId: "session-a",
    profileId: "local",
    agentId: "pi",
    agentName: "Pi",
    state: "working",
    toolName: "edit",
    displayFolder: "pi-pet",
    sourceDisplayLabel: "",
    updatedAt: Date.UTC(2026, 8, 1),
    headless: false,
    lastEvent: { rawEvent: "PreToolUse", at: Date.UTC(2026, 8, 1) },
    ...overrides,
  };
}

describe("pet presentation bridge", () => {
  it("maps Clawd working sessions using the normalized tool name", () => {
    const payload = toStatusPayload(makeSession());

    assert.strictEqual(payload.state, "editing");
    assert.strictEqual(payload.detail, "Editing pi-pet");
    assert.strictEqual(payload.tool, "edit");
    assert.strictEqual(payload.session_name, "Pi / pi-pet");
    assert.match(payload.session_id, /^pet_[a-f0-9]{24}$/);
  });

  it("exports toolName to the session snapshot and includes it in change detection", () => {
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

  it("uses profile identity so remote and local session IDs never collide", () => {
    const local = stablePetSessionId(makeSession({ profileId: "local" }));
    const remote = stablePetSessionId(makeSession({ profileId: "homelab" }));

    assert.notStrictEqual(local, remote);
  });

  it("treats an authoritative SessionEnd as closed", () => {
    const session = makeSession({
      state: "sleeping",
      lastEvent: { rawEvent: "SessionEnd", at: Date.UTC(2026, 8, 1) },
    });

    assert.strictEqual(presentationState(session), "closed");
    assert.strictEqual(toStatusPayload(session).detail, "Session ended");
  });

  it("writes one file and launches exactly one renderer for a live Pi session", () => {
    const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-pet-bridge-"));
    temporaryDirs.push(statusDir);
    const calls = [];
    const bridge = createPetPresentationBridge({
      enabled: true,
      statusDir,
      rendererBinary: "/opt/claude-status-pet",
      assetsDir: "/opt/pet-assets",
      spawn: (binary, args, options) => {
        calls.push({ binary, args, options });
        return { unref() {}, once() {} };
      },
    });
    const session = makeSession();

    assert.deepStrictEqual(bridge.onSnapshot({ sessions: [session] }), { written: 1, launched: 1 });
    assert.deepStrictEqual(bridge.onSnapshot({ sessions: [session] }), { written: 1, launched: 0 });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].binary, "/opt/claude-status-pet");
    assert.deepStrictEqual(calls[0].args.slice(0, 1), ["run"]);
    assert.ok(calls[0].args.includes("--status-file"));
    assert.ok(calls[0].args.includes("--session-id"));
    assert.ok(calls[0].args.includes("--assets-dir"));

    const petId = stablePetSessionId(session);
    const payload = JSON.parse(fs.readFileSync(path.join(statusDir, `status-${petId}.json`), "utf8"));
    assert.strictEqual(payload.state, "editing");
    assert.strictEqual(payload.session_id, petId);
  });

  it("closes a previously projected session once it drops out of Clawd's snapshot", () => {
    const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-pet-bridge-"));
    temporaryDirs.push(statusDir);
    const bridge = createPetPresentationBridge({ enabled: true, statusDir });
    const session = makeSession();
    const petId = stablePetSessionId(session);

    bridge.onSnapshot({ sessions: [session] });
    bridge.onSnapshot({ sessions: [] });

    const payload = JSON.parse(fs.readFileSync(path.join(statusDir, `status-${petId}.json`), "utf8"));
    assert.strictEqual(payload.state, "closed");
    assert.strictEqual(payload.event, "SessionEnd");
  });
});
