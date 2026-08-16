"use strict";
/* End-to-end V2 flow: side panel natural-language input -> local sidecar
 * (mock mode) -> structured query -> deterministic local filtering.
 * The sidecar URL is injected via afn:settings so the test can use a random
 * port; the LLM never sees the indexed records — only the query text. */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright-core");
const { EXT_DIR } = require("./helpers.js");
const { mergeRecords } = require("../../extension/core/indexer.js");

const PORT = 18900 + Math.floor(Math.random() * 90);
let context, userDataDir, extId, sidecar;

before(async () => {
  sidecar = spawn("python3", [path.join(__dirname, "..", "..", "sidecar", "server.py")], {
    env: { ...process.env, MOCK_LLM: "1", SIDECAR_PORT: String(PORT) },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch("http://127.0.0.1:" + PORT + "/v1/health")).ok) break; } catch (_e) {}
    await new Promise((r) => setTimeout(r, 100));
  }

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "afn-nl-test-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: ["--disable-extensions-except=" + EXT_DIR, "--load-extension=" + EXT_DIR],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
  extId = new URL(sw.url()).host;

  const recs = [
    { id: "c-1", fields: { name: "Ada Chen", company: "Acme AI", role: "Founder", location: "Berlin, Germany" } },
    { id: "c-2", fields: { name: "Ben Diaz", company: "Beacon Labs", role: "CTO", location: "New York" } },
    { id: "c-3", fields: { name: "Cara Egan", company: "Acme AI", role: "Co-Founder", location: "London, UK" } },
  ];
  const { records } = mergeRecords({}, recs, { adapterId: "mock", url: "http://mock/", route: "list", scannedAt: Date.now() });
  await sw.evaluate(
    (data) => chrome.storage.local.set(data),
    { "afn:index": { records }, "afn:settings": { sidecarUrl: "http://127.0.0.1:" + PORT } }
  );
});

after(async () => {
  if (context) await context.close();
  if (sidecar) sidecar.kill();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("NL query filters via derived structured query; clearing restores", async () => {
  const page = await context.newPage();
  await page.goto("chrome-extension://" + extId + "/sidepanel/sidepanel.html");
  await page.waitForSelector(".result");
  assert.equal(await page.locator(".result").count(), 3);

  await page.fill("#nl", "founders in berlin");
  await page.click("#ask");
  await page.waitForSelector("#derived:not(.hidden)");

  const derived = await page.locator("#derived-text").textContent();
  assert.match(derived, /founder \| co-founder/, "role synonyms visible: " + derived);
  assert.match(derived, /berlin @location/, "scoped location group visible: " + derived);
  assert.match(derived, /\[mock\]/, "source labeled");

  assert.equal(await page.locator(".result").count(), 1, "only the Berlin founder remains");
  assert.match(await page.locator(".result .name").first().textContent(), /Ada Chen/);

  await page.click("#derived-clear");
  await page.waitForFunction(() => document.querySelectorAll(".result").length === 3);
  assert.ok(await page.locator("#derived").evaluate((el) => el.classList.contains("hidden")));
  await page.close();
});

test("sidecar down -> clear notice, no crash, list intact", async () => {
  const page = await context.newPage();
  await page.goto("chrome-extension://" + extId + "/sidepanel/sidepanel.html");
  await page.waitForSelector(".result");
  await page.evaluate(() => chrome.storage.local.set({ "afn:settings": { sidecarUrl: "http://127.0.0.1:1" } }));
  await page.reload();
  await page.waitForSelector(".result");

  await page.fill("#nl", "founders in berlin");
  await page.click("#ask");
  await page.waitForSelector(".notice:not(.hidden)");
  assert.match(await page.locator("#notice").textContent(), /Sidecar not reachable/);
  assert.equal(await page.locator(".result").count(), 3, "results untouched on failure");

  // restore the working sidecar for any later tests
  await page.evaluate((p) => chrome.storage.local.set({ "afn:settings": { sidecarUrl: "http://127.0.0.1:" + p } }), PORT);
  await page.close();
});
