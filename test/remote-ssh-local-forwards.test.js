"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createLocalForwarder } = require("../src/remote-ssh-local-forwards");

function harness() {
  const children = [], pending = new Map(), statuses = [];
  let id = 0;
  const deps = {
    buildArgs: () => ["-N", "example"],
    spawn: () => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => { child.killed = true; };
      children.push(child);
      return child;
    },
    setTimeout: (cb, ms) => { pending.set(++id, { cb, ms }); return id; },
    clearTimeout: (key) => pending.delete(key),
    onStatus: (value) => statuses.push(value),
  };
  return { deps, children, pending, statuses };
}

test("forwarder error and late exit schedule exactly one independent retry", () => {
  const h = harness(), f = createLocalForwarder(h.deps);
  f.start(); f.start();
  assert.equal(h.children.length, 1);
  const child = h.children[0];
  child.emit("spawn");
  assert.equal(h.statuses.at(-1).status, "running");
  child.emit("error", new Error("test"));
  child.emit("exit", 255);
  assert.equal(h.pending.size, 1);
  assert.ok(child.killed);
  f.stop();
  assert.equal(h.pending.size, 0);
});

test("forwarder bounded backoff and stop gate stale timer callbacks", () => {
  const h = harness(), f = createLocalForwarder(h.deps);
  f.start();
  const delays = [];
  let stale;
  for (let i = 0; i < 9; i++) {
    h.children.at(-1).emit("exit", 255);
    const [key, timer] = [...h.pending.entries()][0];
    delays.push(timer.ms); stale = timer.cb;
    h.pending.delete(key); timer.cb();
  }
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
  const count = h.children.length;
  f.stop(); stale();
  assert.equal(h.children.length, count);
  assert.ok(h.children.at(-1).killed);
});

test("forwarder does not leak or expose raw SSH diagnostics", () => {
  const h = harness(), f = createLocalForwarder(h.deps);
  f.start();
  h.children[0].stderr.emit("data", Buffer.from("private-key-path and hostname: cannot listen to port"));
  h.children[0].emit("exit", 255);
  assert.equal(h.statuses.at(-1).message, "Optional local port is busy; pet relay is unaffected");
  assert.ok(!JSON.stringify(h.statuses).includes("private-key-path"));
  f.stop();
});
