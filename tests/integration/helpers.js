"use strict";
/* Shared helpers: tiny static server for mock-site, Chrome launch via the
 * user's installed Chrome (playwright-core channel "chrome" — no browser
 * download), and the in-page harness that wires the real core + MockAdapter
 * to a memory platform (extension-free path for the four scenario tests). */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..", "..");
const MOCK_DIR = path.join(ROOT, "mock-site");
const EXT_DIR = path.join(ROOT, "extension");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function startMockServer(baseDir) {
  const rootDir = baseDir || MOCK_DIR;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
      let file = path.normalize(path.join(rootDir, urlPath === "/" ? "index.html" : urlPath));
      if (!file.startsWith(rootDir)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, base: "http://127.0.0.1:" + server.address().port });
    });
  });
}

async function launchBrowser() {
  // Prefer Playwright's bundled Chromium; fall back to the user's installed Chrome
  // (fine for these extension-free tests) if the bundled browser is missing.
  try {
    return await chromium.launch({ channel: "chromium", headless: true });
  } catch (e) {
    return await chromium.launch({ channel: "chrome", headless: true });
  }
}

const CORE_FILES = [
  "platform/platform.js",
  "core/bench.js",
  "core/indexer.js",
  "core/query.js",
  "core/health.js",
  "core/router.js",
  "core/locator.js",
  "core/scanner.js",
  "core/actions.js",
  "adapters/registry.js",
  "adapters/mock/adapter.js",
].map((f) => path.join(EXT_DIR, f));

/* Injects the real core + adapter into the page and starts a scanner backed by
 * a memory platform. Exposes window.__H for assertions.
 * opts.observe=false skips the MutationObserver so benchmark baselines are not
 * polluted by automatic scans; scans then only run via __H.scan(). */
async function injectHarness(page, opts) {
  const options = Object.assign({ observe: true }, opts);
  for (const f of CORE_FILES) await page.addScriptTag({ path: f });
  await page.evaluate((cfg) => {
    const platform = AFN.platform.createMemoryPlatform();
    const bench = AFN.bench.createBench(() => performance.now());
    const adapter = AFN.adapters.select(location.href, document);
    let route = adapter ? adapter.onRouteChange(location.href) : null;
    const routeEvents = [];
    // sync mirror for waitForFunction (async predicates are not awaited there)
    const stats = { scans: 0, total: 0, healthLevel: null };
    let scanner = null;
    if (adapter) {
      scanner = AFN.scanner.createScanner({
        adapter, platform, doc: document, bench,
        getRoute: () => (route && route.view) || null,
        onUpdate: (u) => {
          stats.scans++;
          stats.total = u.total;
          stats.healthLevel = u.health.level;
        },
      });
      const watcher = AFN.router.createRouteWatcher({
        win: window, pollMs: 150,
        onChange: (href) => {
          route = adapter.onRouteChange(href);
          routeEvents.push(href);
          scanner.scanNow("route");
        },
      });
      if (cfg.observe) {
        scanner.start();
        watcher.start();
      } else {
        scanner.scanNow("initial");
      }
    }
    window.__H = {
      stats,
      adapterId: adapter && adapter.adapterId,
      scan: (r) => scanner.scanNow(r || "manual"),
      locate: (id) =>
        AFN.locator.locateRecord({ id, adapter, doc: document, now: () => performance.now() })
          .then((r) => ({ status: r.status, reason: r.reason || null, ms: r.ms })),
      index: async () => {
        const got = await platform.storageGet("afn:index");
        return (got["afn:index"] || { records: {} }).records;
      },
      indexSize: async () => {
        const got = await platform.storageGet("afn:index");
        return Object.keys((got["afn:index"] || { records: {} }).records).length;
      },
      meta: async () => {
        const got = await platform.storageGet("afn:meta");
        return got["afn:meta"] || null;
      },
      counters: () => scanner.getCounters(),
      routeEvents,
      benchEntries: () => bench.entries(),
      action: (name, args, timeoutMs) =>
        AFN.actions.runAction({ adapter, name, args: args || {}, doc: document, win: window, now: () => performance.now(), timeoutMs }),
      capabilities: () => AFN.actions.listActions(adapter),
    };
  }, options);
  await page.waitForFunction(() => window.__H && window.__H.stats.scans >= 1);
}

module.exports = { startMockServer, launchBrowser, injectHarness, ROOT, EXT_DIR };
