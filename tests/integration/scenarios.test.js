"use strict";
/* Four scenario tests against the real mock site in real Chrome:
 *   A. incremental indexing across batch loads (virtual list, index accumulates)
 *   B. locating an unmounted record (adapter drives the virtual scroll)
 *   C. SPA route awareness (silent pushState is still detected)
 *   D. structure change -> fallback warning (v2) / explicit error (v3)
 * The harness wires the real core + MockAdapter to a memory platform; the
 * extension messaging glue is covered separately in extension.test.js. */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startMockServer, launchBrowser, injectHarness } = require("./helpers.js");
const { generateContacts } = require("../../mock-site/data.js");

let server, base, browser;

before(async () => {
  ({ server, base } = await startMockServer());
  browser = await launchBrowser();
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

async function openPage(params) {
  const page = await browser.newPage();
  await page.goto(base + "/?" + params);
  await injectHarness(page);
  return page;
}

test("A: index accumulates across batch loads; each scan is partial", async () => {
  const page = await openPage("count=200&batch=25&delay=40&seed=42");

  const size0 = await page.evaluate(() => window.__H.indexSize());
  assert.ok(size0 > 0, "initial scan indexed mounted rows");
  assert.ok(size0 <= 25, "only the first batch can be mounted initially, got " + size0);

  for (let i = 0; i < 5; i++) {
    const prevLoaded = await page.evaluate(() => window.__MOCK_SITE__.loadedCount);
    if (prevLoaded >= 200) break;
    await page.evaluate(() => {
      const v = document.getElementById("list-viewport");
      v.scrollTop = v.scrollHeight;
    });
    await page.waitForFunction((p) => window.__MOCK_SITE__.loadedCount > p, prevLoaded);
    // pause like a reading user so the mutation-debounced scan fires per stop
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => window.__H.stats.total >= 60);

  const finalSize = await page.evaluate(() => window.__H.indexSize());
  const index = await page.evaluate(() => window.__H.index());
  const meta = await page.evaluate(() => window.__H.meta());

  assert.ok(index["mock:c-1"], "record c-1 stays indexed although long unmounted");
  assert.equal(meta.health.level, "ok");
  assert.ok(
    meta.lastScan.extracted < finalSize,
    `scans are partial (${meta.lastScan.extracted} extracted) while the pool accumulates (${finalSize})`
  );
  await page.close();
});

test("B: locate drives the virtual list to an unmounted record and highlights it", async () => {
  const page = await openPage("count=300&batch=50&delay=30&seed=42");

  const res = await page.evaluate(() => window.__H.locate("c-250"));
  assert.equal(res.status, "success", "locate failed: " + res.reason);
  assert.ok(typeof res.ms === "number" && res.ms > 0);

  const check = await page.evaluate(() => {
    const el = document.querySelector('[data-contact-id="c-250"]');
    if (!el) return { mounted: false };
    const v = document.getElementById("list-viewport").getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
      mounted: true,
      highlighted: el.classList.contains("afn-highlight"),
      inViewport: r.top >= v.top - 1 && r.bottom <= v.bottom + 1,
    };
  });
  assert.ok(check.mounted, "target row is mounted after locate");
  assert.ok(check.highlighted, "target row carries the highlight class");
  assert.ok(check.inViewport, "target row is scrolled into the list viewport");

  const missing = await page.evaluate(() => window.__H.locate("c-9999"));
  assert.equal(missing.status, "failure");
  assert.equal(missing.reason, "not-found", "exhausting the data must fail explicitly");

  const garbage = await page.evaluate(() => window.__H.locate("no-such-id"));
  assert.equal(garbage.status, "failure");
  assert.equal(garbage.reason, "unrecognized-id");
  await page.close();
});

test("C: silent pushState routing is detected; index survives navigation", async () => {
  const page = await openPage("count=100&batch=25&delay=30&seed=42");
  const scans0 = await page.evaluate(() => window.__H.counters().scans);

  await page.click('[data-contact-id="c-3"] a');
  await page.waitForFunction(() => window.__H.routeEvents.length >= 1);
  const evt = await page.evaluate(() => window.__H.routeEvents[window.__H.routeEvents.length - 1]);
  assert.ok(evt.endsWith("#/contact/c-3"), "route event carries the detail URL: " + evt);
  await page.waitForFunction((s) => window.__H.counters().scans > s, scans0);

  const detailVisible = await page.evaluate(
    () => !document.getElementById("view-detail").classList.contains("hidden")
  );
  assert.ok(detailVisible);

  await page.goBack();
  await page.waitForFunction(() => window.__H.routeEvents.length >= 2);
  const listVisible = await page.evaluate(
    () => !document.getElementById("view-list").classList.contains("hidden")
  );
  assert.ok(listVisible, "back navigation restores the list view");

  const index = await page.evaluate(() => window.__H.index());
  assert.ok(index["mock:c-3"], "index intact after route round-trip");
  await page.close();
});

test("D: v2 markup -> fallback warning with correct fields; v3 -> explicit structure error", async () => {
  // v2: classes renamed, extra wrapper — fallback extraction must still map fields
  const p2 = await openPage("count=100&batch=25&delay=30&seed=42&structure=v2");
  const meta2 = await p2.evaluate(() => window.__H.meta());
  assert.equal(meta2.health.level, "warning");
  assert.equal(meta2.health.code, "fallback-extraction");
  const index2 = await p2.evaluate(() => window.__H.index());
  const expected = generateContacts(100, 42)[0]; // deterministic: same seed as the page
  assert.deepEqual(index2["mock:c-1"].fields, {
    name: expected.name, company: expected.company, role: expected.role, location: expected.location,
  });
  await p2.close();

  // v3: record id attribute renamed — must be an explicit error, not a silent empty result
  const p3 = await openPage("count=100&batch=25&delay=30&seed=42&structure=v3");
  const meta3 = await p3.evaluate(() => window.__H.meta());
  assert.equal(meta3.health.level, "error");
  assert.equal(meta3.health.code, "structure-changed");
  assert.equal(await p3.evaluate(() => window.__H.indexSize()), 0);
  await p3.close();
});
