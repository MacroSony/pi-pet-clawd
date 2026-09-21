"use strict";

// Focused bus-consumer tests for the optional Pi Forge appearance channel.
// These drive the real createForgeAppearanceConsumer / attach code path, not a
// re-implementation, and cover both extension load orders.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const core = require("../hooks/pi-extension-core");

const PROJECT_KEY = "b".repeat(64);

function makeCtx(overrides = {}) {
  return {
    hasUI: true,
    cwd: "/work/project",
    sessionManager: { getSessionId: () => "session-1" },
    ...overrides,
  };
}

function makeBus() {
  const listeners = new Map();
  return {
    on(channel, handler) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(handler);
      return () => {
        const set = listeners.get(channel);
        if (set) set.delete(handler);
      };
    },
    emit(channel, data) {
      for (const handler of [...(listeners.get(channel) || [])]) handler(data);
    },
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: "1",
    sessionId: "session-1",
    instanceId: "publisher-a",
    revision: 1,
    stackKey: "global:work",
    profileKey: "project:reviewer",
    projectKey: PROJECT_KEY,
    ...overrides,
  };
}

describe("pi extension Forge appearance consumer", () => {
  it("normalizes a valid event and drops extra keys/secret-shaped fields", () => {
    const context = core.normalizeForgeAppearanceEvent(snapshot({
      stackKey: "global:work",
      profileKey: null,
      projectKey: null,
      prompt: "SECRET",
      cwd: "/home/secret",
    }));
    assert.deepStrictEqual(context, {
      schemaVersion: "1",
      source: "pi-forge",
      instanceId: "publisher-a",
      revision: 1,
      stackKey: "global:work",
      profileKey: null,
      projectKey: null,
    });
  });

  it("fails closed for malformed/oversized/unknown-version input", () => {
    assert.strictEqual(core.normalizeForgeAppearanceEvent(null), null);
    assert.strictEqual(core.normalizeForgeAppearanceEvent({ ...snapshot(), schemaVersion: "2" }), null);
    assert.strictEqual(core.normalizeForgeAppearanceEvent({ ...snapshot(), revision: "1" }), null);
    assert.strictEqual(core.normalizeForgeAppearanceEvent({ ...snapshot(), revision: -1 }), null);
    assert.strictEqual(core.normalizeForgeAppearanceEvent({ ...snapshot(), instanceId: "x".repeat(200) }), null);
    assert.strictEqual(core.normalizeForgeAppearanceEvent({ ...snapshot(), stackKey: "global:" }), null);
    assert.strictEqual(core.normalizeForgeAppearanceEvent({ ...snapshot(), projectKey: "A".repeat(64) }), null);
    // A project-scoped key without a project key fails closed instead of
    // being forwarded as a global-looking binding.
    assert.strictEqual(core.normalizeForgeAppearanceEvent(snapshot({
      stackKey: "project:app",
      projectKey: null,
    })), null);
  });

  it("normalizes Forge raw session ids into the canonical Pi namespace", () => {
    assert.strictEqual(core.normalizeForgeSessionId("abc-123"), "pi:abc-123");
    assert.strictEqual(core.normalizeForgeSessionId("pi:abc-123"), "pi:abc-123");
    assert.strictEqual(core.normalizeForgeSessionId("default"), null);
    assert.strictEqual(core.normalizeForgeSessionId(""), null);
    assert.strictEqual(core.normalizeForgeSessionId("bad\nid"), null);
  });

  it("rejects wrong session, duplicate/stale revisions, and retired instances", () => {
    const bus = makeBus();
    const updates = [];
    const consumer = core.createForgeAppearanceConsumer({
      pi: { events: bus },
      getCanonicalSessionId: () => "pi:session-1",
      getRequestSessionId: () => "session-1",
      onAppearance: (context) => updates.push(context),
    });

    bus.emit(core.FORGE_ACTIVE_STATE_CHANNEL, snapshot({ sessionId: "other", revision: 1 }));
    assert.strictEqual(updates.length, 0, "wrong session must be dropped");

    bus.emit(core.FORGE_ACTIVE_STATE_CHANNEL, snapshot({ revision: 5 }));
    bus.emit(core.FORGE_ACTIVE_STATE_CHANNEL, snapshot({ revision: 5 }));
    bus.emit(core.FORGE_ACTIVE_STATE_CHANNEL, snapshot({ revision: 4 }));
    assert.deepStrictEqual(updates.map((c) => c.revision), [5], "duplicate/stale revisions must be dropped");

    bus.emit(core.FORGE_ACTIVE_STATE_CHANNEL, snapshot({ instanceId: "publisher-b", revision: 1 }));
    assert.strictEqual(updates.length, 2);
    // publisher-a is now retired: a late replay must not be accepted.
    bus.emit(core.FORGE_ACTIVE_STATE_CHANNEL, snapshot({ instanceId: "publisher-a", revision: 9 }));
    assert.strictEqual(updates.length, 2, "retired instance must stay rejected");
    consumer.dispose();
  });

  it("requests a snapshot after subscribing so a Forge-first publisher answers", () => {
    const bus = makeBus();
    const requests = [];
    bus.on(core.FORGE_ACTIVE_STATE_REQUEST_CHANNEL, (request) => {
      requests.push(request);
      // Forge was already initialized: answer the late subscriber synchronously.
      bus.emit(core.FORGE_ACTIVE_STATE_CHANNEL, snapshot({ revision: 7 }));
    });
    const updates = [];
    const consumer = core.createForgeAppearanceConsumer({
      pi: { events: bus },
      getCanonicalSessionId: () => "pi:session-1",
      getRequestSessionId: () => "session-1",
      onAppearance: (context) => updates.push(context),
    });
    consumer.requestSnapshot();
    assert.deepStrictEqual(requests, [{ schemaVersion: "1", sessionId: "session-1" }]);
    assert.deepStrictEqual(updates.map((c) => c.revision), [7]);
    consumer.dispose();
  });

  it("requires pi.events and degrades to a no-op when Forge is absent", () => {
    const consumer = core.createForgeAppearanceConsumer({ pi: {} });
    assert.strictEqual(consumer.getContext(), null);
    assert.strictEqual(consumer.requestSnapshot(), false);
    consumer.dispose();
  });
});

describe("pi extension Forge appearance ordering and metadata refresh", () => {
  const flush = () => new Promise(resolve => setImmediate(resolve));
  function attachHarness(bus) {
    const handlers = {};
    const posts = [];
    const pi = {
      on(name, handler) { handlers[name] = handler; },
      events: bus,
    };
    const attached = core.attach(pi, {
      shouldReport: () => true,
      // Default core.buildPayload keeps appearance_context on the wire.
      postState: async (payload) => { posts.push(payload); return true; },
    });
    return { handlers, posts, attached };
  }

  it("Forge-first: the startup request answers synchronously and SessionStart carries context", async () => {
    const bus = makeBus();
    bus.on(core.FORGE_ACTIVE_STATE_REQUEST_CHANNEL, () => {
      bus.emit(core.FORGE_ACTIVE_STATE_CHANNEL, snapshot({ revision: 3 }));
    });
    const { handlers, posts } = attachHarness(bus);

    handlers.session_start({ type: "session_start" }, makeCtx());
    await flush();
    const events = posts.map((p) => p.event);
    assert.ok(events.includes("SessionStart"), `expected SessionStart among ${events.join(",")}`);
    const start = posts.find((p) => p.event === "SessionStart");
    assert.strictEqual(start.appearance_context.source, "pi-forge");
    assert.strictEqual(start.appearance_context.revision, 3);
  });

  it("Forge-later: a live bus event triggers a metadata-only SessionUpdate", async () => {
    const bus = makeBus();
    const { handlers, posts } = attachHarness(bus);
    handlers.session_start({ type: "session_start" }, makeCtx());
    await flush();
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].appearance_context, null, "startup clears any retained context when Forge is absent");

    bus.emit(core.FORGE_ACTIVE_STATE_CHANNEL, snapshot({ revision: 4, stackKey: "project:app" }));
    await flush();
    assert.strictEqual(posts.length, 2);
    const update = posts[1];
    assert.strictEqual(update.event, "SessionUpdate");
    assert.strictEqual(update.metadata_only, true);
    assert.strictEqual(update.appearance_context.revision, 4);
    assert.strictEqual(update.state, "idle");
  });

  it("does not clear prior context on ordinary updates and clears on real shutdown", async () => {
    const bus = makeBus();
    const { handlers, posts } = attachHarness(bus);
    handlers.session_start({ type: "session_start" }, makeCtx());
    bus.emit(core.FORGE_ACTIVE_STATE_CHANNEL, snapshot({ revision: 4 }));
    handlers.before_agent_start({ type: "before_agent_start" }, makeCtx());
    await flush();
    const promptPost = posts[posts.length - 1];
    assert.strictEqual(promptPost.event, "UserPromptSubmit");
    assert.strictEqual(promptPost.appearance_context.revision, 4, "ordinary event preserves context");

    await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, makeCtx());
    const endPost = posts[posts.length - 1];
    assert.strictEqual(endPost.event, "SessionEnd");
    assert.strictEqual(endPost.appearance_context, null, "real disposal clears context");
  });

  it("converges a reload with no Forge to an explicit clear and still accepts late publisher events", async () => {
    const bus = makeBus();
    let forgeAvailable = true;
    bus.on(core.FORGE_ACTIVE_STATE_REQUEST_CHANNEL, () => {
      if (!forgeAvailable) return;
      bus.emit(core.FORGE_ACTIVE_STATE_CHANNEL, snapshot({ revision: 3 }));
    });
    const { handlers, posts, attached } = attachHarness(bus);

    handlers.session_start({ type: "session_start", reason: "startup" }, makeCtx());
    assert.strictEqual(attached.getAppearanceContext().revision, 3);

    forgeAvailable = false;
    handlers.session_shutdown({ type: "session_shutdown", reason: "reload" }, makeCtx());
    assert.strictEqual(posts.some((post) => post.event === "SessionEnd"), false, "reload must not retire the session");

    handlers.session_start({ type: "session_start", reason: "reload" }, makeCtx());
    await flush();
    const reloadStart = [...posts].reverse().find((post) => post.event === "SessionStart");
    assert.strictEqual(reloadStart.appearance_context, null, "unavailable Forge must clear the old binding");
    assert.strictEqual(attached.getAppearanceContext(), null);

    // The consumer remains subscribed: a late publisher event is accepted and
    // reaches Clawd through the existing metadata-only channel, not a wake or
    // business-state update.
    bus.emit(core.FORGE_ACTIVE_STATE_CHANNEL, snapshot({ revision: 5, instanceId: "publisher-b" }));
    await flush();
    const lateUpdate = posts[posts.length - 1];
    assert.strictEqual(lateUpdate.event, "SessionUpdate");
    assert.strictEqual(lateUpdate.metadata_only, true);
    assert.strictEqual(lateUpdate.appearance_context.revision, 5);
    assert.strictEqual(attached.getAppearanceContext().revision, 5);
  });

  it("does not leak a previous session's appearance across a real session switch", async () => {
    const bus = makeBus();
    const { handlers, posts } = attachHarness(bus);
    handlers.session_start({ type: "session_start", reason: "startup" }, makeCtx());
    bus.emit(core.FORGE_ACTIVE_STATE_CHANNEL, snapshot({ revision: 2 }));

    const ctxB = makeCtx({ sessionManager: { getSessionId: () => "session-2" } });
    handlers.session_start({ type: "session_start", reason: "new" }, ctxB);
    await flush();
    const startB = [...posts].reverse().find((p) => p.event === "SessionStart");
    assert.strictEqual(startB.session_id, "pi:session-2");
    assert.strictEqual(startB.appearance_context, null, "new session must not inherit old binding");

    handlers.before_agent_start({ type: "before_agent_start" }, ctxB);
    await flush();
    assert.strictEqual(posts[posts.length - 1].appearance_context, null);
  });
});

it('serializes appearance-bearing HTTP packets so an unseen old epoch cannot arrive after its successor', async () => {
  const bus=makeBus(),handlers={},posts=[];let unblock;
  const attached=core.attach({events:bus,on:(n,f)=>{handlers[n]=f;}},{shouldReport:()=>true,postState:payload=>{posts.push(payload);return posts.length===1?new Promise(r=>{unblock=r;}):Promise.resolve(true);}});
  try {
    handlers.session_start({reason:'startup'},makeCtx());
    await new Promise(r=>setImmediate(r));
    bus.emit(core.FORGE_ACTIVE_STATE_CHANNEL,snapshot({instanceId:'old_a',revision:9}));
    bus.emit(core.FORGE_ACTIVE_STATE_CHANNEL,snapshot({instanceId:'new_b',revision:1}));
    await new Promise(r=>setImmediate(r));
    assert.equal(posts.length,1,'successor must wait for its predecessor delivery');
    unblock(true);await new Promise(r=>setImmediate(r));
    assert.deepEqual(posts.map(p=>p.appearance_context?.instanceId||null),[null,'old_a','new_b']);
  } finally {attached.stopHeartbeat();handlers.session_shutdown({reason:'reload'},makeCtx());}
});
