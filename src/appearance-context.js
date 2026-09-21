"use strict";

// Trust-boundary normalization for the optional Pi Forge appearance context.
// Forge hands the Pi hook a raw event with sessionId + instanceId + revision
// + three opaque keys. The hook strips sessionId and labels the source before
// posting; Clawd re-validates here (never trust the hook's word) and rebuilds
// a closed allowlist so no extra key, nested object, path, prompt or token can
// ever reach session state, snapshots or the renderer status file.

const APPEARANCE_SCHEMA_VERSION = "1";
const APPEARANCE_SOURCE = "pi-forge";
// Scoped resource ids mirror Forge's own `^(global|project):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.
const APPEARANCE_SCOPED_KEY_RE = /^(global|project):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const APPEARANCE_PROJECT_KEY_RE = /^[0-9a-f]{64}$/;
const APPEARANCE_INSTANCE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// `null` is a valid scoped key (explicitly disabled/unbound); any other
// non-conforming value is invalid and must be rejected rather than coerced.
function normalizeScopedKey(value, projectKey) {
  if (value === null) return null;
  if (typeof value !== "string" || !APPEARANCE_SCOPED_KEY_RE.test(value)) return undefined;
  // A project-scoped resource is meaningless without a project key. Reject it
  // at the trust boundary rather than persisting an unbounded-looking key.
  if (value.startsWith("project:") && projectKey === null) return undefined;
  return value;
}

function normalizeProjectKey(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !APPEARANCE_PROJECT_KEY_RE.test(value)) return undefined;
  return value;
}

// Returns `{ ok: true, value: normalized|null }` or `{ ok: false, value: null }`.
// A `null` input is an explicit clear (ok). A malformed object fails closed
// (not ok) so callers can drop it without wiping an existing context.
function parseAppearanceContext(value) {
  if (value === null) return { ok: true, value: null };
  if (!isPlainObject(value)) return { ok: false, value: null };
  if (value.schemaVersion !== APPEARANCE_SCHEMA_VERSION || value.source !== APPEARANCE_SOURCE) {
    return { ok: false, value: null };
  }

  const instanceId = typeof value.instanceId === "string" && APPEARANCE_INSTANCE_ID_RE.test(value.instanceId)
    ? value.instanceId
    : undefined;
  const revision = Number.isSafeInteger(value.revision) && value.revision >= 0
    ? value.revision
    : undefined;
  const projectKey = normalizeProjectKey(value.projectKey);
  const stackKey = normalizeScopedKey(value.stackKey, projectKey);
  const profileKey = normalizeScopedKey(value.profileKey, projectKey);

  if (
    instanceId === undefined
    || revision === undefined
    || stackKey === undefined
    || profileKey === undefined
    || projectKey === undefined
  ) {
    return { ok: false, value: null };
  }

  return {
    ok: true,
    value: {
      schemaVersion: APPEARANCE_SCHEMA_VERSION,
      source: APPEARANCE_SOURCE,
      instanceId,
      revision,
      stackKey,
      profileKey,
      projectKey,
    },
  };
}

module.exports = {
  APPEARANCE_SCHEMA_VERSION,
  APPEARANCE_SOURCE,
  APPEARANCE_SCOPED_KEY_RE,
  APPEARANCE_PROJECT_KEY_RE,
  parseAppearanceContext,
};
