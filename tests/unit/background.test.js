"use strict";
/* Regression tests for the toolbar-click handler in extension/background.js:
 * opening the side panel must never prevent injection — not even when
 * chrome.sidePanel.open() throws SYNCHRONOUSLY (a rejected promise or a plain
 * throw). The handler is loaded in a sandbox with a mocked `chrome`. */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BG_SRC = fs.readFileSync(path.join(__dirname, "..", "..", "extension", "background.js"), "utf8");

// Build a mock chrome whose sidePanel.open behaves per `openImpl`, capture the
// registered onClicked handler, and record executeScript calls.
function loadBackground(openImpl) {
  const record = { executeScript: [], sidePanelOpen: 0 };
  let handler = null;
  const chrome = {
    action: { onClicked: { addListener: (fn) => { handler = fn; } } },
    sidePanel: { open: (arg) => { record.sidePanelOpen++; return openImpl(arg); } },
    scripting: { executeScript: (arg) => { record.executeScript.push(arg); return Promise.resolve(); } },
  };
  const ctx = { chrome, console: { warn() {} } };
  vm.runInContext(BG_SRC, vm.createContext(ctx));
  assert.equal(typeof handler, "function", "background.js must register an onClicked listener");
  return { handler, record };
}

test("sidePanel.open synchronous throw still runs executeScript", () => {
  const { handler, record } = loadBackground(() => { throw new Error("must be called in response to a user gesture"); });
  handler({ id: 42 });
  assert.equal(record.sidePanelOpen, 1, "sidePanel.open was attempted in the gesture stack");
  assert.equal(record.executeScript.length, 1, "injection must still run after a synchronous throw");
  assert.equal(record.executeScript[0].target.tabId, 42);
});

test("sidePanel.open asynchronous rejection still runs executeScript (no unhandled rejection)", async () => {
  const { handler, record } = loadBackground(() => Promise.reject(new Error("no active tab")));
  handler({ id: 7 });
  await Promise.resolve();
  assert.equal(record.executeScript.length, 1);
  assert.equal(record.executeScript[0].target.tabId, 7);
});

test("sidePanel.open success still runs executeScript with a non-empty files list", () => {
  const { handler, record } = loadBackground(() => Promise.resolve());
  handler({ id: 1 });
  assert.equal(record.executeScript.length, 1);
  const files = record.executeScript[0].files;
  assert.ok(Array.isArray(files) && files.length > 0, "files list present");
  // stable, non-adapter-specific expectations only
  assert.ok(files.includes("core/actions.js"));
  assert.equal(files[files.length - 1], "content/runtime.js", "runtime injected last");
});

test("no tab id: neither sidePanel.open nor executeScript runs", () => {
  const { handler, record } = loadBackground(() => Promise.resolve());
  handler({});
  assert.equal(record.sidePanelOpen, 0);
  assert.equal(record.executeScript.length, 0);
});
