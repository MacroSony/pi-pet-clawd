"use strict";

const { isValidSessionProfileId } = require("./session-key");
const {
  countUnicodeCodePoints,
  sanitizeDisplayName,
  sanitizeHost,
  sanitizeState,
  isInactiveState,
  isValidPeerRawSessionId,
  sendJsonResponse,
} = require("./server-route-pet-peer");
const { loadRuntime } = require("./pet-presentation-bridge");

const MAX_PET_TEAM_BODY_BYTES = 16 * 1024; // 16 KiB
const MAX_TEAM_NAME_CODE_POINTS = 80;
const MIN_TEAM_NAME_CODE_POINTS = 1;
const MAX_TEAM_TARGETS = 7;
const MIN_TEAM_TARGETS = 1;

const ALLOWED_TEAM_STATUS_KEYS = Object.freeze(new Set([
  "schemaVersion",
  "kind",
  "rawSessionId",
  "capabilityToken",
]));

const ALLOWED_TEAM_CREATE_KEYS = Object.freeze(new Set([
  "schemaVersion",
  "kind",
  "rawSessionId",
  "capabilityToken",
  "name",
  "targets",
]));

const ALLOWED_TEAM_DISSOLVE_KEYS = Object.freeze(new Set([
  "schemaVersion",
  "kind",
  "rawSessionId",
  "capabilityToken",
]));

const C0_C1_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;

function validateBasePayload(data, allowedKeys, expectedKind) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "Payload must be an object" };
  }
  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) return { ok: false, reason: `Unknown property: "${key}"` };
  }
  if (data.schemaVersion !== "1") return { ok: false, reason: "schemaVersion must be '1'" };
  if (data.kind !== expectedKind) return { ok: false, reason: `kind must be '${expectedKind}'` };
  if (!isValidPeerRawSessionId(data.rawSessionId)) {
    return { ok: false, reason: "rawSessionId must be a non-empty string up to 4096 characters without null, newline, or carriage return characters" };
  }
  if (typeof data.capabilityToken !== "string" || !/^[0-9a-f]{64}$/.test(data.capabilityToken)) {
    return { ok: false, reason: "capabilityToken must be a 64-character lowercase hex string" };
  }
  return { ok: true };
}

function validatePetTeamStatusPayload(data) {
  return validateBasePayload(data, ALLOWED_TEAM_STATUS_KEYS, "team_status");
}

function validatePetTeamCreatePayload(data) {
  const baseValidation = validateBasePayload(data, ALLOWED_TEAM_CREATE_KEYS, "team_create");
  if (!baseValidation.ok) return baseValidation;

  if (typeof data.name !== "string") return { ok: false, reason: "name must be a string" };
  if (C0_C1_CONTROL_RE.test(data.name)) return { ok: false, reason: "name contains forbidden control characters" };

  const trimmedName = data.name.trim();
  const nameCodePoints = countUnicodeCodePoints(trimmedName);
  if (nameCodePoints < MIN_TEAM_NAME_CODE_POINTS || nameCodePoints > MAX_TEAM_NAME_CODE_POINTS) {
    return { ok: false, reason: `name length must be between ${MIN_TEAM_NAME_CODE_POINTS} and ${MAX_TEAM_NAME_CODE_POINTS} Unicode code points` };
  }

  if (!Array.isArray(data.targets)) return { ok: false, reason: "targets must be an array" };
  if (data.targets.length < MIN_TEAM_TARGETS || data.targets.length > MAX_TEAM_TARGETS) {
    return { ok: false, reason: `targets count must be between ${MIN_TEAM_TARGETS} and ${MAX_TEAM_TARGETS}` };
  }

  const seenHandles = new Set();
  for (const target of data.targets) {
    if (typeof target !== "string" || !/^psh_[A-Za-z0-9_-]{1,124}$/.test(target)) {
      return { ok: false, reason: "Each target must be a valid psh_ handle string" };
    }
    if (seenHandles.has(target)) return { ok: false, reason: "Duplicate target handle in targets array" };
    seenHandles.add(target);
  }

  return { ok: true };
}

function validatePetTeamDissolvePayload(data) {
  return validateBasePayload(data, ALLOWED_TEAM_DISSOLVE_KEYS, "team_dissolve");
}

function resolveTeamStore(options = {}) {
  const { ctx, teamStore, env } = options;
  if (teamStore && typeof teamStore.createTeam === "function") return teamStore;
  if (ctx && ctx.teamStore && typeof ctx.teamStore.createTeam === "function") return ctx.teamStore;
  try {
    const runtime = loadRuntime(env || (ctx && ctx.env) || process.env);
    if (runtime && typeof runtime.createTeamStore === "function") {
      // The store is a synchronous facade over coordinator-owned files; no
      // object-local mutable authority is required between requests.
      return runtime.createTeamStore({ env: env || (ctx && ctx.env) || process.env });
    }
  } catch {}
  return null;
}

function resolveDerivePetId(options = {}) {
  const { ctx, derivePetId, env } = options;
  if (typeof derivePetId === "function") return derivePetId;
  if (ctx && typeof ctx.derivePetId === "function") return ctx.derivePetId;
  try {
    const runtime = loadRuntime(env || (ctx && ctx.env) || process.env);
    if (runtime && typeof runtime.derivePetId === "function") return runtime.derivePetId;
  } catch {}
  return null;
}

function getCandidateSessions(options = {}) {
  const { ctx, getSessionSnapshot, sessions } = options;
  const getSnapshotFn = getSessionSnapshot || (ctx && ctx.getSessionSnapshot);
  if (typeof getSnapshotFn === "function") {
    try {
      const snapshot = getSnapshotFn();
      if (snapshot && Array.isArray(snapshot.sessions)) return snapshot.sessions;
      if (Array.isArray(snapshot)) return snapshot;
      if (snapshot instanceof Map) return Array.from(snapshot.values());
    } catch {
      return null;
    }
  }
  if (Array.isArray(sessions)) return sessions;
  if (ctx && Array.isArray(ctx.sessions)) return ctx.sessions;
  return null;
}

function readJsonBody(req, res, validateFn, onParsed) {
  const chunks = [];
  let bodySize = 0;
  let tooLarge = false;

  req.on("data", (chunk) => {
    if (tooLarge) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : (typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    bodySize += buf.length;
    if (bodySize > MAX_PET_TEAM_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      return;
    }
    chunks.push(buf);
  });

  req.on("end", () => {
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

    const validation = validateFn(data);
    if (!validation.ok) {
      sendJsonResponse(res, 400, { status: "rejected", reason: validation.reason });
      return;
    }

    onParsed(data);
  });

  req.on("error", (err) => {
    try {
      sendJsonResponse(res, 500, { status: "failed", reason: (err && err.message) || "request stream error" });
    } catch {}
  });
}

function authenticateTeamRequest(req, res, options, data) {
  const { ctx, remoteProfile = null } = options;

  const callerProfileId = (remoteProfile && typeof remoteProfile.profileId === "string" && remoteProfile.profileId.trim())
    ? remoteProfile.profileId
    : "local";

  if (!isValidSessionProfileId(callerProfileId)) {
    sendJsonResponse(res, 403, { status: "rejected", reason: "invalid profileId" });
    return null;
  }

  const registry = options.peerCapabilityRegistry || (ctx && ctx.peerCapabilityRegistry);
  if (!registry || typeof registry.verifyCapability !== "function") {
    sendJsonResponse(res, 503, { status: "failed", reason: "peer capability registry unavailable" });
    return null;
  }

  const callerVerified = registry.verifyCapability({
    profileId: callerProfileId,
    agentId: "pi",
    rawSessionId: data.rawSessionId,
    token: data.capabilityToken,
  });

  if (!callerVerified) {
    sendJsonResponse(res, 403, { status: "rejected", reason: "invalid or expired capability token" });
    return null;
  }

  const teamStore = resolveTeamStore(options);
  const derivePetId = resolveDerivePetId(options);
  if (!teamStore || !derivePetId) {
    sendJsonResponse(res, 503, { status: "failed", reason: "Runtime team store unavailable" });
    return null;
  }

  const callerPetId = derivePetId({
    profileId: callerProfileId,
    agentId: "pi",
    rawSessionId: data.rawSessionId,
  });

  return { callerProfileId, registry, teamStore, derivePetId, callerPetId };
}

function buildSanitizedTeamProjection({
  team,
  caller,
  candidateSessions = [],
  handleStore,
  registry,
  derivePetId,
  options = {},
}) {
  const callerMember = Array.isArray(team.members) ? team.members.find((m) => m && m.petId === caller.petId) : null;
  const callerRole = (callerMember && typeof callerMember.role === "string") ? callerMember.role : "member";
  const callerGeneration = registry && typeof registry.getGeneration === "function"
    ? registry.getGeneration({ profileId: caller.profileId || "local", agentId: "pi", rawSessionId: caller.rawSessionId })
    : null;

  const sessionByPetId = new Map();
  const activeSessionByPetId = new Map();
  let callerSession = null;
  const sessions = Array.isArray(candidateSessions) ? candidateSessions : [];

  for (const session of sessions) {
    if (!session || typeof session !== "object") continue;
    const sProfileId = (typeof session.profileId === "string" && session.profileId.trim()) ? session.profileId : "local";
    const sRawSessionId = session.rawSessionId || session.id;
    if (!sRawSessionId) continue;

    if (sProfileId === caller.profileId && sRawSessionId === caller.rawSessionId) callerSession = session;

    const sPetId = derivePetId({ profileId: sProfileId, agentId: "pi", rawSessionId: sRawSessionId });
    if (!sessionByPetId.has(sPetId)) sessionByPetId.set(sPetId, session);

    if (session.agentId !== "pi" || session.headless === true || session.startupRecovered === true || session.hiddenFromHud === true) continue;
    if (isInactiveState(session.state)) continue;

    const hasCap = registry && typeof registry.hasCapability === "function" && registry.hasCapability({
      profileId: sProfileId,
      agentId: "pi",
      rawSessionId: sRawSessionId,
    });
    if (!hasCap) continue;

    if (!activeSessionByPetId.has(sPetId)) {
      activeSessionByPetId.set(sPetId, { session, profileId: sProfileId, rawSessionId: sRawSessionId });
    }
  }

  const sanitizedMembers = [];
  const teamMembers = Array.isArray(team.members) ? team.members : [];

  for (const member of teamMembers) {
    if (!member || typeof member !== "object") continue;

    if (member.petId === caller.petId) {
      sanitizedMembers.push({
        displayName: sanitizeDisplayName((callerSession && (callerSession.displayTitle || callerSession.sessionTitle || callerSession.agentName)) || "Pi"),
        host: sanitizeHost((callerSession && (callerSession.sourceDisplayLabel || callerSession.host)) || caller.profileId || "local"),
        state: sanitizeState((callerSession && callerSession.state) || "running"),
        role: member.role,
        canMessage: false,
      });
    } else {
      const activeEntry = activeSessionByPetId.get(member.petId);
      if (activeEntry && handleStore && typeof handleStore.createCatalogHandle === "function" && callerGeneration !== null) {
        const { session, profileId, rawSessionId } = activeEntry;
        const displayName = sanitizeDisplayName(session.displayTitle || session.sessionTitle || session.agentName || "Pi");
        const host = sanitizeHost(session.sourceDisplayLabel || session.host || "local");
        const state = sanitizeState(session.state || "idle");
        const targetGeneration = registry && typeof registry.getGeneration === "function"
          ? registry.getGeneration({ profileId, agentId: "pi", rawSessionId })
          : null;

        const { handle } = handleStore.createCatalogHandle({
          caller: { profileId: caller.profileId || "local", agentId: "pi", rawSessionId: caller.rawSessionId },
          callerGeneration,
          target: { profileId, agentId: "pi", rawSessionId, displayName, host },
          targetGeneration,
          nowMs: typeof options.now === "function" ? options.now() : undefined,
        });

        sanitizedMembers.push({ displayName, host, state, role: member.role, canMessage: true, handle });
      } else {
        const offlineSession = sessionByPetId.get(member.petId);
        sanitizedMembers.push({
          displayName: sanitizeDisplayName((offlineSession && (offlineSession.displayTitle || offlineSession.sessionTitle || offlineSession.agentName)) || "Pi"),
          host: sanitizeHost((offlineSession && (offlineSession.sourceDisplayLabel || offlineSession.host)) || "unknown"),
          state: sanitizeState((offlineSession && offlineSession.state) || "offline"),
          role: member.role,
          canMessage: false,
        });
      }
    }
  }

  return { name: team.name, revision: team.revision, callerRole, members: sanitizedMembers };
}

function handlePetTeamStatusPost(req, res, options = {}) {
  readJsonBody(req, res, validatePetTeamStatusPayload, (data) => {
    const auth = authenticateTeamRequest(req, res, options, data);
    if (!auth) return;

    const { callerProfileId, registry, teamStore, derivePetId, callerPetId } = auth;
    const teams = teamStore.listTeamsForPet({ petId: callerPetId });
    const activeTeams = Array.isArray(teams) ? teams.filter((t) => t && t.status === "active") : [];

    if (activeTeams.length === 0) {
      sendJsonResponse(res, 200, {
        schemaVersion: "1",
        kind: "team_status",
        status: "none",
      });
      return;
    }

    const candidateSessions = getCandidateSessions(options);
    const handleStore = options.peerHandleStore || (options.ctx && options.ctx.peerHandleStore);

    const projectedTeam = buildSanitizedTeamProjection({
      team: activeTeams[0],
      caller: {
        profileId: callerProfileId,
        rawSessionId: data.rawSessionId,
        petId: callerPetId,
      },
      candidateSessions: candidateSessions || [],
      handleStore,
      registry,
      derivePetId,
      options,
    });

    sendJsonResponse(res, 200, {
      schemaVersion: "1",
      kind: "team_status",
      status: "active",
      team: projectedTeam,
    });
  });
}

function handlePetTeamCreatePost(req, res, options = {}) {
  readJsonBody(req, res, validatePetTeamCreatePayload, (data) => {
    const auth = authenticateTeamRequest(req, res, options, data);
    if (!auth) return;

    const { callerProfileId, registry, teamStore, derivePetId, callerPetId } = auth;

    // 1. Caller active team check
    const callerTeams = teamStore.listTeamsForPet({ petId: callerPetId });
    if (Array.isArray(callerTeams) && callerTeams.some((t) => t && t.status === "active")) {
      sendJsonResponse(res, 409, {
        schemaVersion: "1",
        kind: "team_create",
        status: "rejected",
        reason: "Caller already belongs to an active team",
      });
      return;
    }

    // 2. Resolve and consume each target handle
    const handleStore = options.peerHandleStore || (options.ctx && options.ctx.peerHandleStore);
    if (!handleStore || typeof handleStore.resolveAndConsumeHandle !== "function") {
      sendJsonResponse(res, 503, { status: "failed", reason: "peer handle store unavailable" });
      return;
    }

    const targetPetIds = [];
    const seenTargetPetIds = new Set();
    const callerRef = {
      profileId: callerProfileId,
      agentId: "pi",
      rawSessionId: data.rawSessionId,
    };

    for (const targetHandle of data.targets) {
      const handleResult = handleStore.resolveAndConsumeHandle(targetHandle, {
        caller: callerRef,
        registry,
        expectedType: "catalog",
      });

      if (!handleResult.ok) {
        sendJsonResponse(res, 400, {
          schemaVersion: "1",
          kind: "team_create",
          status: "rejected",
          reason: handleResult.reason === "purpose_mismatch"
            ? "Target handle must be a catalog handle"
            : `Target handle invalid or expired: ${handleResult.reason}`,
        });
        return;
      }

      const { entry } = handleResult;

      const targetProfileId = (entry && entry.target && entry.target.profileId) || "local";
      const targetRawSessionId = entry && entry.target && entry.target.rawSessionId;

      const targetPetId = derivePetId({
        profileId: targetProfileId,
        agentId: "pi",
        rawSessionId: targetRawSessionId,
      });

      if (targetPetId === callerPetId) {
        sendJsonResponse(res, 400, {
          schemaVersion: "1",
          kind: "team_create",
          status: "rejected",
          reason: "Caller cannot add self as target member",
        });
        return;
      }

      if (seenTargetPetIds.has(targetPetId)) {
        sendJsonResponse(res, 400, {
          schemaVersion: "1",
          kind: "team_create",
          status: "rejected",
          reason: "Duplicate target member identity in team creation",
        });
        return;
      }

      seenTargetPetIds.add(targetPetId);
      targetPetIds.push(targetPetId);
    }

    // 3. Target active team check
    for (const tPetId of targetPetIds) {
      const targetTeams = teamStore.listTeamsForPet({ petId: tPetId });
      if (Array.isArray(targetTeams) && targetTeams.some((t) => t && t.status === "active")) {
        sendJsonResponse(res, 409, {
          schemaVersion: "1",
          kind: "team_create",
          status: "rejected",
          reason: "Target member already belongs to an active team",
        });
        return;
      }
    }

    // 4. Create team in teamStore
    const createResult = teamStore.createTeam({
      name: data.name.trim(),
      leaderPetId: callerPetId,
      members: targetPetIds.map((petId) => ({ petId, role: "member" })),
      actor: { kind: "user" },
    });

    if (!createResult.ok) {
      sendJsonResponse(res, 400, {
        schemaVersion: "1",
        kind: "team_create",
        status: "rejected",
        reason: createResult.reason || createResult.error,
      });
      return;
    }

    const candidateSessions = getCandidateSessions(options);
    const projectedTeam = buildSanitizedTeamProjection({
      team: createResult.team,
      caller: {
        profileId: callerProfileId,
        rawSessionId: data.rawSessionId,
        petId: callerPetId,
      },
      candidateSessions: candidateSessions || [],
      handleStore,
      registry,
      derivePetId,
      options,
    });

    sendJsonResponse(res, 200, {
      schemaVersion: "1",
      kind: "team_create",
      status: "active",
      team: projectedTeam,
    });
  });
}

function handlePetTeamDissolvePost(req, res, options = {}) {
  readJsonBody(req, res, validatePetTeamDissolvePayload, (data) => {
    const auth = authenticateTeamRequest(req, res, options, data);
    if (!auth) return;

    const { teamStore, callerPetId } = auth;
    const teams = teamStore.listTeamsForPet({ petId: callerPetId });
    const activeTeams = Array.isArray(teams) ? teams.filter((t) => t && t.status === "active") : [];

    if (activeTeams.length === 0) {
      sendJsonResponse(res, 404, {
        schemaVersion: "1",
        kind: "team_dissolve",
        status: "rejected",
        reason: "Caller does not belong to any active team",
      });
      return;
    }

    const activeTeam = activeTeams[0];
    if (activeTeam.leaderPetId !== callerPetId) {
      sendJsonResponse(res, 403, {
        schemaVersion: "1",
        kind: "team_dissolve",
        status: "rejected",
        reason: "Only the team leader can dissolve the team",
      });
      return;
    }

    const dissolveResult = teamStore.dissolveTeam({
      teamId: activeTeam.teamId,
      baseRevision: activeTeam.revision,
      actor: { kind: "user" },
    });

    if (!dissolveResult.ok) {
      sendJsonResponse(res, 400, {
        schemaVersion: "1",
        kind: "team_dissolve",
        status: "rejected",
        reason: dissolveResult.reason || dissolveResult.error,
      });
      return;
    }

    sendJsonResponse(res, 200, {
      schemaVersion: "1",
      kind: "team_dissolve",
      status: "dissolved",
    });
  });
}

module.exports = {
  MAX_PET_TEAM_BODY_BYTES,
  MAX_TEAM_NAME_CODE_POINTS,
  MIN_TEAM_NAME_CODE_POINTS,
  MAX_TEAM_TARGETS,
  MIN_TEAM_TARGETS,
  ALLOWED_TEAM_STATUS_KEYS,
  ALLOWED_TEAM_CREATE_KEYS,
  ALLOWED_TEAM_DISSOLVE_KEYS,
  validatePetTeamStatusPayload,
  validatePetTeamCreatePayload,
  validatePetTeamDissolvePayload,
  buildSanitizedTeamProjection,
  handlePetTeamStatusPost,
  handlePetTeamCreatePost,
  handlePetTeamDissolvePost,
  resolveTeamStore,
  resolveDerivePetId,
};
