"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  ROUTING_NONCE_HEADER,
} = require("../hooks/server-config");
const initServer = require("../src/server");
const {
  handleStatePost,
} = require("../src/server-route-state");
const {
  createPetPeerCapabilityRegistry,
} = require("../src/server-route-pet-peer");

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function createMockReq({ method = "POST", url = "/state", headers = {}, body = "" } = {}) {
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
    writeHead(statusCode, headers = {}) {
      result.statusCode = statusCode;
      result.headers = headers;
    },
    end(chunk = "") {
      result.body += (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      if (res._resolve) res._resolve(result);
    },
  };
  result.done = new Promise((resolve) => {
    res._resolve = resolve;
  });
  return { res, result };
}

describe("State Route Local & Remote Peer Capability Lifecycle", () => {
  test("local /state registers valid pet_peer_capability and SessionEnd revokes it", async () => {
    const registry = createPetPeerCapabilityRegistry();
    const token = generateToken();
    const rawSessionId = "local-pi-session-1";

    const mockCtx = {
      isAgentEnabled: () => true,
      STATE_SVGS: { idle: "idle.svg" },
      updateSession: () => {},
      pendingPermissions: [],
      registerPetPeerCapability: registry.registerCapability,
      revokePetPeerCapability: registry.revokeCapability,
    };

    // 1. Initial local state POST with pet_peer_capability
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/state",
        body: JSON.stringify({
          agent_id: "pi",
          hook_source: "pi-extension",
          session_id: rawSessionId,
          state: "idle",
          event: "SessionStart",
          pet_peer_capability: {
            version: 1,
            receivePeerMessage: true,
            token,
          },
        }),
      });

      handleStatePost(req, res, {
        ctx: mockCtx,
        createRequestHookRecorder: () => ({ acceptedUnlessDnd: () => {} }),
        shouldDropForDnd: () => false,
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      assert.equal(registry.hasCapability({ profileId: "local", agentId: "pi", rawSessionId }), true);
      assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId, token }), true);
      assert.equal(registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId }), 1);
    }

    // 2. SessionEnd revokes capability
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/state",
        body: JSON.stringify({
          agent_id: "pi",
          hook_source: "pi-extension",
          session_id: rawSessionId,
          state: "idle",
          event: "SessionEnd",
          pet_peer_capability: {
            version: 1,
            receivePeerMessage: true,
            token,
          },
        }),
      });

      handleStatePost(req, res, {
        ctx: mockCtx,
        createRequestHookRecorder: () => ({ acceptedUnlessDnd: () => {} }),
        shouldDropForDnd: () => false,
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      assert.equal(registry.hasCapability({ profileId: "local", agentId: "pi", rawSessionId }), false);
      assert.equal(registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId }), null);
    }
  });

  test("remote profile identity stamping and same raw ID isolation", async () => {
    const registry = createPetPeerCapabilityRegistry();
    const tokenLocal = generateToken();
    const tokenRemote = generateToken();
    const sharedRawId = "shared-session-raw-id";

    const mockCtx = {
      isAgentEnabled: () => true,
      STATE_SVGS: { idle: "idle.svg" },
      updateSession: () => {},
      pendingPermissions: [],
      registerPetPeerCapability: registry.registerCapability,
      revokePetPeerCapability: registry.revokeCapability,
    };

    // 1. Register local
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/state",
        body: JSON.stringify({
          agent_id: "pi",
          hook_source: "pi-extension",
          session_id: sharedRawId,
          state: "idle",
          event: "SessionStart",
          pet_peer_capability: {
            version: 1,
            receivePeerMessage: true,
            token: tokenLocal,
          },
        }),
      });

      handleStatePost(req, res, {
        ctx: mockCtx,
        createRequestHookRecorder: () => ({ acceptedUnlessDnd: () => {} }),
        shouldDropForDnd: () => false,
        remoteProfile: null, // local
      });

      await result.done;
      assert.equal(result.statusCode, 200);
    }

    // 2. Register remote with same rawSessionId
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/state",
        body: JSON.stringify({
          agent_id: "pi",
          hook_source: "pi-extension",
          session_id: sharedRawId,
          state: "idle",
          event: "SessionStart",
          pet_peer_capability: {
            version: 1,
            receivePeerMessage: true,
            token: tokenRemote,
          },
        }),
      });

      handleStatePost(req, res, {
        ctx: mockCtx,
        createRequestHookRecorder: () => ({ acceptedUnlessDnd: () => {} }),
        shouldDropForDnd: () => false,
        remoteProfile: { profileId: "remote-worker-node" },
      });

      await result.done;
      assert.equal(result.statusCode, 200);
    }

    // Verify both are present and isolated
    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId: sharedRawId, token: tokenLocal }), true);
    assert.equal(registry.verifyCapability({ profileId: "remote-worker-node", agentId: "pi", rawSessionId: sharedRawId, token: tokenRemote }), true);
    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId: sharedRawId, token: tokenRemote }), false);
    assert.equal(registry.verifyCapability({ profileId: "remote-worker-node", agentId: "pi", rawSessionId: sharedRawId, token: tokenLocal }), false);

    // Revoking remote does not affect local
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/state",
        body: JSON.stringify({
          agent_id: "pi",
          hook_source: "pi-extension",
          session_id: sharedRawId,
          state: "idle",
          event: "SessionEnd",
          pet_peer_capability: {
            version: 1,
            receivePeerMessage: true,
            token: tokenRemote,
          },
        }),
      });

      handleStatePost(req, res, {
        ctx: mockCtx,
        createRequestHookRecorder: () => ({ acceptedUnlessDnd: () => {} }),
        shouldDropForDnd: () => false,
        remoteProfile: { profileId: "remote-worker-node" },
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      assert.equal(registry.hasCapability({ profileId: "remote-worker-node", agentId: "pi", rawSessionId: sharedRawId }), false);
      assert.equal(registry.hasCapability({ profileId: "local", agentId: "pi", rawSessionId: sharedRawId }), true);
    }
  });

  test("state route enforces stale attach rejection, stale revoke immunity, unauthenticated SessionEnd fail-close, and fresh attach across local and remote profiles", async () => {
    const registry = createPetPeerCapabilityRegistry();
    const tokenA = generateToken();
    const tokenB = generateToken();
    const tokenC = generateToken();
    const rawSessionId = "lifecycle-session-1";

    const mockCtx = {
      isAgentEnabled: () => true,
      STATE_SVGS: { idle: "idle.svg" },
      updateSession: () => {},
      pendingPermissions: [],
      registerPetPeerCapability: registry.registerCapability,
      revokePetPeerCapability: registry.revokeCapability,
    };

    const postState = async (body, remoteProfile = null) => {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/state",
        body: JSON.stringify(body),
      });
      handleStatePost(req, res, {
        ctx: mockCtx,
        createRequestHookRecorder: () => ({ acceptedUnlessDnd: () => {} }),
        shouldDropForDnd: () => false,
        remoteProfile,
      });
      await result.done;
      return result;
    };

    // 1. Initial attach with token A (local)
    const resA = await postState({
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: rawSessionId,
      state: "idle",
      event: "SessionStart",
      pet_peer_capability: { version: 1, receivePeerMessage: true, token: tokenA },
    });
    assert.equal(resA.statusCode, 200);
    assert.equal(registry.hasCapability({ profileId: "local", agentId: "pi", rawSessionId }), true);
    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId, token: tokenA }), true);
    assert.equal(registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId }), 1);

    // 2. Attach new token B (retires A and activates B with fresh generation)
    const resB = await postState({
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: rawSessionId,
      state: "idle",
      event: "SessionStart",
      pet_peer_capability: { version: 1, receivePeerMessage: true, token: tokenB },
    });
    assert.equal(resB.statusCode, 200);
    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId, token: tokenB }), true);
    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId, token: tokenA }), false);
    assert.equal(registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId }), 2);

    // 3. Stale heartbeat attempting to register retired token A is rejected (must not replace B)
    const resStaleA = await postState({
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: rawSessionId,
      state: "idle",
      event: "SessionStart",
      pet_peer_capability: { version: 1, receivePeerMessage: true, token: tokenA },
    });
    assert.equal(resStaleA.statusCode, 200);
    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId, token: tokenB }), true);
    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId, token: tokenA }), false);
    assert.equal(registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId }), 2);

    // Repeating active token B remains active with same generation
    const resRepeatB = await postState({
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: rawSessionId,
      state: "idle",
      event: "SessionStart",
      pet_peer_capability: { version: 1, receivePeerMessage: true, token: tokenB },
    });
    assert.equal(resRepeatB.statusCode, 200);
    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId, token: tokenB }), true);
    assert.equal(registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId }), 2);

    // 4. Stale A SessionEnd cannot revoke B (SessionEnd with stale token A leaves B active)
    const resStaleEndA = await postState({
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: rawSessionId,
      state: "idle",
      event: "SessionEnd",
      pet_peer_capability: { version: 1, receivePeerMessage: true, token: tokenA },
    });
    assert.equal(resStaleEndA.statusCode, 200);
    assert.equal(registry.hasCapability({ profileId: "local", agentId: "pi", rawSessionId }), true);
    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId, token: tokenB }), true);
    assert.equal(registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId }), 2);

    // 5. SessionEnd omitting token or with malformed token fails closed (does not revoke)
    const resNoTokenEnd = await postState({
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: rawSessionId,
      state: "idle",
      event: "SessionEnd",
    });
    assert.equal(resNoTokenEnd.statusCode, 200);
    assert.equal(registry.hasCapability({ profileId: "local", agentId: "pi", rawSessionId }), true);
    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId, token: tokenB }), true);

    const resMalformedTokenEnd = await postState({
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: rawSessionId,
      state: "idle",
      event: "SessionEnd",
      pet_peer_capability: { token: "invalid-hex-token" },
    });
    assert.equal(resMalformedTokenEnd.statusCode, 200);
    assert.equal(registry.hasCapability({ profileId: "local", agentId: "pi", rawSessionId }), true);
    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId, token: tokenB }), true);

    // 6. Valid B SessionEnd revokes capability and retires B
    const resEndB = await postState({
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: rawSessionId,
      state: "idle",
      event: "SessionEnd",
      pet_peer_capability: { version: 1, receivePeerMessage: true, token: tokenB },
    });
    assert.equal(resEndB.statusCode, 200);
    assert.equal(registry.hasCapability({ profileId: "local", agentId: "pi", rawSessionId }), false);
    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId, token: tokenB }), false);
    assert.equal(registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId }), null);

    // 7. Stale B heartbeat cannot resurrect the capability
    const resStaleResurrectB = await postState({
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: rawSessionId,
      state: "idle",
      event: "SessionStart",
      pet_peer_capability: { version: 1, receivePeerMessage: true, token: tokenB },
    });
    assert.equal(resStaleResurrectB.statusCode, 200);
    assert.equal(registry.hasCapability({ profileId: "local", agentId: "pi", rawSessionId }), false);
    assert.equal(registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId }), null);

    // Stale A heartbeat also cannot resurrect
    const resStaleResurrectA = await postState({
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: rawSessionId,
      state: "idle",
      event: "SessionStart",
      pet_peer_capability: { version: 1, receivePeerMessage: true, token: tokenA },
    });
    assert.equal(resStaleResurrectA.statusCode, 200);
    assert.equal(registry.hasCapability({ profileId: "local", agentId: "pi", rawSessionId }), false);

    // 8. Fresh unseen token C can register with a fresh generation
    const resC = await postState({
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: rawSessionId,
      state: "idle",
      event: "SessionStart",
      pet_peer_capability: { version: 1, receivePeerMessage: true, token: tokenC },
    });
    assert.equal(resC.statusCode, 200);
    assert.equal(registry.hasCapability({ profileId: "local", agentId: "pi", rawSessionId }), true);
    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId, token: tokenC }), true);
    assert.equal(registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId }), 3);

    // 9. Remote profile exact identity lifecycle operates independently
    const remoteProfile = { profileId: "remote-worker-lifecycle" };
    const remoteTokA = generateToken();
    const remoteTokB = generateToken();

    // Register remoteTokA
    await postState({
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: rawSessionId,
      state: "idle",
      event: "SessionStart",
      pet_peer_capability: { version: 1, receivePeerMessage: true, token: remoteTokA },
    }, remoteProfile);

    assert.equal(registry.verifyCapability({ profileId: "remote-worker-lifecycle", agentId: "pi", rawSessionId, token: remoteTokA }), true);
    assert.equal(registry.getGeneration({ profileId: "remote-worker-lifecycle", agentId: "pi", rawSessionId }), 4);
    // Local C is unaffected
    assert.equal(registry.verifyCapability({ profileId: "local", agentId: "pi", rawSessionId, token: tokenC }), true);
    assert.equal(registry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId }), 3);

    // Rotate remote to remoteTokB
    await postState({
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: rawSessionId,
      state: "idle",
      event: "SessionStart",
      pet_peer_capability: { version: 1, receivePeerMessage: true, token: remoteTokB },
    }, remoteProfile);

    assert.equal(registry.verifyCapability({ profileId: "remote-worker-lifecycle", agentId: "pi", rawSessionId, token: remoteTokB }), true);
    assert.equal(registry.getGeneration({ profileId: "remote-worker-lifecycle", agentId: "pi", rawSessionId }), 5);

    // Stale remoteTokA SessionEnd fails to revoke remoteTokB
    await postState({
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: rawSessionId,
      state: "idle",
      event: "SessionEnd",
      pet_peer_capability: { version: 1, receivePeerMessage: true, token: remoteTokA },
    }, remoteProfile);

    assert.equal(registry.hasCapability({ profileId: "remote-worker-lifecycle", agentId: "pi", rawSessionId }), true);

    // Valid remoteTokB SessionEnd revokes remote
    await postState({
      agent_id: "pi",
      hook_source: "pi-extension",
      session_id: rawSessionId,
      state: "idle",
      event: "SessionEnd",
      pet_peer_capability: { version: 1, receivePeerMessage: true, token: remoteTokB },
    }, remoteProfile);

    assert.equal(registry.hasCapability({ profileId: "remote-worker-lifecycle", agentId: "pi", rawSessionId }), false);
    // Local C is still active
    assert.equal(registry.hasCapability({ profileId: "local", agentId: "pi", rawSessionId }), true);
  });

  test("invalid, non-Pi, non-pi-extension, and default capabilities are ignored without breaking lifecycle", async () => {
    const registry = createPetPeerCapabilityRegistry();
    const token = generateToken();

    const mockCtx = {
      isAgentEnabled: () => true,
      STATE_SVGS: { idle: "idle.svg" },
      updateSession: () => {},
      pendingPermissions: [],
      registerPetPeerCapability: registry.registerCapability,
      revokePetPeerCapability: registry.revokeCapability,
    };

    // 1. Non-Pi agent (claude-code) with capability payload -> ignored
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/state",
        body: JSON.stringify({
          agent_id: "claude-code",
          hook_source: "clawd-hook",
          session_id: "sess-claude",
          state: "idle",
          event: "SessionStart",
          pet_peer_capability: {
            version: 1,
            receivePeerMessage: true,
            token,
          },
        }),
      });

      handleStatePost(req, res, {
        ctx: mockCtx,
        createRequestHookRecorder: () => ({ acceptedUnlessDnd: () => {} }),
        shouldDropForDnd: () => false,
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      assert.equal(registry.size, 0);
    }

    // 2. Pi agent with non-extension hook source -> ignored
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/state",
        body: JSON.stringify({
          agent_id: "pi",
          hook_source: "generic-hook",
          session_id: "sess-pi-fake",
          state: "idle",
          event: "SessionStart",
          pet_peer_capability: {
            version: 1,
            receivePeerMessage: true,
            token,
          },
        }),
      });

      handleStatePost(req, res, {
        ctx: mockCtx,
        createRequestHookRecorder: () => ({ acceptedUnlessDnd: () => {} }),
        shouldDropForDnd: () => false,
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      assert.equal(registry.size, 0);
    }

    // 3. Default raw session ID (e.g. "default", "pi:default") -> rejected by registry
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/state",
        body: JSON.stringify({
          agent_id: "pi",
          hook_source: "pi-extension",
          session_id: "default",
          state: "idle",
          event: "SessionStart",
          pet_peer_capability: {
            version: 1,
            receivePeerMessage: true,
            token,
          },
        }),
      });

      handleStatePost(req, res, {
        ctx: mockCtx,
        createRequestHookRecorder: () => ({ acceptedUnlessDnd: () => {} }),
        shouldDropForDnd: () => false,
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      assert.equal(registry.size, 0);
    }

    // 4. Malformed capability payload (version 2, receivePeerMessage false, bad token) -> ignored
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/state",
        body: JSON.stringify({
          agent_id: "pi",
          hook_source: "pi-extension",
          session_id: "sess-pi-bad-cap",
          state: "idle",
          event: "SessionStart",
          pet_peer_capability: {
            version: 2,
            receivePeerMessage: false,
            token: "not-a-valid-hex-token",
          },
        }),
      });

      handleStatePost(req, res, {
        ctx: mockCtx,
        createRequestHookRecorder: () => ({ acceptedUnlessDnd: () => {} }),
        shouldDropForDnd: () => false,
      });

      await result.done;
      assert.equal(result.statusCode, 200);
      assert.equal(registry.size, 0);
    }
  });
});

describe("Server Instance Registries & Cleanup Isolation", () => {
  test("server instances maintain isolated registries/stores and cleanup clears them", () => {
    let capturedHandler1 = null;
    let capturedHandler2 = null;

    const fakeCreateHttpServer1 = (handler) => {
      capturedHandler1 = handler;
      return {
        on: () => {},
        listen: () => {},
        close: () => {},
        address: () => ({ port: 23333 }),
      };
    };

    const fakeCreateHttpServer2 = (handler) => {
      capturedHandler2 = handler;
      return {
        on: () => {},
        listen: () => {},
        close: () => {},
        address: () => ({ port: 23334 }),
      };
    };

    const server1 = initServer({
      createHttpServer: fakeCreateHttpServer1,
      setImmediate: () => {},
      getPortCandidates: () => [23333],
      readRuntimePort: () => 23333,
      clearRuntimeConfig: () => true,
      writeRuntimeConfig: () => true,
      isAgentEnabled: () => true,
    });

    const server2 = initServer({
      createHttpServer: fakeCreateHttpServer2,
      setImmediate: () => {},
      getPortCandidates: () => [23334],
      readRuntimePort: () => 23334,
      clearRuntimeConfig: () => true,
      writeRuntimeConfig: () => true,
      isAgentEnabled: () => true,
    });

    assert.notEqual(server1.petPeerCapabilityRegistry, server2.petPeerCapabilityRegistry);
    assert.notEqual(server1.petPeerHandleStore, server2.petPeerHandleStore);
    assert.notEqual(server1.petPeerSendRateLimiter, server2.petPeerSendRateLimiter);

    // Populate server1
    const tok = generateToken();
    server1.petPeerCapabilityRegistry.registerCapability({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "s1",
      token: tok,
    });
    server1.petPeerHandleStore.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "s1" },
      callerGeneration: 1,
      target: { profileId: "local", agentId: "pi", rawSessionId: "s2", displayName: "S2", host: "local" },
      targetGeneration: 1,
      nowMs: Date.now(),
    });
    server1.petPeerSendRateLimiter.record({ profileId: "local", agentId: "pi", rawSessionId: "s1" }, Date.now());

    assert.equal(server1.petPeerCapabilityRegistry.size, 1);
    assert.equal(server1.petPeerHandleStore.size, 1);
    assert.equal(server2.petPeerCapabilityRegistry.size, 0);
    assert.equal(server2.petPeerHandleStore.size, 0);

    // Cleanup server1 clears all three
    server1.cleanup();
    assert.equal(server1.petPeerCapabilityRegistry.size, 0);
    assert.equal(server1.petPeerHandleStore.size, 0);
    assert.equal(server1.petPeerSendRateLimiter.check({ profileId: "local", agentId: "pi", rawSessionId: "s1" }).count, 0);
  });

  test("deactivatePetProfile atomically clears only the disconnected profile's messaging authority", () => {
    const server = initServer({
      createHttpServer: () => ({
        on: () => {},
        listen: () => {},
        close: () => {},
        address: () => ({ port: 23333 }),
      }),
      setImmediate: () => {},
      getPortCandidates: () => [23333],
      readRuntimePort: () => 23333,
      clearRuntimeConfig: () => true,
      writeRuntimeConfig: () => true,
      isAgentEnabled: () => true,
    });
    const localToken = generateToken();
    const remoteToken = generateToken();
    const local = { profileId: "local", agentId: "pi", rawSessionId: "local-session" };
    const remote = { profileId: "profile-remote", agentId: "pi", rawSessionId: "remote-session" };

    server.petInboxCapabilityRegistry.registerCapability({ ...local, token: localToken });
    server.petInboxCapabilityRegistry.registerCapability({ ...remote, token: remoteToken });
    server.petPeerCapabilityRegistry.registerCapability({ ...local, token: localToken });
    server.petPeerCapabilityRegistry.registerCapability({ ...remote, token: remoteToken });
    server.petPeerHandleStore.createCatalogHandle({
      caller: local,
      callerGeneration: server.petPeerCapabilityRegistry.getGeneration(local),
      target: { ...remote, displayName: "Remote", host: "Homelab" },
      targetGeneration: server.petPeerCapabilityRegistry.getGeneration(remote),
    });
    server.petPeerSendRateLimiter.record(remote, 1000);

    assert.deepEqual(server.deactivatePetProfile("profile-remote"), {
      inboxCapabilities: 1,
      peerCapabilities: 1,
      peerHandles: 1,
      peerRateLimits: 1,
    });
    assert.equal(server.petInboxCapabilityRegistry.verifyCapability({ ...remote, token: remoteToken }), false);
    assert.equal(server.petPeerCapabilityRegistry.hasCapability(remote), false);
    assert.equal(server.petPeerHandleStore.size, 0);
    assert.equal(server.petPeerSendRateLimiter.check(remote, 1000).count, 0);
    assert.equal(server.petInboxCapabilityRegistry.verifyCapability({ ...local, token: localToken }), true);
    assert.equal(server.petPeerCapabilityRegistry.hasCapability(local), true);

    assert.deepEqual(server.deactivatePetProfile("local"), {
      inboxCapabilities: 0,
      peerCapabilities: 0,
      peerHandles: 0,
      peerRateLimits: 0,
    });
    server.cleanup();
  });
});

describe("Server Route Dispatch & End-to-End Integration", () => {
  test("server dispatches /state to register capability and /pet-peer/catalog to retrieve handles", async () => {
    let capturedHandler = null;
    const fakeCreateHttpServer = (handler) => {
      capturedHandler = handler;
      return {
        on: (ev, cb) => { if (ev === "listening") setImmediate(cb); },
        listen: () => {},
        close: () => {},
        address: () => ({ port: 23333 }),
      };
    };

    const tokenCaller = generateToken();
    const tokenTarget = generateToken();

    const mockSessions = [
      {
        id: "caller-sess",
        profileId: "local",
        rawSessionId: "caller-sess",
        agentId: "pi",
        displayTitle: "Caller Pi",
        state: "idle",
      },
      {
        id: "target-sess",
        profileId: "local",
        rawSessionId: "target-sess",
        agentId: "pi",
        displayTitle: "Target Pi",
        state: "idle",
      },
    ];

    const server = initServer({
      createHttpServer: fakeCreateHttpServer,
      setImmediate: () => {},
      getPortCandidates: () => [23333],
      readRuntimePort: () => 23333,
      clearRuntimeConfig: () => true,
      writeRuntimeConfig: () => true,
      isAgentEnabled: () => true,
      STATE_SVGS: { idle: "idle.svg" },
      updateSession: () => {},
      getSessionSnapshot: () => ({ sessions: mockSessions }),
    });

    server.startHttpServer();
    assert.ok(capturedHandler);

    // 1. Register caller capability via /state
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/state",
        body: JSON.stringify({
          agent_id: "pi",
          hook_source: "pi-extension",
          session_id: "caller-sess",
          state: "idle",
          event: "SessionStart",
          pet_peer_capability: { version: 1, receivePeerMessage: true, token: tokenCaller },
        }),
      });
      capturedHandler(req, res);
      await result.done;
      assert.equal(result.statusCode, 200);
    }

    // 2. Register target capability via /state
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/state",
        body: JSON.stringify({
          agent_id: "pi",
          hook_source: "pi-extension",
          session_id: "target-sess",
          state: "idle",
          event: "SessionStart",
          pet_peer_capability: { version: 1, receivePeerMessage: true, token: tokenTarget },
        }),
      });
      capturedHandler(req, res);
      await result.done;
      assert.equal(result.statusCode, 200);
    }

    // 3. Dispatch POST /pet-peer/catalog
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/pet-peer/catalog",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_catalog_query",
          rawSessionId: "caller-sess",
          capabilityToken: tokenCaller,
        }),
      });
      capturedHandler(req, res);
      await result.done;
      assert.equal(result.statusCode, 200);
      assert.equal(result.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);

      const parsed = JSON.parse(result.body);
      assert.equal(parsed.kind, "peer_catalog");
      assert.equal(parsed.sessions.length, 1);
      assert.equal(parsed.sessions[0].displayName, "Target Pi · Pi");
      assert.ok(parsed.sessions[0].handle.startsWith("psh_"));
    }

    server.cleanup();
  });

  test("server dispatches POST /pet-peer/send and invokes enqueuePeerMessage seam", async () => {
    let capturedHandler = null;
    const fakeCreateHttpServer = (handler) => {
      capturedHandler = handler;
      return {
        on: (ev, cb) => { if (ev === "listening") setImmediate(cb); },
        listen: () => {},
        close: () => {},
        address: () => ({ port: 23333 }),
      };
    };

    const tokenSender = generateToken();
    const tokenReceiver = generateToken();

    const mockSessions = [
      {
        id: "sender-sess",
        profileId: "local",
        rawSessionId: "sender-sess",
        agentId: "pi",
        displayTitle: "Sender",
        state: "idle",
      },
      {
        id: "receiver-sess",
        profileId: "local",
        rawSessionId: "receiver-sess",
        agentId: "pi",
        displayTitle: "Receiver",
        state: "idle",
      },
    ];

    let enqueuedPayload = null;
    const server = initServer({
      createHttpServer: fakeCreateHttpServer,
      setImmediate: () => {},
      getPortCandidates: () => [23333],
      readRuntimePort: () => 23333,
      clearRuntimeConfig: () => true,
      writeRuntimeConfig: () => true,
      isAgentEnabled: () => true,
      STATE_SVGS: { idle: "idle.svg" },
      updateSession: () => {},
      getSessionSnapshot: () => ({ sessions: mockSessions }),
      derivePetId: ({ profileId, rawSessionId }) => `pet_${profileId}_${rawSessionId}`,
      enqueuePeerMessage: (args) => {
        enqueuedPayload = args;
        return {
          schemaVersion: "1",
          kind: "peer_message",
          messageId: args.messageId,
          status: "queued",
          threadId: args.threadId,
          hopCount: args.hopCount,
          maxHops: args.maxHops,
        };
      },
    });

    server.startHttpServer();
    assert.ok(capturedHandler);

    // Register sender & receiver capabilities
    server.petPeerCapabilityRegistry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "sender-sess", token: tokenSender });
    server.petPeerCapabilityRegistry.registerCapability({ profileId: "local", agentId: "pi", rawSessionId: "receiver-sess", token: tokenReceiver });

    // Create a handle
    const senderGen = server.petPeerCapabilityRegistry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: "sender-sess" });
    const receiverGen = server.petPeerCapabilityRegistry.getGeneration({ profileId: "local", agentId: "pi", rawSessionId: "receiver-sess" });
    const { handle } = server.petPeerHandleStore.createCatalogHandle({
      caller: { profileId: "local", agentId: "pi", rawSessionId: "sender-sess" },
      callerGeneration: senderGen,
      target: { profileId: "local", agentId: "pi", rawSessionId: "receiver-sess", displayName: "Receiver", host: "local" },
      targetGeneration: receiverGen,
      nowMs: Date.now(),
    });

    // POST /pet-peer/send
    const { res, result } = createMockRes();
    const req = createMockReq({
      method: "POST",
      url: "/pet-peer/send",
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "peer_send",
        rawSessionId: "sender-sess",
        capabilityToken: tokenSender,
        target: handle,
        text: "Direct peer communication test",
      }),
    });
    capturedHandler(req, res);
    await result.done;

    assert.equal(result.statusCode, 202);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.status, "queued");
    assert.equal(parsed.hopCount, 0);

    assert.ok(enqueuedPayload);
    assert.equal(enqueuedPayload.text, "Direct peer communication test");
    assert.equal(enqueuedPayload.sourcePetId, "pet_local_sender-sess");
    assert.equal(enqueuedPayload.targetPetId, "pet_local_receiver-sess");

    server.cleanup();
  });

  test("server dispatches POST /pet-peer/claim, /settle, and /receipt via runtime seams", async () => {
    let capturedHandler = null;
    const fakeCreateHttpServer = (handler) => {
      capturedHandler = handler;
      return {
        on: (ev, cb) => { if (ev === "listening") setImmediate(cb); },
        listen: () => {},
        close: () => {},
        address: () => ({ port: 23333 }),
      };
    };

    const token = generateToken();
    const messageStore = new Map();
    const receiptsStore = new Map();

    const server = initServer({
      createHttpServer: fakeCreateHttpServer,
      setImmediate: () => {},
      getPortCandidates: () => [23333],
      readRuntimePort: () => 23333,
      clearRuntimeConfig: () => true,
      writeRuntimeConfig: () => true,
      isAgentEnabled: () => true,
      derivePetId: ({ profileId, rawSessionId }) => `pet_${profileId}_${rawSessionId}`,
      claimNextPeerMessage: ({ targetPetId, rawSessionId }) => {
        return {
          schemaVersion: "1",
          kind: "peer_message",
          messageId: "msg_coord_1",
          targetPetId,
          sourceDisplayName: "Sender · Pi",
          sourceHost: "local",
          text: "Coordinator message",
          deliverAs: "followUp",
          threadId: "thr_123",
          hopCount: 0,
          maxHops: 1,
          claimToken: "claim_tok_coord",
          createdAtMs: 1757419200000,
          expiresAtMs: 1757419260000,
          claimedAtMs: 1757419200500,
        };
      },
      settlePeerMessage: ({ targetPetId, messageId, claimToken, status, reason }) => {
        const rcpt = {
          schemaVersion: "1",
          kind: "peer_message",
          messageId,
          status,
          reason: reason || null,
          threadId: "thr_123",
          hopCount: 0,
          maxHops: 1,
          createdAtMs: 1757419200000,
          expiresAtMs: 1757419260000,
        };
        receiptsStore.set(messageId, rcpt);
        return rcpt;
      },
      getPeerMessageReceipt: ({ sourcePetId, messageId }) => {
        return receiptsStore.get(messageId) || null;
      },
    });

    server.startHttpServer();
    assert.ok(capturedHandler);

    // Register capability
    server.petPeerCapabilityRegistry.registerCapability({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "peer-sess-1",
      token,
    });

    // 1. Dispatch POST /pet-peer/claim
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/pet-peer/claim",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_message_claim",
          rawSessionId: "peer-sess-1",
          capabilityToken: token,
        }),
      });
      capturedHandler(req, res);
      await result.done;

      assert.equal(result.statusCode, 200);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "claimed");
      assert.equal(parsed.messageId, "msg_coord_1");
      assert.equal(parsed.claimToken, "claim_tok_coord");
      assert.equal(parsed.text, "Coordinator message");
    }

    // 2. Dispatch POST /pet-peer/settle
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/pet-peer/settle",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_message_settle",
          rawSessionId: "peer-sess-1",
          capabilityToken: token,
          messageId: "msg_coord_1",
          claimToken: "claim_tok_coord",
          status: "dispatched",
        }),
      });
      capturedHandler(req, res);
      await result.done;

      assert.equal(result.statusCode, 200);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "dispatched");
      assert.equal(parsed.messageId, "msg_coord_1");
    }

    // 3. Dispatch POST /pet-peer/receipt
    {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: "POST",
        url: "/pet-peer/receipt",
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "peer_message_receipt_query",
          rawSessionId: "peer-sess-1",
          capabilityToken: token,
          messageId: "msg_coord_1",
        }),
      });
      capturedHandler(req, res);
      await result.done;

      assert.equal(result.statusCode, 200);
      const parsed = JSON.parse(result.body);
      assert.equal(parsed.status, "dispatched");
      assert.equal(parsed.messageId, "msg_coord_1");
    }

    server.cleanup();
  });
});

describe("Remote SSH Ingress Peer Endpoints & Nonce Gating", () => {
  const validNonce = "a".repeat(32);
  const wrongNonce = "b".repeat(32);
  const remoteProfile = { profileId: "remote-worker-1" };

  let capturedMainHandler = null;
  let capturedIngressHandler = null;

  const fakeCreateMainHttpServer = (handler) => {
    capturedMainHandler = handler;
    return {
      on: () => {},
      listen: () => {},
      close: () => {},
      address: () => ({ port: 23333 }),
    };
  };

  const fakeCreateIngressHttpServer = (handler) => {
    capturedIngressHandler = handler;
    return {
      on: (ev, cb) => { if (ev === "listening") setImmediate(cb); },
      once: (ev, cb) => { if (ev === "listening") setImmediate(cb); },
      removeListener: () => {},
      listen: () => {},
      close: () => {},
      address: () => ({ port: 23334 }),
    };
  };

  function setupIngressServer() {
    const server = initServer({
      createHttpServer: fakeCreateMainHttpServer,
      setImmediate: () => {},
      getPortCandidates: () => [23333],
      readRuntimePort: () => 23333,
      clearRuntimeConfig: () => true,
      writeRuntimeConfig: () => true,
      isAgentEnabled: () => true,
    });

    server.startHttpServer();

    const ingress = server.openRemoteSshIngress({
      remoteProfile,
      getAcceptedNonces: () => [validNonce],
      createServer: fakeCreateIngressHttpServer,
    });

    return { server, ingress };
  }

  test("ingress accepts all five exact POST peer endpoints with valid header nonce", async () => {
    const { server, ingress } = setupIngressServer();
    await ingress.start();
    assert.ok(capturedIngressHandler);

    const endpoints = [
      "/pet-peer/catalog",
      "/pet-peer/send",
      "/pet-peer/claim",
      "/pet-peer/settle",
      "/pet-peer/receipt",
    ];

    for (const ep of endpoints) {
      const { res, result } = createMockRes();
      // Send a request with valid nonce header and invalid JSON body so it gets through ingress into route handler (returning 400 bad json instead of 404)
      const req = createMockReq({
        method: "POST",
        url: ep,
        headers: { [ROUTING_NONCE_HEADER]: validNonce },
        body: "invalid-json",
      });

      capturedIngressHandler(req, res);
      await result.done;

      // Reaching the route handler produces 400 bad json with CLAWD_SERVER_HEADER, proving ingress allowed the request through
      assert.equal(result.statusCode, 400, `Endpoint ${ep} should pass ingress and reach route handler`);
      assert.equal(result.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    }

    server.cleanup();
    ingress.close();
  });

  test("ingress rejects missing nonce, wrong nonce, query nonce, path nonce, and non-POST methods as generic 404", async () => {
    const { server, ingress } = setupIngressServer();
    await ingress.start();
    assert.ok(capturedIngressHandler);

    const endpoints = [
      "/pet-peer/catalog",
      "/pet-peer/send",
      "/pet-peer/claim",
      "/pet-peer/settle",
      "/pet-peer/receipt",
    ];

    for (const ep of endpoints) {
      // 1. Missing nonce header
      {
        const { res, result } = createMockRes();
        const req = createMockReq({
          method: "POST",
          url: ep,
          headers: {},
          body: "{}",
        });
        capturedIngressHandler(req, res);
        await result.done;
        assert.equal(result.statusCode, 404, `Missing nonce on ${ep} must return 404`);
        assert.equal(result.headers[CLAWD_SERVER_HEADER], undefined, "Must not have Clawd server header on ingress 404");
      }

      // 2. Wrong nonce header
      {
        const { res, result } = createMockRes();
        const req = createMockReq({
          method: "POST",
          url: ep,
          headers: { [ROUTING_NONCE_HEADER]: wrongNonce },
          body: "{}",
        });
        capturedIngressHandler(req, res);
        await result.done;
        assert.equal(result.statusCode, 404, `Wrong nonce on ${ep} must return 404`);
        assert.equal(result.headers[CLAWD_SERVER_HEADER], undefined);
      }

      // 3. Query nonce variant (e.g. /pet-peer/catalog?nonce=...)
      {
        const { res, result } = createMockRes();
        const req = createMockReq({
          method: "POST",
          url: `${ep}?nonce=${validNonce}`,
          headers: {},
          body: "{}",
        });
        capturedIngressHandler(req, res);
        await result.done;
        assert.equal(result.statusCode, 404, `Query nonce on ${ep} must return 404`);
        assert.equal(result.headers[CLAWD_SERVER_HEADER], undefined);
      }

      // 4. Path nonce variant (e.g. /pet-peer/catalog/<nonce>)
      {
        const { res, result } = createMockRes();
        const req = createMockReq({
          method: "POST",
          url: `${ep}/${validNonce}`,
          headers: {},
          body: "{}",
        });
        capturedIngressHandler(req, res);
        await result.done;
        assert.equal(result.statusCode, 404, `Path nonce on ${ep} must return 404`);
        assert.equal(result.headers[CLAWD_SERVER_HEADER], undefined);
      }

      // 5. Non-POST method (e.g. GET)
      {
        const { res, result } = createMockRes();
        const req = createMockReq({
          method: "GET",
          url: ep,
          headers: { [ROUTING_NONCE_HEADER]: validNonce },
          body: "",
        });
        capturedIngressHandler(req, res);
        await result.done;
        assert.equal(result.statusCode, 404, `GET method on ${ep} must return 404`);
        assert.equal(result.headers[CLAWD_SERVER_HEADER], undefined);
      }
    }

    server.cleanup();
    ingress.close();
  });

  test("local main server strictly rejects requests containing x-clawd-routing-nonce header (404)", async () => {
    const { server } = setupIngressServer();
    assert.ok(capturedMainHandler);

    // Any route with nonce header directly to local server must fail closed
    const testRoutes = [
      { method: "POST", url: "/state" },
      { method: "POST", url: "/permission" },
      { method: "POST", url: "/pet-peer/catalog" },
      { method: "POST", url: "/pet-peer/send" },
      { method: "POST", url: "/pet-peer/claim" },
      { method: "POST", url: "/pet-peer/settle" },
      { method: "POST", url: "/pet-peer/receipt" },
      { method: "GET", url: "/state" },
    ];

    for (const route of testRoutes) {
      const { res, result } = createMockRes();
      const req = createMockReq({
        method: route.method,
        url: route.url,
        headers: { [ROUTING_NONCE_HEADER]: validNonce },
        body: "{}",
      });
      capturedMainHandler(req, res);
      await result.done;
      assert.equal(result.statusCode, 404, `Local main server must reject nonce header on ${route.method} ${route.url}`);
      assert.equal(result.body, "not found");
    }

    server.cleanup();
  });
});
