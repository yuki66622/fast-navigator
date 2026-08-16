"use strict";
/* Extension smoke test: loads the real MV3 extension into Chrome (persistent
 * context), seeds chrome.storage.local from the service worker, and verifies
 * the side panel page renders/filters/clears against real extension storage.
 * The activeTab injection path itself requires a real toolbar click, which
 * cannot be automated reliably — that step stays a documented manual check. */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { EXT_DIR } = require("./helpers.js");
const { mergeRecords } = require("../../extension/core/indexer.js");

let context, userDataDir, extId;

/* NOTE: branded Google Chrome ignores --load-extension since Chrome 137, so
 * this test requires Playwright's bundled Chromium (npx playwright-core
 * install chromium). New headless there supports extensions. */
async function launchWithExtension(headless) {
  return chromium.launchPersistentContext(userDataDir, {
    channel: "chromium", // full build + new headless: required for extension support
    headless,
    args: [
      "--disable-extensions-except=" + EXT_DIR,
      "--load-extension=" + EXT_DIR,
    ],
  });
}

before(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "afn-ext-test-"));
  context = await launchWithExtension(true);
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    try {
      sw = await context.waitForEvent("serviceworker", { timeout: 8000 });
    } catch (_e) {
      // this Chrome build does not start extensions in headless — fall back to headed
      await context.close();
      context = await launchWithExtension(false);
      sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 15000 }));
    }
  }
  extId = new URL(sw.url()).host;

  // Seed storage exactly as the scanner would have written it.
  const recs = [
    { id: "c-1", fields: { name: "Ada Chen", company: "Acme AI", role: "Founder", location: "Berlin" } },
    { id: "c-2", fields: { name: "Ben Diaz", company: "Beacon Labs", role: "CTO", location: "New York" } },
    { id: "c-3", fields: { name: "Cara Egan", company: "Acme AI", role: "Co-founder", location: "London" } },
  ];
  const source = { adapterId: "mock", url: "http://mock/", route: "list", scannedAt: Date.now() };
  const { records } = mergeRecords({}, recs, source);
  const meta = {
    adapterId: "mock", url: source.url,
    health: { level: "ok", code: "ok", message: "Scan looks healthy." },
    lastScan: { reason: "initial", at: source.scannedAt, durationMs: 5, rootsFound: 1, extracted: 3, added: 3, updated: 0, unchanged: 0, mode: "primary" },
    counters: { scans: 1, totalExtracted: 3 },
  };
  await sw.evaluate(
    (data) => chrome.storage.local.set(data),
    { "afn:index": { records }, "afn:meta": meta, "afn:status": { "mock:c-2": { status: "done", updatedAt: Date.now() } } }
  );
});

after(async () => {
  if (context) await context.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("side panel renders the seeded index with health, statuses and footer", async () => {
  const page = await context.newPage();
  await page.goto("chrome-extension://" + extId + "/sidepanel/sidepanel.html");
  await page.waitForSelector(".result");

  assert.equal(await page.locator(".result").count(), 3);
  assert.equal(await page.locator(".health.ok").count(), 1);
  const footer = await page.locator("#footer").textContent();
  assert.match(footer, /showing 3 \/ 3 indexed/);
  assert.match(footer, /adapter: mock/);
  assert.equal(await page.locator(".status-btn.done").count(), 1, "seeded status is shown");
  await page.close();
});

test("search and status filter work against the local index", async () => {
  const page = await context.newPage();
  await page.goto("chrome-extension://" + extId + "/sidepanel/sidepanel.html");
  await page.waitForSelector(".result");

  await page.fill("#search", "acme founder");
  assert.equal(await page.locator(".result").count(), 2);
  await page.fill("#search", "acme co-founder");
  assert.equal(await page.locator(".result").count(), 1);
  assert.match(await page.locator(".result .name").first().textContent(), /Cara Egan/);

  await page.fill("#search", "");
  await page.selectOption("#status-filter", "done");
  assert.equal(await page.locator(".result").count(), 1);
  assert.match(await page.locator(".result .name").first().textContent(), /Ben Diaz/);
  await page.close();
});

test("status cycle button persists to storage; clear empties the index", async () => {
  const page = await context.newPage();
  await page.goto("chrome-extension://" + extId + "/sidepanel/sidepanel.html");
  await page.waitForSelector(".result");

  // first row (Ada, pending) -> viewed
  await page.locator(".result .status-btn").first().click();
  await page.waitForSelector(".status-btn.viewed");
  const stored = await page.evaluate(async () => (await chrome.storage.local.get("afn:status"))["afn:status"]);
  assert.equal(stored["mock:c-1"].status, "viewed");

  page.on("dialog", (d) => d.accept());
  await page.click("#clear");
  await page.waitForFunction(() => document.querySelectorAll(".result").length === 0);
  const after = await page.evaluate(async () => await chrome.storage.local.get(null));
  assert.deepEqual(after, {}, "clear removes index, meta and statuses");
  await page.close();
});
