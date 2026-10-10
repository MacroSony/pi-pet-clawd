"use strict";

// Optional service forwarding is deliberately NOT part of the required -R
// child: ExitOnForwardFailure=yes would otherwise let a busy local port kill
// the pet relay. Retry this child independently; never change relay status.
function createLocalForwarder(deps) {
  const schedule = deps.setTimeout || setTimeout;
  const cancel = deps.clearTimeout || clearTimeout;
  let stopped = true;
  let child = null;
  let timer = null;
  let attempt = 0;
  const notify = (status, message) => deps.onStatus({ status, ...(message ? { message } : {}) });

  function retry(message) {
    if (stopped || timer !== null) return;
    notify("retrying", message);
    timer = schedule(() => {
      timer = null;
      if (!stopped) launch();
    }, Math.min(300000, 5000 * (2 ** Math.min(attempt++, 6))));
  }

  function launch() {
    if (stopped || child) return;
    notify("starting");
    let current;
    try {
      current = deps.spawn("ssh", deps.buildArgs(), {
        env: { ...process.env, LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (_) {
      retry("Optional local-forward SSH could not start");
      return;
    }
    child = current;
    let stderr = "";
    if (current.stderr) current.stderr.on("data", (chunk) => {
      if (child === current) stderr = (stderr + chunk.toString()).slice(-2048);
    });
    current.on("spawn", () => {
      // Process started is NOT proof that the remote service is reachable.
      if (child === current && !stopped) notify("running");
    });
    current.on("error", () => {
      if (child !== current || stopped) return;
      child = null;
      try { current.kill(); } catch {}
      retry("Optional local-forward SSH process error");
    });
    current.on("exit", () => {
      if (child !== current || stopped) return;
      child = null;
      retry(/address already in use|cannot listen|bind.*failed/i.test(stderr)
        ? "Optional local port is busy; pet relay is unaffected"
        : "Optional local-forward SSH exited; pet relay is unaffected");
    });
  }

  return {
    start() { if (!stopped) return; stopped = false; launch(); },
    stop() {
      stopped = true;
      if (timer !== null) cancel(timer);
      timer = null;
      const owned = child;
      child = null; // Ignore late exit/error from a retired connection.
      if (owned) { try { owned.kill(); } catch {} }
    },
  };
}

module.exports = { createLocalForwarder };
