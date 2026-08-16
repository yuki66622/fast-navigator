/* Scan orchestrator: adapter extracts, core merges/persists/reports.
 * Incremental behaviour falls out of the merge: a mutation-triggered scan only
 * sees currently mounted rows, and the index pool accumulates across scans. */
(function (global) {
  "use strict";

  const STORAGE_KEYS = {
    index: "afn:index",
    meta: "afn:meta",
    status: "afn:status",
  };

  function createScanner({ adapter, platform, doc, bench, getRoute, onUpdate, debounceMs }) {
    const indexer = (typeof module !== "undefined" ? require("./indexer.js") : global.AFN.indexer);
    const healthMod = (typeof module !== "undefined" ? require("./health.js") : global.AFN.health);
    const debounce = debounceMs === undefined ? 250 : debounceMs;

    let scanning = false;
    let pendingReason = null;
    let observer = null;
    let debounceTimer = null;
    const counters = { scans: 0, totalExtracted: 0 };

    function extractAll() {
      const roots = Array.from(adapter.getScanRoots(doc) || []);
      const records = [];
      let mode = "none";
      for (const root of roots) {
        const r = adapter.extractRecords(root) || { records: [], mode: "none" };
        records.push(...r.records);
        if (r.mode === "fallback") mode = "fallback";
        else if (r.mode === "primary" && mode === "none") mode = "primary";
      }
      return { roots, records, mode };
    }

    async function scanNow(reason) {
      if (scanning) { pendingReason = reason; return null; }
      scanning = true;
      const t0 = platform.now();
      try {
        // A page the adapter handles but that has no list to index (e.g. a
        // company or detail view of a multi-view app) is idle, not broken —
        // this avoids a false structure-changed alarm on non-list pages.
        if (typeof adapter.isScannable === "function" && !adapter.isScannable(doc)) {
          const idleHealth = { level: "ok", code: "idle", message: "No scannable list on this page." };
          const durationMs = platform.now() - t0;
          const lastScan = {
            reason, at: Date.now(), durationMs,
            rootsFound: 0, extracted: 0, added: 0, updated: 0, unchanged: 0, mode: "idle",
          };
          const got0 = await platform.storageGet({ [STORAGE_KEYS.index]: { records: {} } });
          const meta0 = {
            adapterId: adapter.adapterId,
            url: doc.location ? doc.location.href : null,
            health: idleHealth, lastScan, counters: Object.assign({}, counters),
          };
          await platform.storageSet({ [STORAGE_KEYS.meta]: meta0 });
          if (onUpdate) onUpdate({ health: idleHealth, lastScan, total: Object.keys(got0[STORAGE_KEYS.index].records || {}).length });
          return { health: idleHealth, lastScan };
        }
        const { roots, records, mode } = extractAll();
        const health = healthMod.assessScan({
          adapterMatched: true,
          rootsFound: roots.length,
          recordCount: records.length,
          extractionMode: mode,
        });
        const source = {
          adapterId: adapter.adapterId,
          url: doc.location ? doc.location.href : null,
          route: getRoute ? getRoute() : null,
          scannedAt: Date.now(),
        };
        const got = await platform.storageGet({ [STORAGE_KEYS.index]: { records: {} } });
        const existing = got[STORAGE_KEYS.index].records || {};
        const merged = indexer.mergeRecords(existing, records, source);
        counters.scans++;
        counters.totalExtracted += records.length;
        const durationMs = platform.now() - t0;
        const lastScan = {
          reason, at: source.scannedAt, durationMs,
          rootsFound: roots.length, extracted: records.length,
          added: merged.added, updated: merged.updated, unchanged: merged.unchanged,
          mode,
        };
        const meta = {
          adapterId: adapter.adapterId, url: source.url, health, lastScan,
          counters: Object.assign({}, counters),
        };
        await platform.storageSet({
          [STORAGE_KEYS.index]: { records: merged.records },
          [STORAGE_KEYS.meta]: meta,
        });
        if (bench) bench.mark("scan", durationMs, { reason, extracted: records.length, added: merged.added });
        if (onUpdate) onUpdate({ health, lastScan, total: Object.keys(merged.records).length });
        return { health, lastScan };
      } finally {
        scanning = false;
        if (pendingReason !== null) {
          const r = pendingReason;
          pendingReason = null;
          scanNow(r);
        }
      }
    }

    function scheduleScan(reason) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { debounceTimer = null; scanNow(reason); }, debounce);
    }

    return {
      scanNow,
      scheduleScan,
      getCounters: () => Object.assign({}, counters),
      start() {
        scanNow("initial");
        if (typeof MutationObserver !== "undefined" && doc.body) {
          observer = new MutationObserver(() => scheduleScan("mutation"));
          observer.observe(doc.body, { childList: true, subtree: true });
        }
      },
      stop() {
        if (observer) { observer.disconnect(); observer = null; }
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      },
    };
  }

  const api = { createScanner, STORAGE_KEYS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.AFN = global.AFN || {};
  global.AFN.scanner = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
