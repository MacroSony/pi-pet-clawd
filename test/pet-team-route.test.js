"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { Readable } = require("node:stream");

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  ROUTING_NONCE_HEADER,
} = require("../hooks/server-config");
const {
  createPetPeerCapabilityRegistry,
  createPetPeerHandleStore,
} = require("../src/server-route-pet-peer");
const {
  handlePetTeamStatusPost,
  handlePetTeamCreatePost,
  handlePetTeamDissolvePost,
  handlePetTeamBoardReadPost,
  handlePetTeamBoardWritePost,
  validatePetTeamStatusPayload,
  validatePetTeamCreatePayload,
  validatePetTeamDissolvePayload,
  validatePetTeamBoardReadPayload,
  validatePetTeamBoardWritePayload,
  resolveTeamBoardStore,
  buildSanitizedBoardProjection,
} = require("../src/server-route-pet-team");
const initServer = require("../src/server");
const { createIngressRequestHandler } = require("../src/remote-ssh-ingress");

const rootRuntime = require(path.resolve(__dirname, "../../packages/runtime"));
const { createTeamStore, createTeamBoardStore, derivePetId } = rootRuntime;

process.env.CLAWD_PET_RUNTIME_MODULE = path.resolve(__dirname, "../../packages/runtime");

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function createMockReq({ method = "POST", url = "/pet-team/status", headers = {}, body = "" } = {}) {
  const payloadBuffer = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  const stream = Readable.from([payloadBuffer]);
  stream.method = method;
  stream.url = url;
  stream.headers = { ...headers };
  return stream;
}

function createMockRes() {
  const result = {
    statusCode: null,
    headers: {},
    body: "",
  };
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(statusCode, headers = {}) {
      result.statusCode = statusCode;
      result.headers = headers;
      res.headersSent = true;
    },
    end(chunk = "") {
      result.body += (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      res.writableEnded = true;
      if (res._resolve) res._resolve(result);
    },
  };
  result.done = new Promise((resolve) => {
    res._resolve = resolve;
  });
  return { res, result };
}

describe("Pet Team Route Payload Validations", () => {
  test("status payload validation enforces strict keys and schemaVersion", () => {
    const valid = {
      schemaVersion: "1",
      kind: "team_status",
      rawSessionId: "session-1",
      capabilityToken: generateToken(),
    };
    assert.equal(validatePetTeamStatusPayload(valid).ok, true);

    // Unknown property
    assert.equal(validatePetTeamStatusPayload({ ...valid, extra: "foo" }).ok, false);
    // Invalid schemaVersion
    assert.equal(validatePetTeamStatusPayload({ ...valid, schemaVersion: "2" }).ok, false);
    // Invalid kind
    assert.equal(validatePetTeamStatusPayload({ ...valid, kind: "unknown" }).ok, false);
    // Invalid rawSessionId (default/empty)
    assert.equal(validatePetTeamStatusPayload({ ...valid, rawSessionId: "default" }).ok, false);
    assert.equal(validatePetTeamStatusPayload({ ...valid, rawSessionId: "pi:default" }).ok, false);
    // Invalid capability token
    assert.equal(validatePetTeamStatusPayload({ ...valid, capabilityToken: "short" }).ok, false);
  });

  test("create payload validation enforces strict keys, name bounds and target limits", () => {
    const valid = {
      schemaVersion: "1",
      kind: "team_create",
      rawSessionId: "session-1",
      capabilityToken: generateToken(),
      name: "Alpha Squad",
      targets: ["psh_abc123"],
    };
    assert.equal(validatePetTeamCreatePayload(valid).ok, true);

    // Unknown property
    assert.equal(validatePetTeamCreatePayload({ ...valid, extra: 123 }).ok, false);
    // Bad name: empty or whitespace only
    assert.equal(validatePetTeamCreatePayload({ ...valid, name: "   " }).ok, false);
    // Bad name: control characters
    assert.equal(validatePetTeamCreatePayload({ ...valid, name: "Alpha\x00Squad" }).ok, false);
    // Bad name: > 80 code points
    assert.equal(validatePetTeamCreatePayload({ ...valid, name: "A".repeat(81) }).ok, false);
    // Targets < 1
    assert.equal(validatePetTeamCreatePayload({ ...valid, targets: [] }).ok, false);
    // Targets > 7
    assert.equal(validatePetTeamCreatePayload({ ...valid, targets: ["psh_1", "psh_2", "psh_3", "psh_4", "psh_5", "psh_6", "psh_7", "psh_8"] }).ok, false);
    // Invalid target handle format
    assert.equal(validatePetTeamCreatePayload({ ...valid, targets: ["invalid_handle"] }).ok, false);
    // Duplicate target handles
    assert.equal(validatePetTeamCreatePayload({ ...valid, targets: ["psh_same", "psh_same"] }).ok, false);
  });

  test("dissolve payload validation enforces strict keys and schemaVersion", () => {
    const valid = {
      schemaVersion: "1",
      kind: "team_dissolve",
      rawSessionId: "session-1",
      capabilityToken: generateToken(),
    };
    assert.equal(validatePetTeamDissolvePayload(valid).ok, true);

    // Unknown property
    assert.equal(validatePetTeamDissolvePayload({ ...valid, teamId: "team_1" }).ok, false);
    // Invalid kind
    assert.equal(validatePetTeamDissolvePayload({ ...valid, kind: "other" }).ok, false);
  });

  test("board read payload validation enforces strict keys and schemaVersion", () => {
    const valid = {
      schemaVersion: "1",
      kind: "team_board_read",
      rawSessionId: "session-1",
      capabilityToken: generateToken(),
    };
    assert.equal(validatePetTeamBoardReadPayload(valid).ok, true);

    // Unknown property
    assert.equal(validatePetTeamBoardReadPayload({ ...valid, extra: "foo" }).ok, false);
    assert.equal(validatePetTeamBoardReadPayload({ ...valid, teamId: "team_1" }).ok, false);
    // Invalid schemaVersion
    assert.equal(validatePetTeamBoardReadPayload({ ...valid, schemaVersion: "2" }).ok, false);
    // Invalid kind
    assert.equal(validatePetTeamBoardReadPayload({ ...valid, kind: "team_board_write" }).ok, false);
    // Invalid rawSessionId
    assert.equal(validatePetTeamBoardReadPayload({ ...valid, rawSessionId: "default" }).ok, false);
    assert.equal(validatePetTeamBoardReadPayload({ ...valid, rawSessionId: "pi:default" }).ok, false);
    assert.equal(validatePetTeamBoardReadPayload({ ...valid, rawSessionId: "" }).ok, false);
    // Invalid capability token
    assert.equal(validatePetTeamBoardReadPayload({ ...valid, capabilityToken: "invalid" }).ok, false);
  });

  test("board write payload validation enforces strict keys, non-negative baseRevision, and markdown control characters", () => {
    const valid = {
      schemaVersion: "1",
      kind: "team_board_write",
      rawSessionId: "session-1",
      capabilityToken: generateToken(),
      baseRevision: 0,
      markdown: "# Task\n- item 1\titem 2\r\n✨ Unicode OK",
    };
    assert.equal(validatePetTeamBoardWritePayload(valid).ok, true);

    // Unknown property
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, extra: "foo" }).ok, false);
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, teamId: "team_1" }).ok, false);
    // Invalid schemaVersion
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, schemaVersion: "2" }).ok, false);
    // Invalid kind
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, kind: "team_board_read" }).ok, false);
    // Invalid baseRevision
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, baseRevision: -1 }).ok, false);
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, baseRevision: 1.5 }).ok, false);
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, baseRevision: "0" }).ok, false);
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, baseRevision: NaN }).ok, false);
    // Invalid markdown type
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, markdown: 123 }).ok, false);
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, markdown: null }).ok, false);
    // Disallowed control characters (C0/C1 except LF/CR/TAB)
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, markdown: "Hello\x00World" }).ok, false);
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, markdown: "Hello\x08World" }).ok, false);
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, markdown: "Hello\x0BWorld" }).ok, false);
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, markdown: "Hello\x0CWorld" }).ok, false);
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, markdown: "Hello\x1BWorld" }).ok, false);
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, markdown: "Hello\x7FWorld" }).ok, false);
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, markdown: "Hello\x80World" }).ok, false);
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, markdown: "Hello\x9FWorld" }).ok, false);
    // Allowed control characters (LF, CR, TAB)
    assert.equal(validatePetTeamBoardWritePayload({ ...valid, markdown: "Line1\nLine2\rLine3\tTabbed" }).ok, true);
  });
});

describe("Pet Team Route Execution & Lifecycle", () => {
  let tmpDataDir;
  let teamStore;
  let registry;
  let handleStore;

  const callerRaw = "session-leader";
  const target1Raw = "session-member-1";
  const target2Raw = "session-member-2";

  let callerToken;
  let target1Token;
  let target2Token;

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-team-test-"));
    teamStore = createTeamStore({ env: { ...process.env, PI_PET_DATA_DIR: tmpDataDir } });
    registry = createPetPeerCapabilityRegistry();
    handleStore = createPetPeerHandleStore();

    callerToken = generateToken();
    target1Token = generateToken();
    target2Token = generateToken();

    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: callerRaw, token: callerToken });
    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: target1Raw, token: target1Token });
    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: target2Raw, token: target2Token });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {}
  });

  function getSessions() {
    return [
      {
        profileId: "local",
        agentId: "pi",
        rawSessionId: callerRaw,
        displayTitle: "Leader Pi",
        sourceDisplayLabel: "local",
        state: "running",
      },
      {
        profileId: "local",
        agentId: "pi",
        rawSessionId: target1Raw,
        displayTitle: "Worker One",
        sourceDisplayLabel: "local",
        state: "idle",
      },
      {
        profileId: "local",
        agentId: "pi",
        rawSessionId: target2Raw,
        displayTitle: "Worker Two",
        sourceDisplayLabel: "local",
        state: "sleeping", // inactive
      },
    ];
  }

  test("status returns none when caller has no active team", async () => {
    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-team/status",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "team_status",
        rawSessionId: callerRaw,
        capabilityToken: callerToken,
      }),
    });

    handlePetTeamStatusPost(req, res, {
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      teamStore,
      derivePetId,
      sessions: getSessions(),
    });

    await result.done;
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.schemaVersion, "1");
    assert.equal(body.kind, "team_status");
    assert.equal(body.status, "none");
    assert.equal(body.team, undefined);
  });

  test("create team happy path: resolves handles, creates team, returns sanitized projection", async () => {
    let presentationRefreshes = 0;
    // 1. Create a catalog handle for target1
    const callerGen = registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: callerRaw });
    const target1Gen = registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: target1Raw });
    const { handle: handle1 } = handleStore.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: callerRaw },
      callerGeneration: callerGen,
      target: { profileId: "local", agentId: "pi", rawSessionId: target1Raw, displayName: "Worker One", host: "local" },
      targetGeneration: target1Gen,
    });

    // 2. Call /pet-team/create
    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-team/create",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "team_create",
        rawSessionId: callerRaw,
        capabilityToken: callerToken,
        name: "Alpha Squad",
        targets: [handle1],
      }),
    });

    handlePetTeamCreatePost(req, res, {
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      teamStore,
      derivePetId,
      sessions: getSessions(),
      onTeamPresentationChanged: () => { presentationRefreshes += 1; },
    });

    await result.done;
    assert.equal(result.statusCode, 200);
    assert.equal(presentationRefreshes, 1);
    const body = JSON.parse(result.body);
    assert.equal(body.schemaVersion, "1");
    assert.equal(body.kind, "team_create");
    assert.equal(body.status, "active");
    assert.ok(body.team);
    assert.equal(body.team.name, "Alpha Squad");
    assert.equal(body.team.revision, 1);
    assert.equal(body.team.callerRole, "leader");
    assert.equal(body.team.members.length, 2);

    // Verify caller member
    const callerMember = body.team.members[0];
    assert.equal(callerMember.displayName, "Leader Pi · Pi");
    assert.equal(callerMember.role, "leader");
    assert.equal(callerMember.canMessage, false);
    assert.equal(callerMember.handle, undefined);

    // Verify target1 member
    const targetMember = body.team.members[1];
    assert.equal(targetMember.displayName, "Worker One · Pi");
    assert.equal(targetMember.role, "member");
    assert.equal(targetMember.canMessage, true);
    assert.ok(targetMember.handle.startsWith("psh_"));

    // Verify handle was consumed (cannot reuse handle1)
    const resolveAgain = handleStore.resolveAndConsumeHandle(handle1, {
      caller: { profileId: "local", agentId: "pi", rawSessionId: callerRaw },
      registry,
    });
    assert.equal(resolveAgain.ok, false);
    assert.equal(resolveAgain.reason, "not_found");

    // Strict no private data check
    const rawJson = result.body;
    assert.equal(rawJson.includes(callerToken), false);
    assert.equal(rawJson.includes(target1Token), false);
    assert.equal(rawJson.includes(callerRaw), false);
    assert.equal(rawJson.includes(target1Raw), false);

    const callerPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: callerRaw });
    const target1PetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: target1Raw });
    assert.equal(rawJson.includes(callerPetId), false);
    assert.equal(rawJson.includes(target1PetId), false);

    // Verify teamId and forbidden properties are not leaked
    const activeTeams = teamStore.listTeamsForPet({ petId: callerPetId });
    assert.equal(activeTeams.length, 1);
    const internalTeamId = activeTeams[0].teamId;
    assert.ok(internalTeamId.startsWith("team_"));
    assert.equal(rawJson.includes(internalTeamId), false);
    assert.equal(rawJson.includes('"teamId"'), false);
    assert.equal(rawJson.includes('"petId"'), false);
    assert.equal(rawJson.includes('"rawSessionId"'), false);
    assert.equal(rawJson.includes('"capabilityToken"'), false);
  });

  test("rejects team creation using a reply handle instead of a catalog handle", async () => {
    const callerGen = registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: callerRaw });
    const target1Gen = registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: target1Raw });

    const { handle: replyHandle } = handleStore.createReplyHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: callerRaw },
      callerGeneration: callerGen,
      target: { profileId: "local", agentId: "pi", rawSessionId: target1Raw, displayName: "Worker One", host: "local" },
      targetGeneration: target1Gen,
      threadId: "thr_reply_test",
    });

    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-team/create",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "team_create",
        rawSessionId: callerRaw,
        capabilityToken: callerToken,
        name: "Reply Squad",
        targets: [replyHandle],
      }),
    });

    handlePetTeamCreatePost(req, res, {
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      teamStore,
      derivePetId,
      sessions: getSessions(),
    });

    await result.done;
    assert.equal(result.statusCode, 400);
    const body = JSON.parse(result.body);
    assert.equal(body.schemaVersion, "1");
    assert.equal(body.kind, "team_create");
    assert.equal(body.status, "rejected");
    assert.ok(body.reason.includes("catalog"));

    // Wrong-purpose presentation must not burn a valid one-shot reply handle.
    const replyStillUsable = handleStore.resolveAndConsumeHandle(replyHandle, {
      caller: { profileId: "local", agentId: "pi", rawSessionId: callerRaw },
      registry,
    });
    assert.equal(replyStillUsable.ok, true);
    assert.equal(replyStillUsable.entry.type, "reply");
  });

  test("one active team maximum: rejects create if caller or target is already in a team", async () => {
    // 1. Create initial team with caller and target1
    const callerPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: callerRaw });
    const target1PetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: target1Raw });
    teamStore.createTeam({
      name: "Existing Team",
      leaderPetId: callerPetId,
      members: [{ petId: target1PetId, role: "member" }],
      actor: { kind: "user" },
    });

    // 2. Mint handle for target2
    const callerGen = registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: callerRaw });
    const target2Gen = registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: target2Raw });
    const { handle: handle2 } = handleStore.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: callerRaw },
      callerGeneration: callerGen,
      target: { profileId: "local", agentId: "pi", rawSessionId: target2Raw, displayName: "Worker Two", host: "local" },
      targetGeneration: target2Gen,
    });

    // 3. Caller tries to create another team -> 409
    const { res: res1, result: result1 } = createMockRes();
    const req1 = createMockReq({
      url: "/pet-team/create",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "team_create",
        rawSessionId: callerRaw,
        capabilityToken: callerToken,
        name: "Second Team",
        targets: [handle2],
      }),
    });

    handlePetTeamCreatePost(req1, res1, {
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      teamStore,
      derivePetId,
      sessions: getSessions(),
    });

    await result1.done;
    assert.equal(result1.statusCode, 409);
    const body1 = JSON.parse(result1.body);
    assert.equal(body1.status, "rejected");
    assert.ok(body1.reason.includes("Caller already belongs to an active team"));

    // 4. Another session tries to create team including target1 (who is already in team) -> 409
    const otherCallerRaw = "session-other";
    const otherToken = generateToken();
    registry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: otherCallerRaw, token: otherToken });
    const otherGen = registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: otherCallerRaw });
    const target1GenAgain = registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: target1Raw });

    const { handle: handleT1 } = handleStore.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: otherCallerRaw },
      callerGeneration: otherGen,
      target: { profileId: "local", agentId: "pi", rawSessionId: target1Raw, displayName: "Worker One", host: "local" },
      targetGeneration: target1GenAgain,
    });

    const { res: res2, result: result2 } = createMockRes();
    const req2 = createMockReq({
      url: "/pet-team/create",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "team_create",
        rawSessionId: otherCallerRaw,
        capabilityToken: otherToken,
        name: "Other Team",
        targets: [handleT1],
      }),
    });

    handlePetTeamCreatePost(req2, res2, {
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      teamStore,
      derivePetId,
      sessions: getSessions(),
    });

    await result2.done;
    assert.equal(result2.statusCode, 409);
    const body2 = JSON.parse(result2.body);
    assert.equal(body2.status, "rejected");
    assert.ok(body2.reason.includes("Target member already belongs to an active team"));
  });

  test("status returns active team with fresh handles for active teammates and generic projection for inactive", async () => {
    // 1. Create team with caller, target1 (active), and target2 (inactive/sleeping)
    const callerPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: callerRaw });
    const target1PetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: target1Raw });
    const target2PetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: target2Raw });

    teamStore.createTeam({
      name: "Trio Team",
      leaderPetId: callerPetId,
      members: [
        { petId: target1PetId, role: "member" },
        { petId: target2PetId, role: "member" },
      ],
      actor: { kind: "user" },
    });

    // 2. Query status
    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-team/status",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "team_status",
        rawSessionId: callerRaw,
        capabilityToken: callerToken,
      }),
    });

    handlePetTeamStatusPost(req, res, {
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      teamStore,
      derivePetId,
      sessions: getSessions(),
    });

    await result.done;
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.status, "active");
    assert.equal(body.team.name, "Trio Team");
    assert.equal(body.team.members.length, 3);

    // Member 0: caller
    assert.equal(body.team.members[0].role, "leader");
    assert.equal(body.team.members[0].canMessage, false);

    // Member 1: target1 (active) -> fresh handle
    assert.equal(body.team.members[1].role, "member");
    assert.equal(body.team.members[1].canMessage, true);
    assert.ok(body.team.members[1].handle.startsWith("psh_"));

    // Member 2: target2 (inactive/sleeping) -> generic projection, canMessage: false, no handle
    assert.equal(body.team.members[2].role, "member");
    assert.equal(body.team.members[2].canMessage, false);
    assert.equal(body.team.members[2].handle, undefined);
  });

  test("dissolve team happy path and leader-only requirement", async () => {
    const callerPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: callerRaw });
    const target1PetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: target1Raw });

    teamStore.createTeam({
      name: "Team to Dissolve",
      leaderPetId: callerPetId,
      members: [{ petId: target1PetId, role: "member" }],
      actor: { kind: "user" },
    });

    // 1. Non-leader (target1) tries to dissolve -> 403
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-team/dissolve",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_dissolve",
          rawSessionId: target1Raw,
          capabilityToken: target1Token,
        }),
      });

      handlePetTeamDissolvePost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        teamStore,
        derivePetId,
        sessions: getSessions(),
      });

      await result.done;
      assert.equal(result.statusCode, 403);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "rejected");
      assert.ok(body.reason.includes("Only the team leader can dissolve the team"));
    }

    // 2. Leader (caller) dissolves -> 200 dissolved
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-team/dissolve",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_dissolve",
          rawSessionId: callerRaw,
          capabilityToken: callerToken,
        }),
      });

      handlePetTeamDissolvePost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        teamStore,
        derivePetId,
        sessions: getSessions(),
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.equal(body.schemaVersion, "1");
      assert.equal(body.kind, "team_dissolve");
      assert.equal(body.status, "dissolved");
    }

    // 3. Query status after dissolve -> none
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-team/status",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_status",
          rawSessionId: callerRaw,
          capabilityToken: callerToken,
        }),
      });

      handlePetTeamStatusPost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        teamStore,
        derivePetId,
        sessions: getSessions(),
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "none");
    }

    // 4. Calling dissolve again when not in active team -> 404
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-team/dissolve",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_dissolve",
          rawSessionId: callerRaw,
          capabilityToken: callerToken,
        }),
      });

      handlePetTeamDissolvePost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        teamStore,
        derivePetId,
        sessions: getSessions(),
      });

      await result.done;
      assert.equal(result.statusCode, 404);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "rejected");
    }
  });

  test("rejects request larger than 16 KiB", async () => {
    const hugeBody = JSON.stringify({
      schemaVersion: "1",
      kind: "team_status",
      rawSessionId: callerRaw,
      capabilityToken: callerToken,
      padding: "X".repeat(20000),
    });

    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-team/status",
      body: hugeBody,
    });

    handlePetTeamStatusPost(req, res, {
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      teamStore,
      derivePetId,
    });

    await result.done;
    assert.equal(result.statusCode, 413);
  });

  test("board read returns status: none when caller has no active team", async () => {
    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-team/board/read",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "team_board_read",
        rawSessionId: callerRaw,
        capabilityToken: callerToken,
      }),
    });

    handlePetTeamBoardReadPost(req, res, {
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      teamStore,
      derivePetId,
      sessions: getSessions(),
    });

    await result.done;
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.schemaVersion, "1");
    assert.equal(body.kind, "team_board_read");
    assert.equal(body.status, "none");
    assert.equal(body.board, undefined);
  });

  test("board write returns 404 when caller has no active team", async () => {
    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-team/board/write",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "team_board_write",
        rawSessionId: callerRaw,
        capabilityToken: callerToken,
        baseRevision: 0,
        markdown: "# My Board",
      }),
    });

    handlePetTeamBoardWritePost(req, res, {
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      teamStore,
      derivePetId,
      sessions: getSessions(),
    });

    await result.done;
    assert.equal(result.statusCode, 404);
    const body = JSON.parse(result.body);
    assert.equal(body.schemaVersion, "1");
    assert.equal(body.kind, "team_board_write");
    assert.equal(body.status, "rejected");
  });

  test("board read on active team before any write returns rev0 and empty markdown", async () => {
    const callerPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: callerRaw });
    const target1PetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: target1Raw });

    teamStore.createTeam({
      name: "Board Team",
      leaderPetId: callerPetId,
      members: [{ petId: target1PetId, role: "member" }],
      actor: { kind: "user" },
    });

    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-team/board/read",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "team_board_read",
        rawSessionId: callerRaw,
        capabilityToken: callerToken,
      }),
    });

    handlePetTeamBoardReadPost(req, res, {
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      teamStore,
      derivePetId,
      sessions: getSessions(),
      env: { ...process.env, PI_PET_DATA_DIR: tmpDataDir },
    });

    await result.done;
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.schemaVersion, "1");
    assert.equal(body.kind, "team_board_read");
    assert.equal(body.status, "active");
    assert.deepEqual(body.board, {
      revision: 0,
      markdown: "",
    });
  });

  test("leader and member board writes update revision, project updatedBy, and support session fallback", async () => {
    let presentationRefreshes = 0;
    const callerPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: callerRaw });
    const target1PetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: target1Raw });

    teamStore.createTeam({
      name: "Collaboration Squad",
      leaderPetId: callerPetId,
      members: [{ petId: target1PetId, role: "member" }],
      actor: { kind: "user" },
    });

    // 1. Leader writes revision 0 -> becomes rev 1
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-team/board/write",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_board_write",
          rawSessionId: callerRaw,
          capabilityToken: callerToken,
          baseRevision: 0,
          markdown: "# Roadmap\n- [ ] Task 1\tInitial\r\n",
        }),
      });

      handlePetTeamBoardWritePost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        teamStore,
        derivePetId,
        sessions: getSessions(),
        env: { ...process.env, PI_PET_DATA_DIR: tmpDataDir },
        onTeamPresentationChanged: () => { presentationRefreshes += 1; },
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      assert.equal(presentationRefreshes, 1);
      const body = JSON.parse(result.body);
      assert.equal(body.schemaVersion, "1");
      assert.equal(body.kind, "team_board_write");
      assert.equal(body.status, "updated");
      assert.equal(body.board.revision, 1);
      assert.equal(body.board.markdown, "# Roadmap\n- [ ] Task 1\tInitial\r\n");
      assert.equal(typeof body.board.updatedAtMs, "number");
      assert.deepEqual(body.board.updatedBy, {
        displayName: "Leader Pi · Pi",
        role: "leader",
      });
    }

    // 2. Member (target1) writes revision 1 -> becomes rev 2
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-team/board/write",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_board_write",
          rawSessionId: target1Raw,
          capabilityToken: target1Token,
          baseRevision: 1,
          markdown: "# Roadmap\n- [x] Task 1 done",
        }),
      });

      handlePetTeamBoardWritePost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        teamStore,
        derivePetId,
        sessions: getSessions(),
        env: { ...process.env, PI_PET_DATA_DIR: tmpDataDir },
        onTeamPresentationChanged: () => { presentationRefreshes += 1; },
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      assert.equal(presentationRefreshes, 2);
      const body = JSON.parse(result.body);
      assert.equal(body.schemaVersion, "1");
      assert.equal(body.kind, "team_board_write");
      assert.equal(body.status, "updated");
      assert.equal(body.board.revision, 2);
      assert.equal(body.board.markdown, "# Roadmap\n- [x] Task 1 done");
      assert.equal(typeof body.board.updatedAtMs, "number");
      assert.deepEqual(body.board.updatedBy, {
        displayName: "Worker One · Pi",
        role: "member",
      });
    }

    // 3. Leader reads board at revision 2
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-team/board/read",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_board_read",
          rawSessionId: callerRaw,
          capabilityToken: callerToken,
        }),
      });

      handlePetTeamBoardReadPost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        teamStore,
        derivePetId,
        sessions: getSessions(),
        env: { ...process.env, PI_PET_DATA_DIR: tmpDataDir },
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.equal(body.schemaVersion, "1");
      assert.equal(body.kind, "team_board_read");
      assert.equal(body.status, "active");
      assert.equal(body.board.revision, 2);
      assert.equal(body.board.markdown, "# Roadmap\n- [x] Task 1 done");
      assert.deepEqual(body.board.updatedBy, {
        displayName: "Worker One · Pi",
        role: "member",
      });
    }

    // 4. Fallback displayName when session snapshot has no matching session
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-team/board/read",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_board_read",
          rawSessionId: callerRaw,
          capabilityToken: callerToken,
        }),
      });

      handlePetTeamBoardReadPost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        teamStore,
        derivePetId,
        sessions: [], // empty sessions
        env: { ...process.env, PI_PET_DATA_DIR: tmpDataDir },
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.deepEqual(body.board.updatedBy, {
        displayName: "Team member",
        role: "member",
      });
    }
  });

  test("observer member cannot write to board (403) but can read board (200)", async () => {
    const callerPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: callerRaw });
    const target1PetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: target1Raw });

    teamStore.createTeam({
      name: "Audited Team",
      leaderPetId: callerPetId,
      members: [{ petId: target1PetId, role: "observer" }],
      actor: { kind: "user" },
    });

    // Observer can read
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-team/board/read",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_board_read",
          rawSessionId: target1Raw,
          capabilityToken: target1Token,
        }),
      });

      handlePetTeamBoardReadPost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        teamStore,
        derivePetId,
        sessions: getSessions(),
        env: { ...process.env, PI_PET_DATA_DIR: tmpDataDir },
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "active");
      assert.equal(body.board.revision, 0);
    }

    // Observer write is rejected with 403
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-team/board/write",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_board_write",
          rawSessionId: target1Raw,
          capabilityToken: target1Token,
          baseRevision: 0,
          markdown: "# Observer edit",
        }),
      });

      handlePetTeamBoardWritePost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        teamStore,
        derivePetId,
        sessions: getSessions(),
        env: { ...process.env, PI_PET_DATA_DIR: tmpDataDir },
      });

      await result.done;
      assert.equal(result.statusCode, 403);
      const body = JSON.parse(result.body);
      assert.equal(body.schemaVersion, "1");
      assert.equal(body.kind, "team_board_write");
      assert.equal(body.status, "rejected");
      assert.ok(body.reason.includes("Observer"));
    }
  });

  test("OCC revision mismatch returns 409 and currentRevision", async () => {
    const callerPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: callerRaw });
    const target1PetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: target1Raw });

    teamStore.createTeam({
      name: "OCC Squad",
      leaderPetId: callerPetId,
      members: [{ petId: target1PetId, role: "member" }],
      actor: { kind: "user" },
    });

    // 1. Advance to rev 1
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-team/board/write",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_board_write",
          rawSessionId: callerRaw,
          capabilityToken: callerToken,
          baseRevision: 0,
          markdown: "Rev 1",
        }),
      });

      handlePetTeamBoardWritePost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        teamStore,
        derivePetId,
        sessions: getSessions(),
        env: { ...process.env, PI_PET_DATA_DIR: tmpDataDir },
      });

      await result.done;
      assert.equal(result.statusCode, 200);
    }

    // 2. Member tries to write with stale baseRevision 0
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-team/board/write",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_board_write",
          rawSessionId: target1Raw,
          capabilityToken: target1Token,
          baseRevision: 0,
          markdown: "Stale write",
        }),
      });

      handlePetTeamBoardWritePost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        teamStore,
        derivePetId,
        sessions: getSessions(),
        env: { ...process.env, PI_PET_DATA_DIR: tmpDataDir },
      });

      await result.done;
      assert.equal(result.statusCode, 409);
      const body = JSON.parse(result.body);
      assert.equal(body.schemaVersion, "1");
      assert.equal(body.kind, "team_board_write");
      assert.equal(body.status, "conflict");
      assert.equal(body.currentRevision, 1);
      assert.ok(body.reason.includes("Revision mismatch"));
    }
  });

  test("oversized markdown (> 8192 UTF-8 bytes) returns 413", async () => {
    const callerPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: callerRaw });
    const target1PetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: target1Raw });

    teamStore.createTeam({
      name: "Size Test Squad",
      leaderPetId: callerPetId,
      members: [{ petId: target1PetId, role: "member" }],
      actor: { kind: "user" },
    });

    // 8193 bytes ASCII
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-team/board/write",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_board_write",
          rawSessionId: callerRaw,
          capabilityToken: callerToken,
          baseRevision: 0,
          markdown: "A".repeat(8193),
        }),
      });

      handlePetTeamBoardWritePost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        teamStore,
        derivePetId,
        sessions: getSessions(),
        env: { ...process.env, PI_PET_DATA_DIR: tmpDataDir },
      });

      await result.done;
      assert.equal(result.statusCode, 413);
      const body = JSON.parse(result.body);
      assert.equal(body.schemaVersion, "1");
      assert.equal(body.kind, "team_board_write");
      assert.equal(body.status, "rejected");
      assert.ok(body.reason.includes("8192"));
    }

    // Multibyte emojis exceeding 8192 bytes (2731 * 3 = 8193 bytes)
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-team/board/write",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_board_write",
          rawSessionId: callerRaw,
          capabilityToken: callerToken,
          baseRevision: 0,
          markdown: "✨".repeat(2731),
        }),
      });

      handlePetTeamBoardWritePost(req, res, {
        peerCapabilityRegistry: registry,
        peerHandleStore: handleStore,
        teamStore,
        derivePetId,
        sessions: getSessions(),
        env: { ...process.env, PI_PET_DATA_DIR: tmpDataDir },
      });

      await result.done;
      assert.equal(result.statusCode, 413);
      const body = JSON.parse(result.body);
      assert.equal(body.schemaVersion, "1");
      assert.equal(body.kind, "team_board_write");
      assert.equal(body.status, "rejected");
    }
  });

  test("board projection never leaks teamId, petId, rawSessionId, capabilityToken, or file paths", async () => {
    const callerPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: callerRaw });
    const target1PetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: target1Raw });

    const createResult = teamStore.createTeam({
      name: "Leak Test Squad",
      leaderPetId: callerPetId,
      members: [{ petId: target1PetId, role: "member" }],
      actor: { kind: "user" },
    });
    const internalTeamId = createResult.team.teamId;

    // 1. Write
    const { res: writeRes, result: writeResult } = createMockRes();
    const writeReq = createMockReq({
      url: "/pet-team/board/write",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "team_board_write",
        rawSessionId: callerRaw,
        capabilityToken: callerToken,
        baseRevision: 0,
        markdown: "Hello Secret Free World",
      }),
    });

    handlePetTeamBoardWritePost(writeReq, writeRes, {
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      teamStore,
      derivePetId,
      sessions: getSessions(),
      env: { ...process.env, PI_PET_DATA_DIR: tmpDataDir },
    });

    await writeResult.done;
    assert.equal(writeResult.statusCode, 200);
    const writeBody = writeResult.body;
    assert.equal(writeBody.includes(internalTeamId), false);
    assert.equal(writeBody.includes(callerPetId), false);
    assert.equal(writeBody.includes(target1PetId), false);
    assert.equal(writeBody.includes(callerRaw), false);
    assert.equal(writeBody.includes(callerToken), false);
    assert.equal(writeBody.includes(tmpDataDir), false);

    // 2. Read
    const { res: readRes, result: readResult } = createMockRes();
    const readReq = createMockReq({
      url: "/pet-team/board/read",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "team_board_read",
        rawSessionId: callerRaw,
        capabilityToken: callerToken,
      }),
    });

    handlePetTeamBoardReadPost(readReq, readRes, {
      peerCapabilityRegistry: registry,
      peerHandleStore: handleStore,
      teamStore,
      derivePetId,
      sessions: getSessions(),
      env: { ...process.env, PI_PET_DATA_DIR: tmpDataDir },
    });

    await readResult.done;
    assert.equal(readResult.statusCode, 200);
    const readBody = readResult.body;
    assert.equal(readBody.includes(internalTeamId), false);
    assert.equal(readBody.includes(callerPetId), false);
    assert.equal(readBody.includes(target1PetId), false);
    assert.equal(readBody.includes(callerRaw), false);
    assert.equal(readBody.includes(callerToken), false);
    assert.equal(readBody.includes(tmpDataDir), false);
  });

  test("injectable and lazy store resolution", async () => {
    const callerPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: callerRaw });
    const target1PetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: target1Raw });

    teamStore.createTeam({
      name: "Store Resolution Squad",
      leaderPetId: callerPetId,
      members: [{ petId: target1PetId, role: "member" }],
      actor: { kind: "user" },
    });

    // 1. Explicit mock teamBoardStore in options
    let customReadCalled = false;
    const mockBoardStore = {
      readBoard: () => {
        customReadCalled = true;
        return {
          ok: true,
          board: {
            schemaVersion: "1",
            teamId: "mock_team",
            revision: 42,
            markdown: "Custom Mock Markdown",
            updatedAtMs: 12345678,
            updatedByPetId: callerPetId,
          },
        };
      },
      writeBoard: () => ({ ok: true, board: { schemaVersion: "1", teamId: "mock", revision: 1, markdown: "ok" } }),
    };

    const { res: res1, result: result1 } = createMockRes();
    handlePetTeamBoardReadPost(
      createMockReq({
        url: "/pet-team/board/read",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_board_read",
          rawSessionId: callerRaw,
          capabilityToken: callerToken,
        }),
      }),
      res1,
      {
        peerCapabilityRegistry: registry,
        teamStore,
        derivePetId,
        teamBoardStore: mockBoardStore,
      }
    );

    await result1.done;
    assert.equal(result1.statusCode, 200);
    assert.equal(customReadCalled, true);
    const body1 = JSON.parse(result1.body);
    assert.equal(body1.board.revision, 42);
    assert.equal(body1.board.markdown, "Custom Mock Markdown");

    // 2. Injected via ctx.teamBoardStore
    let ctxReadCalled = false;
    const ctxMockBoardStore = {
      readBoard: () => {
        ctxReadCalled = true;
        return {
          ok: true,
          board: {
            schemaVersion: "1",
            teamId: "ctx_team",
            revision: 99,
            markdown: "Ctx Markdown",
          },
        };
      },
      writeBoard: () => ({ ok: true }),
    };

    const { res: res2, result: result2 } = createMockRes();
    handlePetTeamBoardReadPost(
      createMockReq({
        url: "/pet-team/board/read",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_board_read",
          rawSessionId: callerRaw,
          capabilityToken: callerToken,
        }),
      }),
      res2,
      {
        ctx: {
          peerCapabilityRegistry: registry,
          teamStore,
          derivePetId,
          teamBoardStore: ctxMockBoardStore,
        },
      }
    );

    await result2.done;
    assert.equal(result2.statusCode, 200);
    assert.equal(ctxReadCalled, true);
    const body2 = JSON.parse(result2.body);
    assert.equal(body2.board.revision, 99);

    // 3. Production-style lazy resolution uses a complete explicit env.
    const lazyStore = resolveTeamBoardStore({
      teamStore,
      env: { ...process.env, PI_PET_DATA_DIR: tmpDataDir },
    });
    assert.equal(typeof lazyStore.readBoard, "function");
    assert.equal(typeof lazyStore.writeBoard, "function");

    // 4. An explicitly injected partial env remains an isolation boundary;
    // it must not inherit the runtime module path from process.env.
    const isolatedStore = resolveTeamBoardStore({
      teamStore,
      env: { PI_PET_DATA_DIR: tmpDataDir },
    });
    assert.equal(isolatedStore, null);
  });

  test("auth verification failure on invalid capabilityToken or invalid profileId", async () => {
    // 1. Invalid capability token on read -> 403
    {
      const { res, result } = createMockRes();
      handlePetTeamBoardReadPost(
        createMockReq({
          url: "/pet-team/board/read",
          body: JSON.stringify({
            schemaVersion: "1",
            kind: "team_board_read",
            rawSessionId: callerRaw,
            capabilityToken: generateToken(), // unauthenticated token
          }),
        }),
        res,
        {
          peerCapabilityRegistry: registry,
          teamStore,
          derivePetId,
        }
      );

      await result.done;
      assert.equal(result.statusCode, 403);
    }

    // 2. Invalid capability token on write -> 403
    {
      const { res, result } = createMockRes();
      handlePetTeamBoardWritePost(
        createMockReq({
          url: "/pet-team/board/write",
          body: JSON.stringify({
            schemaVersion: "1",
            kind: "team_board_write",
            rawSessionId: callerRaw,
            capabilityToken: generateToken(), // unauthenticated token
            baseRevision: 0,
            markdown: "foo",
          }),
        }),
        res,
        {
          peerCapabilityRegistry: registry,
          teamStore,
          derivePetId,
        }
      );

      await result.done;
      assert.equal(result.statusCode, 403);
    }

    // 3. Invalid profileId on read -> 403
    {
      const { res, result } = createMockRes();
      handlePetTeamBoardReadPost(
        createMockReq({
          url: "/pet-team/board/read",
          body: JSON.stringify({
            schemaVersion: "1",
            kind: "team_board_read",
            rawSessionId: callerRaw,
            capabilityToken: callerToken,
          }),
        }),
        res,
        {
          remoteProfile: { profileId: "invalid/profile" },
          peerCapabilityRegistry: registry,
          teamStore,
          derivePetId,
        }
      );

      await result.done;
      assert.equal(result.statusCode, 403);
    }
  });

  test("rejects board request larger than 16 KiB", async () => {
    const hugeBody = JSON.stringify({
      schemaVersion: "1",
      kind: "team_board_read",
      rawSessionId: callerRaw,
      capabilityToken: callerToken,
      padding: "X".repeat(20000),
    });

    const { res, result } = createMockRes();
    const req = createMockReq({
      url: "/pet-team/board/read",
      body: hugeBody,
    });

    handlePetTeamBoardReadPost(req, res, {
      peerCapabilityRegistry: registry,
      teamStore,
      derivePetId,
    });

    await result.done;
    assert.equal(result.statusCode, 413);
  });
});

describe("Remote SSH Ingress Routing for Team Endpoints", () => {
  const nonce = "0123456789abcdef0123456789abcdef";

  test("remote SSH ingress allows team and board endpoints with valid routing nonce", async () => {
    let routedUrl = null;
    let routedProfile = null;

    const handler = createIngressRequestHandler({
      remoteProfile: { profileId: "remote-homelab" },
      getAcceptedNonces: () => [nonce],
      routeRequest: (req, res, profile) => {
        routedUrl = req.url;
        routedProfile = profile;
        res.writeHead(200, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
        res.end(JSON.stringify({ ok: true }));
      },
    });

    for (const pathName of [
      "/pet-team/status",
      "/pet-team/create",
      "/pet-team/dissolve",
      "/pet-team/board/read",
      "/pet-team/board/write",
    ]) {
      routedUrl = null;
      routedProfile = null;

      // 1. With valid nonce header
      const { res: resValid, result: resValidResult } = createMockRes();
      const reqValid = createMockReq({
        method: "POST",
        url: pathName,
        headers: { [ROUTING_NONCE_HEADER]: nonce },
      });

      handler(reqValid, resValid);
      await resValidResult.done;
      assert.equal(resValidResult.statusCode, 200);
      assert.equal(routedUrl, pathName);
      assert.equal(routedProfile.profileId, "remote-homelab");

      // 2. Without nonce header -> 404
      const { res: resNoNonce, result: resNoNonceResult } = createMockRes();
      const reqNoNonce = createMockReq({
        method: "POST",
        url: pathName,
      });

      handler(reqNoNonce, resNoNonce);
      await resNoNonceResult.done;
      assert.equal(resNoNonceResult.statusCode, 404);
    }
  });
});

describe("Server Routing Dispatch for Board Endpoints", () => {
  let tmpDir;
  let tStore;
  let pRegistry;
  let bStore;
  let cToken;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-server-team-test-"));
    tStore = createTeamStore({ env: { PI_PET_DATA_DIR: tmpDir } });
    bStore = createTeamBoardStore({ teamStore: tStore, env: { PI_PET_DATA_DIR: tmpDir } });
    pRegistry = createPetPeerCapabilityRegistry();
    cToken = generateToken();
    pRegistry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "session-srv", token: cToken });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test("initServer dispatches POST /pet-team/board/read and /pet-team/board/write", async () => {
    let capturedHandler = null;
    const fakeCreateHttpServer = (handler) => {
      capturedHandler = handler;
      const { EventEmitter } = require("events");
      const server = new EventEmitter();
      server.listen = function () { this.emit("listening"); };
      server.close = function () {};
      return server;
    };

    const srv = initServer({
      createHttpServer: fakeCreateHttpServer,
      setImmediate: () => {},
      getPortCandidates: () => [23334],
      readRuntimePort: () => 23334,
      clearRuntimeConfig: () => true,
      writeRuntimeConfig: () => true,
      isAgentEnabled: () => true,
      teamStore: tStore,
      teamBoardStore: bStore,
      derivePetId,
      petPeerCapabilityRegistry: pRegistry,
    });

    srv.startHttpServer();
    assert.ok(capturedHandler, "Handler should be captured");

    // Create team for caller
    const callerPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "session-srv" });
    tStore.createTeam({
      name: "Server Dispatch Team",
      leaderPetId: callerPetId,
      members: [],
      actor: { kind: "user" },
    });

    // Write through initServer captured handler
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-team/board/write",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_board_write",
          rawSessionId: "session-srv",
          capabilityToken: cToken,
          baseRevision: 0,
          markdown: "Dispatched through server.js",
        }),
      });
      capturedHandler(req, res);
      await result.done;
      assert.equal(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "updated");
      assert.equal(body.board.revision, 1);
    }

    // Read through initServer captured handler
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        url: "/pet-team/board/read",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "team_board_read",
          rawSessionId: "session-srv",
          capabilityToken: cToken,
        }),
      });
      capturedHandler(req, res);
      await result.done;
      assert.equal(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.equal(body.status, "active");
      assert.equal(body.board.revision, 1);
      assert.equal(body.board.markdown, "Dispatched through server.js");
    }
  });
});
