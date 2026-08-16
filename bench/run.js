#!/usr/bin/env node
"use strict";
/* M2 benchmark driver.
 *
 * Fairness rules (hard constraints, see PROJECT_NOTES §5):
 * - baseline and optimized perform the SAME task over the SAME visited data
 *   and locate the SAME targets;
 * - unmounted virtual rows are never counted as readable DOM: every variant
 *   only sees rows it actually mounted;
 * - result sets are cross-checked: any baseline/optimized mismatch fails the
 *   run (exit 1).
 *
 * Subtests:
 *   1. query over visited data   baseline: re-sweep the list and text-search
 *                                optimized: local index query
 *                                aux: mounted-only search (wrong task — its
 *                                     completeness % is the point)
 *   2. locate a target record    baseline: sweep from top until mounted
 *                                optimized: index id -> adapter scrollToRecord
 *   3. incremental update        baseline: full rebuild sweep
 *                                optimized: delta sweep of the new region only
 *   4. restore after reload      baseline: re-drive batch loading + rebuild
 *                                optimized: read persisted index
 *
 * Usage: node bench/run.js            (all tiers)
 *        node bench/run.js --quick    (small tier only)
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startMockServer, launchBrowser, injectHarness } = require("../tests/integration/helpers.js");

const QUICK = process.argv.includes("--quick");
const TIERS = QUICK
  ? [{ count: 500, batch: 50, delay: 30, seed: 42 }]
  : [
      { count: 500, batch: 50, delay: 30, seed: 42 },
      { count: 2000, batch: 200, delay: 30, seed: 42 },
    ];
const QUERIES = ["founder", "acme ai", "berlin"];
const LOCATE_FRACS = [0.1, 0.5, 0.9];
const LIGHT_TRIALS = 5; // cheap measurements (index query, restore parse)
const HEAVY_TRIALS = 2; // sweep-based measurements

const PAGE_FNS = path.join(__dirname, "page-fns.js");

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (ms) => (ms >= 100 ? ms.toFixed(0) : ms >= 1 ? ms.toFixed(1) : ms.toFixed(3));
const ratio = (b, o) => (o > 0 ? (b / o).toFixed(o >= 1 ? 0 : 1) + "x" : "n/a");

let failures = 0;
function crossCheck(label, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) {
    failures++;
    console.error("CROSS-CHECK FAILED: " + label);
  }
  return ok;
}

async function runTier(browser, base, tier) {
  const page = await browser.newPage();
  // manual=1: data arrival is driver-controlled, so no sweep can accidentally
  // trigger a batch load and drift the visited scope between variants
  const url =
    base + "/?count=" + tier.count + "&batch=" + tier.batch +
    "&delay=" + tier.delay + "&seed=" + tier.seed + "&manual=1";
  await page.goto(url);
  await injectHarness(page, { observe: false });
  await page.addScriptTag({ path: PAGE_FNS });

  const out = { tier, url, aux: {}, subtests: {} };

  // ---- setup: load all but the last batch, then index the visited range ----
  const coldMeta = await page.evaluate(() => window.__H.meta());
  out.aux.coldScan = { ms: coldMeta.lastScan.durationMs, extracted: coldMeta.lastScan.extracted };

  const preTarget = tier.count - tier.batch;
  const drive = await page.evaluate((t) => window.__BENCH.driveLoadTo(t), preTarget);
  if (!drive.ok) throw new Error("setup driveLoadTo failed");
  out.aux.setupDrive = { ms: drive.ms, loaded: drive.loaded };

  const build = await page.evaluate(() => window.__BENCH.indexSweep());
  out.aux.indexBuild = build; // ms, stops, indexed
  const visited = drive.loaded;

  // ---- subtest 1: query over visited data ---------------------------------
  const q = { perQuery: [], cross: true };
  for (const text of QUERIES) {
    const optMs = [], baseMs = [];
    let optMatches = null, baseMatches = null, mounted = null;
    for (let i = 0; i < LIGHT_TRIALS; i++) {
      const r = await page.evaluate((t) => window.__BENCH.optimizedQuery(t), text);
      optMs.push(r.ms);
      optMatches = r.matches;
    }
    for (let i = 0; i < HEAVY_TRIALS; i++) {
      const r = await page.evaluate((t) => window.__BENCH.baselineQuery(t), text);
      baseMs.push(r.ms);
      baseMatches = r.matches;
      if (i === 0) q.rowsRead = r.rowsRead;
    }
    mounted = await page.evaluate((t) => window.__BENCH.mountedOnlyQuery(t), text);
    const ok = crossCheck("query '" + text + "' tier " + tier.count, optMatches, baseMatches);
    q.cross = q.cross && ok;
    q.perQuery.push({
      text,
      matches: baseMatches.length,
      baselineMs: median(baseMs),
      optimizedMs: median(optMs),
      mountedOnlyMs: mounted.ms,
      mountedCompleteness: baseMatches.length
        ? mounted.matches.filter((id) => baseMatches.includes(id)).length / baseMatches.length
        : 1,
    });
  }
  out.subtests.query = q;

  // ---- subtest 2: locate a target record -----------------------------------
  const targets = LOCATE_FRACS.map((f) => "c-" + Math.max(1, Math.floor(visited * f)));
  const loc = { perTarget: [] };
  for (const id of targets) {
    const optMs = [], baseMs = [];
    for (let i = 0; i < HEAVY_TRIALS; i++) {
      await page.evaluate(() => window.__BENCH.resetScroll());
      const o = await page.evaluate((t) => window.__H.locate(t), id);
      if (o.status !== "success") throw new Error("optimized locate failed for " + id + ": " + o.reason);
      optMs.push(o.ms);
      await page.evaluate(() => window.__BENCH.resetScroll());
      const b = await page.evaluate((t) => window.__BENCH.baselineLocate(t), id);
      if (!b.found) throw new Error("baseline locate failed for " + id);
      baseMs.push(b.ms);
    }
    loc.perTarget.push({ id, baselineMs: median(baseMs), optimizedMs: median(optMs) });
  }
  out.subtests.locate = loc;

  // ---- subtest 3: incremental update ---------------------------------------
  const h0 = await page.evaluate(() => window.__BENCH.canvasHeight());
  const vh = await page.evaluate(() => window.__BENCH.viewportHeight());
  const lastDrive = await page.evaluate((t) => window.__BENCH.driveLoadTo(t), tier.count);
  if (!lastDrive.ok) throw new Error("last batch driveLoadTo failed");

  const delta = await page.evaluate((t) => window.__BENCH.deltaIndexSweep(t), Math.max(0, h0 - vh));
  const rebuilds = [];
  let rebuildRows = 0;
  for (let i = 0; i < HEAVY_TRIALS; i++) {
    const r = await page.evaluate(() => window.__BENCH.baselineRebuild());
    rebuilds.push(r.ms);
    rebuildRows = r.rowsRead;
  }
  // equal-knowledge check: delta-updated index covers everything the rebuild saw
  const idxSize = await page.evaluate(() => window.__H.stats.total);
  const equalKnowledge = idxSize >= rebuildRows;
  if (!equalKnowledge) {
    failures++;
    console.error("CROSS-CHECK FAILED: incremental index (" + idxSize + ") < rebuild rows (" + rebuildRows + ")");
  }
  out.subtests.incremental = {
    newRows: tier.batch,
    optimizedMs: delta.ms,
    optimizedStops: delta.stops,
    baselineMs: median(rebuilds),
    baselineRowsRead: rebuildRows,
    equalKnowledge,
  };

  // aux must be captured before the reload resets the harness counters
  const countersBefore = await page.evaluate(() => window.__H.counters());
  out.aux.dedup = {
    totalExtracted: countersBefore.totalExtracted,
    poolSize: idxSize,
    note: "rows extracted across all scans vs unique records in the pool",
  };

  // ---- subtest 4: restore after reload --------------------------------------
  const persisted = await page.evaluate(() => window.__BENCH.persistIndex());
  const loadedBefore = await page.evaluate(() => window.__MOCK_SITE__.loadedCount);

  await page.reload();
  await injectHarness(page, { observe: false });
  await page.addScriptTag({ path: PAGE_FNS });

  const restoreMs = [];
  let restoredN = 0;
  for (let i = 0; i < LIGHT_TRIALS; i++) {
    const r = await page.evaluate(() => window.__BENCH.optimizedRestore());
    if (!r.ok) throw new Error("optimizedRestore found no persisted index");
    restoreMs.push(r.ms);
    restoredN = r.n;
  }
  if (restoredN !== persisted) {
    failures++;
    console.error("CROSS-CHECK FAILED: restored " + restoredN + " != persisted " + persisted);
  }

  const redrive = await page.evaluate((t) => window.__BENCH.driveLoadTo(t), loadedBefore);
  if (!redrive.ok) throw new Error("restore baseline driveLoadTo failed");
  const rerebuild = await page.evaluate(() => window.__BENCH.baselineRebuild());
  out.subtests.restore = {
    records: persisted,
    optimizedMs: median(restoreMs),
    baselineDriveMs: redrive.ms,
    baselineRebuildMs: rerebuild.ms,
    baselineTotalMs: redrive.ms + rerebuild.ms,
    note: "optimized uses a localStorage read as a stand-in for chrome.storage.local (adds a few ms of IPC in the real extension); baseline must re-drive batched loading (network delays included) and re-read every row",
  };

  await page.close();
  return out;
}

function renderMarkdown(results, env) {
  const L = [];
  L.push("# Fast Navigator — M2 benchmark report");
  L.push("");
  L.push("Generated: " + env.date + " · " + env.browser + " · Node " + env.node + " · " + env.os);
  L.push("");
  L.push("## Fairness rules");
  L.push("");
  L.push("- Baseline and optimized perform the **same task** over the **same visited data** and locate the **same targets**; result sets are cross-checked (" + (env.failures === 0 ? "**all checks passed**" : "**" + env.failures + " CHECK(S) FAILED**") + ").");
  L.push("- Unmounted virtual rows are never counted as readable DOM — every variant only sees rows it actually mounted.");
  L.push("- The baseline reuses the adapter's extraction logic for free; a real agent pays far more per row to interpret the DOM. Ratios below are therefore conservative.");
  L.push("- The scanner's MutationObserver is disabled during baseline measurements; nothing pollutes baseline timings.");
  L.push("");
  for (const r of results) {
    const t = r.tier;
    L.push("## Tier: " + t.count + " records (batch " + t.batch + ", delay " + t.delay + "ms, seed " + t.seed + ")");
    L.push("");
    L.push("Setup: cold scan " + fmt(r.aux.coldScan.ms) + "ms for " + r.aux.coldScan.extracted +
      " mounted rows · index build over visited range " + fmt(r.aux.indexBuild.ms) + "ms (" +
      r.aux.indexBuild.stops + " stops, " + r.aux.indexBuild.indexed + " records)");
    L.push("");
    L.push("### 1. Query over visited data");
    L.push("");
    L.push("| query | matches | baseline (re-sweep) | optimized (index) | speedup | mounted-only ms | mounted-only completeness |");
    L.push("|---|---|---|---|---|---|---|");
    for (const q of r.subtests.query.perQuery) {
      L.push("| `" + q.text + "` | " + q.matches + " | " + fmt(q.baselineMs) + "ms | " + fmt(q.optimizedMs) +
        "ms | " + ratio(q.baselineMs, q.optimizedMs) + " | " + fmt(q.mountedOnlyMs) + "ms | " +
        (q.mountedCompleteness * 100).toFixed(0) + "% |");
    }
    L.push("");
    L.push("Mounted-only search is fast but answers a smaller task — its completeness column shows how many true matches it finds. It is listed to keep the comparison honest, not as an equal baseline.");
    L.push("");
    L.push("### 2. Locate a target record (both sides start from the top)");
    L.push("");
    L.push("| target | baseline (sweep until mounted) | optimized (index → scrollToRecord) | speedup |");
    L.push("|---|---|---|---|");
    for (const x of r.subtests.locate.perTarget) {
      L.push("| " + x.id + " | " + fmt(x.baselineMs) + "ms | " + fmt(x.optimizedMs) + "ms | " + ratio(x.baselineMs, x.optimizedMs) + " |");
    }
    L.push("");
    L.push("### 3. Incremental update (one new batch of " + r.subtests.incremental.newRows + " rows)");
    L.push("");
    const inc = r.subtests.incremental;
    L.push("| variant | ms | rows touched |");
    L.push("|---|---|---|");
    L.push("| baseline: full rebuild sweep | " + fmt(inc.baselineMs) + "ms | " + inc.baselineRowsRead + " |");
    L.push("| optimized: delta sweep of new region | " + fmt(inc.optimizedMs) + "ms | ~" + inc.newRows + " |");
    L.push("");
    L.push("Equal-knowledge check (delta-updated index covers all rows the rebuild saw): " + (inc.equalKnowledge ? "passed" : "**FAILED**"));
    L.push("");
    L.push("### 4. State restore after reload (" + r.subtests.restore.records + " records)");
    L.push("");
    const rs = r.subtests.restore;
    L.push("| variant | ms |");
    L.push("|---|---|");
    L.push("| baseline: re-drive batches (" + fmt(rs.baselineDriveMs) + "ms) + rebuild sweep (" + fmt(rs.baselineRebuildMs) + "ms) | " + fmt(rs.baselineTotalMs) + "ms |");
    L.push("| optimized: read persisted index | " + fmt(rs.optimizedMs) + "ms |");
    L.push("");
    L.push("Note: " + rs.note + ".");
    L.push("");
    L.push("Aux: " + r.aux.dedup.totalExtracted + " rows extracted across all scans deduplicated into " +
      r.aux.dedup.poolSize + " unique records. Cache-hit rate for queries is 100% by construction once the index is built; the honest cost of building it is the \"index build\" figure above.");
    L.push("");
  }
  return L.join("\n");
}

(async () => {
  const { server, base } = await startMockServer();
  const browser = await launchBrowser();
  const browserVersion = browser.version();
  const results = [];
  try {
    for (const tier of TIERS) {
      console.log("Running tier " + tier.count + " …");
      results.push(await runTier(browser, base, tier));
    }
  } finally {
    await browser.close();
    server.close();
  }

  const env = {
    date: new Date().toISOString(),
    browser: "Chromium " + browserVersion,
    node: process.version,
    os: os.platform() + " " + os.arch(),
    failures,
  };

  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = env.date.replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(outDir, stamp + ".json"), JSON.stringify({ env, results }, null, 2));
  const md = renderMarkdown(results, env);
  fs.writeFileSync(path.join(outDir, "latest.md"), md);
  console.log("\n" + md);
  console.log("\nWrote bench/results/" + stamp + ".json and bench/results/latest.md");
  if (failures > 0) {
    console.error("\n" + failures + " cross-check failure(s) — results are NOT trustworthy.");
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
