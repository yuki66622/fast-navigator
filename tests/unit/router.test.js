"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRouteWatcher } = require("../../extension/core/router.js");

function fakeWin(href) {
  const handlers = {};
  return {
    location: { href },
    addEventListener(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    removeEventListener(ev, fn) {
      handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn);
    },
    fire(ev) { for (const fn of handlers[ev] || []) fn(); },
    handlers,
  };
}

test("fires once per URL change, deduplicates identical URLs", () => {
  const win = fakeWin("http://x/#/");
  const seen = [];
  const w = createRouteWatcher({ win, onChange: (h) => seen.push(h), pollMs: 999999 });
  w.start();
  assert.deepEqual(seen, [], "starting must not fire for the initial URL");

  win.location.href = "http://x/#/contact/c-5";
  w.check();
  w.check(); // same URL again
  assert.deepEqual(seen, ["http://x/#/contact/c-5"]);

  win.location.href = "http://x/#/";
  win.fire("popstate"); // event-driven path
  assert.deepEqual(seen, ["http://x/#/contact/c-5", "http://x/#/"]);
  w.stop();
});

test("stop removes listeners and the poll timer", () => {
  const win = fakeWin("http://x/");
  const seen = [];
  const w = createRouteWatcher({ win, onChange: (h) => seen.push(h), pollMs: 999999 });
  w.start();
  w.stop();
  assert.equal((win.handlers.popstate || []).length, 0);
  win.location.href = "http://x/#/other";
  win.fire("popstate");
  assert.deepEqual(seen, []);
});
