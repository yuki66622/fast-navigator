"use strict";
/* Pure-logic tests for the generic page-action layer against a tiny fake DOM:
 * adapter/URL routing, ambiguity, not-found, structure-changed, blocked,
 * click→wait success with trace, and timeout. Full-page-flow behaviour is
 * covered in tests/integration/flow-actions.test.js on the real mock page. */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runAction, listActions } = require("../../extension/core/actions.js");

function makeEl(opts) {
  opts = opts || {};
  const el = {
    _attrs: opts.attrs || {},
    textContent: opts.text || "",
    hidden: !!opts.hidden,
    clicks: 0,
    _map: opts.map || {},
    getClientRects() { return opts.invisible ? [] : [{ width: 10, height: 10 }]; },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    click() { this.clicks++; if (opts.onClick) opts.onClick(); },
    querySelectorAll(sel) { return (this._map[sel] || []).slice(); },
    querySelector(sel) { return (this._map[sel] || [])[0] || null; },
    closest() { return opts.closest || null; },
  };
  return el;
}

function makeEnv(map, url) {
  const win = {
    location: { href: url || "https://mock/" },
    getComputedStyle() { return { visibility: "visible", display: "block" }; },
    requestAnimationFrame(cb) { cb(); },
  };
  const doc = {
    _map: map,
    location: win.location,
    defaultView: win,
    querySelectorAll(sel) { return (this._map[sel] || []).slice(); },
    querySelector(sel) { return (this._map[sel] || [])[0] || null; },
  };
  for (const k in map) for (const e of map[k]) e.ownerDocument = doc;
  return { doc, win };
}

function adapter(actions, extra) {
  return Object.assign({ adapterId: "test", matches: () => true, actions: actions || {} }, extra || {});
}

const now = () => Date.now();

test("no adapter -> no-adapter", async () => {
  const { doc, win } = makeEnv({});
  const r = await runAction({ adapter: null, name: "x", doc, win, now });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-adapter");
});

test("adapter does not own the page -> wrong-page", async () => {
  const { doc, win } = makeEnv({});
  const r = await runAction({ adapter: adapter({ foo: async () => ({}) }, { matches: () => false }), name: "foo", doc, win, now });
  assert.equal(r.reason, "wrong-page");
});

test("unknown action lists what is available", async () => {
  const { doc, win } = makeEnv({});
  const r = await runAction({ adapter: adapter({ a: async () => ({}), b: async () => ({}) }), name: "nope", doc, win, now });
  assert.equal(r.reason, "unknown-action");
  assert.deepEqual(r.detail.available.sort(), ["a", "b"]);
});

test("blocked (login/captcha) stops before running", async () => {
  const { doc, win } = makeEnv({});
  let ran = false;
  const a = adapter({ go: async () => { ran = true; return {}; } }, { detectBlockers: () => "captcha" });
  const r = await runAction({ adapter: a, name: "go", doc, win, now });
  assert.equal(r.reason, "blocked");
  assert.equal(r.detail.blocker, "captcha");
  assert.equal(ran, false, "action body must not run when blocked");
});

test("unique element: click then wait for completion, success with trace", async () => {
  let ready = false;
  const btn = makeEl({ attrs: { "data-go": "" }, onClick: () => { ready = true; } });
  const { doc, win } = makeEnv({ '[data-go]': [btn] });
  const a = adapter({
    go: async ({ h }) => {
      const b = h.unique('[data-go]', { describe: "go button" });
      h.click(b, "go");
      await h.waitFor(() => ready, { describe: "ready", timeout: 1000 });
      return { clicked: b.clicks };
    },
  });
  const r = await runAction({ adapter: a, name: "go", doc, win, now });
  assert.equal(r.ok, true);
  assert.equal(r.status, "success");
  assert.equal(r.result.clicked, 1);
  const steps = r.trace.map((t) => t.step);
  assert.ok(steps.includes("resolve") && steps.includes("click") && steps.includes("wait"), JSON.stringify(steps));
  assert.equal(typeof r.ms, "number");
});

test("two matches -> ambiguous, nothing clicked", async () => {
  const b1 = makeEl({ attrs: { "data-go": "" } });
  const b2 = makeEl({ attrs: { "data-go": "" } });
  const { doc, win } = makeEnv({ '[data-go]': [b1, b2] });
  const a = adapter({ go: async ({ h }) => { const b = h.unique('[data-go]'); h.click(b); return {}; } });
  const r = await runAction({ adapter: a, name: "go", doc, win, now });
  assert.equal(r.reason, "ambiguous");
  assert.equal(r.detail.count, 2);
  assert.equal(b1.clicks + b2.clicks, 0, "must not click when ambiguous");
});

test("zero matches -> not-found", async () => {
  const { doc, win } = makeEnv({});
  const a = adapter({ go: async ({ h }) => { h.unique('[data-go]'); return {}; } });
  const r = await runAction({ adapter: a, name: "go", doc, win, now });
  assert.equal(r.reason, "not-found");
});

test("missing structural anchor -> structure-changed", async () => {
  const { doc, win } = makeEnv({});
  const a = adapter({ go: async ({ h }) => { h.requireAnchor('[data-anchor]', { describe: "detail page" }); return {}; } });
  const r = await runAction({ adapter: a, name: "go", doc, win, now });
  assert.equal(r.reason, "structure-changed");
});

test("wait that never completes -> timeout", async () => {
  const { doc, win } = makeEnv({});
  const a = adapter({ go: async ({ h }) => { await h.waitFor(() => false, { timeout: 100, describe: "never" }); return {}; } });
  const r = await runAction({ adapter: a, name: "go", doc, win, now, timeoutMs: 5000 });
  assert.equal(r.reason, "timeout");
});

test("listActions surfaces names, descriptions and args", () => {
  const a = adapter({ a: async () => ({}), b: async () => ({}) }, {
    actionsMeta: { a: { description: "does a", args: { id: "an id" } } },
  });
  const list = listActions(a);
  assert.deepEqual(list.map((x) => x.name).sort(), ["a", "b"]);
  const ai = list.find((x) => x.name === "a");
  assert.equal(ai.description, "does a");
  assert.deepEqual(ai.args, { id: "an id" });
});
