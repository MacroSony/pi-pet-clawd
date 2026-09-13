"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT,
  REMOTE_RUNTIME_MODE_PROFILE_ISOLATED,
  ACCOUNT_DEFAULT_RUNTIME_KEY,
  REMOTE_LAYOUT_VERSION,
  normalizeRemoteRuntimeIdentity,
  resolveRemoteRuntimeLayout,
  collectRemoteLayoutPathSet,
} = require("../src/remote-ssh-layout");

test("account-default layout normalizes the reserved runtime key and covers every live path", () => {
  const layout = resolveRemoteRuntimeLayout({
    runtimeMode: REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT,
    runtimeKey: "ignored-copy-of-profile-id",
    remoteHome: "/home/alice",
  });
  assert.deepEqual(layout, {
    runtimeMode: "account-default",
    runtimeKey: ACCOUNT_DEFAULT_RUNTIME_KEY,
    layoutVersion: REMOTE_LAYOUT_VERSION,
    remoteHome: "/home/alice",
    runtimeRoot: "/home/alice",
    claudeConfigDir: "/home/alice/.claude",
    claudeHooksDir: "/home/alice/.claude/hooks",
    claudeSettingsFile: "/home/alice/.claude/settings.json",
    codexHome: "/home/alice/.codex",
    codexSessionsDir: "/home/alice/.codex/sessions",
    copilotHome: "/home/alice/.copilot",
    piAgentDir: "/home/alice/.pi/agent",
    piExtensionDir: "/home/alice/.pi/agent/extensions/clawd-on-desk",
    piExtensionMarkerFile: "/home/alice/.pi/agent/extensions/clawd-on-desk/.clawd-managed.json",
    piRemoteIdentityFile: "/home/alice/.pi/agent/extensions/clawd-on-desk/clawd-remote.json",
    clawdStateDir: "/home/alice/.clawd",
    binDir: null,
    wrapperEvidenceDir: null,
    bootstrapOwnerFile: null,
    claudeWrapperFile: null,
    codexWrapperFile: null,
    copilotWrapperFile: null,
    claudeWrapperEvidenceFile: null,
    codexWrapperEvidenceFile: null,
    copilotWrapperEvidenceFile: null,
    identityFile: "/home/alice/.claude/hooks/clawd-remote.json",
    secureMarkerFile: "/home/alice/.claude/hooks/clawd-ssh-secure-v1",
    hostPrefixFile: "/home/alice/.claude/hooks/clawd-host-prefix",
    statuslineSidecarFile: "/home/alice/.claude/hooks/clawd-statusline-chain.json",
    lastLogFile: "/home/alice/.clawd/remote-last-error.log",
    deployLockDir: "/home/alice/.clawd-remote-deploy-account-default.lock",
    deployStagingDir: "/home/alice/.clawd/remote-deploy-staging",
    monitorPidFile: "/home/alice/.clawd/codex-monitor.pid",
    legacyMonitorPidFile: "/home/alice/.clawd-codex-monitor.pid",
  });
  assert.equal(Object.isFrozen(layout), true);
  assert.equal(layout.hostPrefixFile.startsWith(`${layout.claudeHooksDir}/`), true);
  assert.equal(layout.statuslineSidecarFile.startsWith(`${layout.claudeHooksDir}/`), true);
});

test("profile-isolated layout keeps profile-local paths inside its runtime root and Pi paths account-global", () => {
  const layout = resolveRemoteRuntimeLayout({
    runtimeMode: REMOTE_RUNTIME_MODE_PROFILE_ISOLATED,
    runtimeKey: "rt_A7x-19",
    remoteHome: "/srv/users/shared",
  });
  assert.equal(layout.runtimeRoot, "/srv/users/shared/.clawd/profiles/rt_A7x-19");
  assert.equal(layout.claudeConfigDir, `${layout.runtimeRoot}/claude`);
  assert.equal(layout.codexHome, `${layout.runtimeRoot}/codex`);
  assert.equal(layout.copilotHome, `${layout.runtimeRoot}/copilot`);
  assert.equal(layout.clawdStateDir, `${layout.runtimeRoot}/clawd`);
  assert.equal(layout.legacyMonitorPidFile, null);
  const accountGlobalPiPaths = new Set([
    layout.piAgentDir,
    layout.piExtensionDir,
    layout.piExtensionMarkerFile,
    layout.piRemoteIdentityFile,
  ]);
  for (const item of collectRemoteLayoutPathSet(layout)) {
    assert.equal(
      accountGlobalPiPaths.has(item)
        || item === layout.runtimeRoot
        || item.startsWith(`${layout.runtimeRoot}/`),
      true,
      `${item} escaped both the profile root and the intentional account-global Pi root`,
    );
  }
});

test("different isolated runtime keys share only intentional account-global Pi paths", () => {
  const a = resolveRemoteRuntimeLayout({
    runtimeMode: REMOTE_RUNTIME_MODE_PROFILE_ISOLATED,
    runtimeKey: "runtime_a",
    remoteHome: "/home/shared",
  });
  const b = resolveRemoteRuntimeLayout({
    runtimeMode: REMOTE_RUNTIME_MODE_PROFILE_ISOLATED,
    runtimeKey: "runtime_b",
    remoteHome: "/home/shared",
  });
  const aPaths = collectRemoteLayoutPathSet(a);
  const bPaths = collectRemoteLayoutPathSet(b);
  assert.deepEqual([...aPaths].filter((item) => bPaths.has(item)).sort(), [
    a.piAgentDir,
    a.piExtensionDir,
    a.piExtensionMarkerFile,
    a.piRemoteIdentityFile,
  ].sort());
});

test("layout rejects path escape and malformed runtime inputs", () => {
  for (const remoteHome of [
    "",
    "/",
    "relative/home",
    "/home/alice/..",
    "/home//alice",
    "/home/alice\nroot",
  ]) {
    assert.throws(() => resolveRemoteRuntimeLayout({
      runtimeMode: REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT,
      remoteHome,
    }));
  }
  for (const runtimeKey of [
    "",
    "account-default",
    "../escape",
    "has space",
    "host.example.com",
    "x".repeat(65),
  ]) {
    assert.throws(() => resolveRemoteRuntimeLayout({
      runtimeMode: REMOTE_RUNTIME_MODE_PROFILE_ISOLATED,
      runtimeKey,
      remoteHome: "/home/alice",
    }));
  }
  assert.throws(() => resolveRemoteRuntimeLayout({
    runtimeMode: "future-mode",
    runtimeKey: "safe",
    remoteHome: "/home/alice",
  }));
});

test("runtime identity defaults old profiles to account-default", () => {
  assert.deepEqual(normalizeRemoteRuntimeIdentity({}), {
    runtimeMode: REMOTE_RUNTIME_MODE_ACCOUNT_DEFAULT,
    runtimeKey: ACCOUNT_DEFAULT_RUNTIME_KEY,
  });
});
