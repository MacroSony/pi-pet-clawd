#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { asarUnpackedPath, writeJsonAtomic } = require("./json-utils");
const serverConfig = require("./server-config");
const { resolveNodeBin } = serverConfig;

const EXTENSION_DIR_NAME = "clawd-on-desk";
const EXTENSION_FILE = "index.ts";
const CORE_FILE = "pi-extension-core.js";
const SERVER_CONFIG_FILE = "server-config.js";
const REMOTE_IDENTITY_FILE = serverConfig.REMOTE_IDENTITY_FILENAME;
const MARKER_FILE = ".clawd-managed.json";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".pi", "agent");
const DEFAULT_EXTENSIONS_DIR = path.join(DEFAULT_PARENT_DIR, "extensions");
const DEFAULT_EXTENSION_DIR = path.join(DEFAULT_EXTENSIONS_DIR, EXTENSION_DIR_NAME);

function resolveSourcePath(fileName, baseDir = __dirname) {
  return asarUnpackedPath(path.resolve(baseDir, fileName));
}

function writeTextAtomic(filePath, text, options = {}) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  const mode = Number.isInteger(options.mode) ? options.mode : null;
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmpPath, text, mode == null ? "utf8" : { encoding: "utf8", mode });
    if (mode != null) fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, filePath);
    if (mode != null) fs.chmodSync(filePath, mode);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

function fileExists(filePath, fsImpl = fs) {
  try {
    return fsImpl.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function dirExists(dirPath, fsImpl = fs) {
  try {
    return fsImpl.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readJsonIfPresent(filePath, fsImpl = fs) {
  try {
    const raw = fsImpl.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isManagedMarker(value) {
  return !!(
    value
    && value.app === "clawd-on-desk"
    && value.integration === "pi"
    && value.managed === true
  );
}

function remoteInstallEnabled(options = {}) {
  if (typeof options.remote === "boolean") return options.remote;
  const env = options.env || process.env;
  return !!(env && env.CLAWD_SSH_REMOTE && !/^(0|false)$/i.test(String(env.CLAWD_SSH_REMOTE)));
}

function resolveRemoteIdentity(options = {}) {
  if (!remoteInstallEnabled(options)) return null;
  const identity = serverConfig.readRemoteIdentity({
    env: options.env || process.env,
    remoteIdentityPath: options.remoteIdentityPath,
  });
  if (!identity || identity.ok !== true) {
    const reason = identity && identity.reason ? identity.reason : "identity-invalid";
    throw new Error(`Clawd: remote Pi installation requires a valid secure identity (${reason})`);
  }
  return identity;
}

function serializeRemoteIdentity(identity) {
  return JSON.stringify({
    version: identity.version,
    layoutVersion: identity.layoutVersion,
    runtimeKey: identity.runtimeKey,
    profileId: identity.profileId,
    installId: identity.installId,
    remotePort: identity.remotePort,
    routingNonce: identity.routingNonce,
    deployedAt: identity.deployedAt,
  }) + "\n";
}

function buildRemoteOwnership(identity) {
  if (!identity || identity.ok !== true) return null;
  return {
    installId: identity.installId,
    profileId: identity.profileId,
    runtimeKey: identity.runtimeKey,
    layoutVersion: identity.layoutVersion,
  };
}

function remoteOwnershipMatches(marker, identity) {
  const expected = buildRemoteOwnership(identity);
  const actual = marker && marker.remote;
  return !!(expected && actual
    && actual.installId === expected.installId
    && actual.profileId === expected.profileId
    && actual.runtimeKey === expected.runtimeKey
    && actual.layoutVersion === expected.layoutVersion);
}

function buildMarker(options = {}) {
  const marker = {
    app: "clawd-on-desk",
    integration: "pi",
    managed: true,
    version: 1,
    installedAt: new Date().toISOString(),
  };
  const remote = buildRemoteOwnership(options.remoteIdentity);
  if (remote) marker.remote = remote;
  return marker;
}

function commandExists(command, args, options = {}) {
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  try {
    const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;
    const raw = execFileSync(command, args, {
      encoding: "utf8",
      timeout,
      windowsHide: true,
    });
    return String(raw || "").trim().length > 0;
  } catch {
    return false;
  }
}

function executableExists(filePath, platform, accessSync = fs.accessSync) {
  try {
    accessSync(filePath, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasPiCommand(options = {}) {
  if (typeof options.piCommandAvailable === "boolean") return options.piCommandAvailable;
  if (typeof options.piCommandAvailable === "function") return !!options.piCommandAvailable();

  const platform = options.platform || process.platform;
  const accessSync = options.accessSync || fs.accessSync;
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  const nodeBin = Object.prototype.hasOwnProperty.call(options, "nodeBin")
    ? options.nodeBin
    : resolveNodeBin({ platform, execFileSync, accessSync });

  if (nodeBin && nodeBin !== "node") {
    const nodeDir = path.dirname(nodeBin);
    const candidates = platform === "win32"
      ? ["pi.cmd", "pi.exe", "pi.ps1"]
      : ["pi"];
    if (candidates.some((name) => executableExists(path.join(nodeDir, name), platform, accessSync))) {
      return true;
    }
  }

  if (platform === "win32") {
    return commandExists("where", ["pi"], { execFileSync });
  }

  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    if (commandExists(shell, ["-lic", "command -v pi"], { execFileSync })) return true;
  }
  return commandExists("sh", ["-lc", "command -v pi"], { execFileSync });
}

function resolveExtensionDir(options = {}) {
  return options.extensionDir || path.join(options.parentDir || DEFAULT_PARENT_DIR, "extensions", EXTENSION_DIR_NAME);
}

function readSourceFiles(options = {}) {
  const sourceDir = options.sourceDir || __dirname;
  const extensionPath = options.extensionSourcePath || resolveSourcePath("pi-extension.ts", sourceDir);
  const corePath = options.coreSourcePath || resolveSourcePath(CORE_FILE, sourceDir);
  const serverConfigPath = options.serverConfigSourcePath || resolveSourcePath(SERVER_CONFIG_FILE, sourceDir);
  return {
    extensionPath,
    corePath,
    serverConfigPath,
    extensionText: fs.readFileSync(extensionPath, "utf8"),
    coreText: fs.readFileSync(corePath, "utf8"),
    serverConfigText: fs.readFileSync(serverConfigPath, "utf8"),
  };
}

function registerPiExtension(options = {}) {
  const fsImpl = options.fs || fs;
  const parentDir = options.parentDir || DEFAULT_PARENT_DIR;
  const extensionDir = resolveExtensionDir(options);
  const markerPath = path.join(extensionDir, MARKER_FILE);
  const extensionPath = path.join(extensionDir, EXTENSION_FILE);
  const corePath = path.join(extensionDir, CORE_FILE);
  const serverConfigPath = path.join(extensionDir, SERVER_CONFIG_FILE);
  const remoteIdentityPath = path.join(extensionDir, REMOTE_IDENTITY_FILE);
  const remoteIdentity = resolveRemoteIdentity(options);

  const parentExists = dirExists(parentDir, fsImpl);
  if (!parentExists && !hasPiCommand(options)) {
    if (!options.silent) {
      console.log("Clawd: Pi not found - skipping Pi extension registration");
    }
    return { installed: false, skipped: true, updated: false, reason: "pi-not-found", extensionDir };
  }

  const extensionExists = dirExists(extensionDir, fsImpl);
  const existingMarker = extensionExists ? readJsonIfPresent(markerPath, fsImpl) : null;
  if (extensionExists && !isManagedMarker(existingMarker)) {
    if (!options.silent) {
      console.log(`Clawd: ${extensionDir} exists but is not Clawd-managed - skipping`);
    }
    return { installed: false, skipped: true, updated: false, reason: "unmanaged-existing-extension", extensionDir };
  }
  if (remoteIdentity && existingMarker && existingMarker.remote
    && !remoteOwnershipMatches(existingMarker, remoteIdentity)) {
    if (!options.silent) {
      console.log(`Clawd: ${extensionDir} belongs to another remote profile - skipping`);
    }
    return { installed: false, skipped: true, updated: false, reason: "remote-ownership-mismatch", extensionDir };
  }

  const { extensionText, coreText, serverConfigText } = readSourceFiles(options);
  const previousExtension = fileExists(extensionPath, fsImpl) ? fsImpl.readFileSync(extensionPath, "utf8") : null;
  const previousCore = fileExists(corePath, fsImpl) ? fsImpl.readFileSync(corePath, "utf8") : null;
  const previousServerConfig = fileExists(serverConfigPath, fsImpl) ? fsImpl.readFileSync(serverConfigPath, "utf8") : null;
  const remoteIdentityText = remoteIdentity ? serializeRemoteIdentity(remoteIdentity) : null;
  const previousRemoteIdentity = remoteIdentity && fileExists(remoteIdentityPath, fsImpl)
    ? fsImpl.readFileSync(remoteIdentityPath, "utf8")
    : null;
  const updated = previousExtension !== extensionText
    || previousCore !== coreText
    || previousServerConfig !== serverConfigText
    || (remoteIdentityText !== null && previousRemoteIdentity !== remoteIdentityText);

  fsImpl.mkdirSync(extensionDir, { recursive: true });
  // The secure identity is 0600; make its containing extension private as
  // well so another account cannot replace the file through the directory.
  if (remoteIdentity) fsImpl.chmodSync(extensionDir, 0o700);
  writeTextAtomic(extensionPath, extensionText);
  writeTextAtomic(corePath, coreText);
  writeTextAtomic(serverConfigPath, serverConfigText);
  if (remoteIdentityText !== null) {
    writeTextAtomic(remoteIdentityPath, remoteIdentityText, { mode: 0o600 });
  }
  writeJsonAtomic(markerPath, buildMarker({ remoteIdentity }));

  if (!options.silent) {
    console.log(`Clawd Pi extension -> ${extensionDir}`);
    console.log(updated ? "  Installed or updated" : "  Already up to date");
  }

  return { installed: true, skipped: false, updated, extensionDir };
}

function unregisterPiExtension(options = {}) {
  const fsImpl = options.fs || fs;
  const extensionDir = resolveExtensionDir(options);
  const markerPath = path.join(extensionDir, MARKER_FILE);
  const marker = readJsonIfPresent(markerPath, fsImpl);
  const remoteIdentity = resolveRemoteIdentity(options);
  if (!dirExists(extensionDir, fsImpl)) {
    if (!options.silent) console.log("Clawd: Pi extension is not installed");
    return { removed: false, skipped: true, reason: "missing", extensionDir };
  }
  if (!isManagedMarker(marker)) {
    if (!options.silent) console.log(`Clawd: ${extensionDir} is not Clawd-managed - skipping uninstall`);
    return { removed: false, skipped: true, reason: "unmanaged-existing-extension", extensionDir };
  }
  if (remoteIdentity && !remoteOwnershipMatches(marker, remoteIdentity)) {
    if (!options.silent) console.log(`Clawd: ${extensionDir} belongs to another remote profile - skipping uninstall`);
    return { removed: false, skipped: true, reason: "remote-ownership-mismatch", extensionDir };
  }
  fsImpl.rmSync(extensionDir, { recursive: true, force: true });
  if (!options.silent) console.log(`Clawd: removed Pi extension from ${extensionDir}`);
  return { removed: true, skipped: false, extensionDir };
}

module.exports = {
  CORE_FILE,
  DEFAULT_EXTENSION_DIR,
  DEFAULT_EXTENSIONS_DIR,
  DEFAULT_PARENT_DIR,
  EXTENSION_DIR_NAME,
  EXTENSION_FILE,
  MARKER_FILE,
  REMOTE_IDENTITY_FILE,
  SERVER_CONFIG_FILE,
  buildMarker,
  buildRemoteOwnership,
  hasPiCommand,
  isManagedMarker,
  remoteOwnershipMatches,
  registerPiExtension,
  resolveExtensionDir,
  resolveRemoteIdentity,
  resolveSourcePath,
  unregisterPiExtension,
  writeTextAtomic,
};

if (require.main === module) {
  try {
    const remote = process.argv.includes("--remote");
    const json = process.argv.includes("--json");
    const options = { remote, silent: json || process.argv.includes("--silent") };
    const result = process.argv.includes("--uninstall")
      ? unregisterPiExtension(options)
      : registerPiExtension(options);
    if (json) console.log(JSON.stringify(result));
    // A Remote SSH deployment must not mistake a preserved third-party or
    // foreign-profile extension for a successful Pi integration.
    if (remote && result && result.skipped
      && result.reason !== "pi-not-found"
      && result.reason !== "missing") {
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
  }
}
