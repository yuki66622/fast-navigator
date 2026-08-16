/* Page-side benchmark functions. Injected after the harness (needs window.__H
 * and the AFN globals). Defines window.__BENCH.
 *
 * Fairness notes baked into the implementation:
 * - The baseline re-reads the page by scrolling window-by-window and extracting
 *   every mounted row. It reuses the adapter's extraction (a real agent would
 *   pay far more per row for analysis) — the baseline is deliberately generous.
 * - Unmounted virtual rows are never treated as readable: the only way any
 *   variant sees a row is by actually mounting it in the viewport.
 * - Baseline and optimized answer over the same visited data and the same
 *   targets; result sets are cross-checked by the driver.
 */
(function () {
  "use strict";

  const vp = () => document.getElementById("list-viewport");
  const root = () => document.getElementById("contact-list");
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const PERSIST_KEY = "bench:index";

  function tokensOf(text) {
    return text.toLowerCase().split(/\s+/).filter(Boolean);
  }
  function matchText(fields, id, tokens) {
    const hay = (id + " " + Object.values(fields).join(" ")).toLowerCase();
    return tokens.every((t) => hay.includes(t));
  }

  /* Scroll top -> bottom in viewport-height steps, awaiting rendering at each
   * stop, invoking cb(rootEl) per stop. Returns the number of stops. */
  async function sweep(cb) {
    const v = vp(), rt = root();
    v.scrollTop = 0;
    await raf2();
    let stops = 0;
    for (let top = 0; ; top += v.clientHeight) {
      v.scrollTop = top;
      await raf2();
      stops++;
      if (cb) await cb(rt);
      if (v.scrollTop + v.clientHeight >= rt.offsetHeight - 1) break;
    }
    return stops;
  }

  // -- subtest 1: query over visited data ----------------------------------

  async function baselineQuery(text) {
    const tokens = tokensOf(text);
    const t0 = performance.now();
    const seen = new Map();
    const stops = await sweep((rt) => {
      for (const r of AFN.mockAdapter.extractRecords(rt).records) seen.set(r.id, r.fields);
    });
    const matches = [];
    for (const [id, f] of seen) if (matchText(f, id, tokens)) matches.push(id);
    matches.sort();
    return { ms: performance.now() - t0, matches, rowsRead: seen.size, stops };
  }

  /* The "cheap but wrong-task" variant: searches only currently mounted rows.
   * Reported for completeness percentage, not as an equal-task baseline. */
  function mountedOnlyQuery(text) {
    const tokens = tokensOf(text);
    const t0 = performance.now();
    const rows = AFN.mockAdapter.extractRecords(root()).records;
    const matches = rows.filter((r) => matchText(r.fields, r.id, tokens)).map((r) => r.id).sort();
    return { ms: performance.now() - t0, matches, rowsRead: rows.length };
  }

  async function optimizedQuery(text) {
    const t0 = performance.now();
    const records = await window.__H.index();
    const out = AFN.query.queryRecords(records, { text }, {});
    return {
      ms: performance.now() - t0,
      matches: out.map((m) => m.record.id).sort(),
      rowsRead: 0,
    };
  }

  // -- subtest 2: locate a target record ------------------------------------

  async function resetScroll() {
    vp().scrollTop = 0;
    await raf2();
  }

  /* Agent without an index: read window-by-window from the top until the
   * target row is mounted. */
  async function baselineLocate(id) {
    const v = vp(), rt = root();
    const t0 = performance.now();
    v.scrollTop = 0;
    await raf2();
    for (let top = 0; ; top += v.clientHeight) {
      v.scrollTop = top;
      await raf2();
      const el = document.querySelector('[data-contact-id="' + CSS.escape(id) + '"]');
      if (el) return { ms: performance.now() - t0, found: true };
      if (v.scrollTop + v.clientHeight >= rt.offsetHeight - 1) break;
    }
    return { ms: performance.now() - t0, found: false };
  }

  // -- subtest 3: incremental update / full rebuild --------------------------

  async function baselineRebuild() {
    const t0 = performance.now();
    const seen = new Map();
    const stops = await sweep((rt) => {
      for (const r of AFN.mockAdapter.extractRecords(rt).records) seen.set(r.id, r.fields);
    });
    return { ms: performance.now() - t0, rowsRead: seen.size, stops };
  }

  // -- subtest 4: state restore after reload ---------------------------------

  async function persistIndex() {
    const records = await window.__H.index();
    localStorage.setItem(PERSIST_KEY, JSON.stringify(records));
    return Object.keys(records).length;
  }

  /* Approximates the extension's chrome.storage.local read with a
   * localStorage read + parse; real chrome.storage adds a few ms of IPC.
   * Reported as such in the driver. */
  function optimizedRestore() {
    const t0 = performance.now();
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return { ms: performance.now() - t0, n: 0, ok: false };
    const records = JSON.parse(raw);
    return { ms: performance.now() - t0, n: Object.keys(records).length, ok: true };
  }

  // -- shared driving --------------------------------------------------------

  /* Drives batched loading until loadedCount >= target. Includes the site's
   * simulated network delays — both sides pay them where the task needs data
   * that is not loaded yet. In manual mode batches are requested explicitly;
   * otherwise the scroll trigger is used. */
  async function driveLoadTo(target) {
    const t0 = performance.now();
    const site = window.__MOCK_SITE__;
    const v = vp(), rt = root();
    while (site.loadedCount < target) {
      const prev = site.loadedCount;
      if (site.params.manual) {
        site.loadNextBatch();
      } else {
        v.scrollTop = rt.offsetHeight;
        await raf2();
      }
      const deadline = performance.now() + 15000;
      while (site.loadedCount === prev) {
        if (performance.now() > deadline) return { ms: performance.now() - t0, ok: false };
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    return { ms: performance.now() - t0, ok: true, loaded: site.loadedCount };
  }

  /* Builds the index over the currently loaded range by sweeping and scanning
   * at every stop (the "user visited everything once" premise). */
  async function indexSweep() {
    const t0 = performance.now();
    const stops = await sweep(() => window.__H.scan("sweep"));
    return { ms: performance.now() - t0, stops, indexed: window.__H.stats.total };
  }

  /* Incremental update: index only the newly loaded region (from a given
   * canvas offset to the bottom), scanning at each stop. Ends with the same
   * knowledge of the loaded range as a full rebuild — that is the equal-task
   * requirement — while touching only the delta rows. */
  async function deltaIndexSweep(fromTop) {
    const v = vp(), rt = root();
    const t0 = performance.now();
    const start = Math.max(0, fromTop);
    v.scrollTop = start;
    await raf2();
    let stops = 0;
    for (let top = start; ; top += v.clientHeight) {
      v.scrollTop = top;
      await raf2();
      stops++;
      await window.__H.scan("delta");
      if (v.scrollTop + v.clientHeight >= rt.offsetHeight - 1) break;
    }
    return { ms: performance.now() - t0, stops, indexed: window.__H.stats.total };
  }

  function canvasHeight() {
    return root().offsetHeight;
  }
  function viewportHeight() {
    return vp().clientHeight;
  }

  window.__BENCH = {
    baselineQuery, mountedOnlyQuery, optimizedQuery,
    resetScroll, baselineLocate,
    baselineRebuild,
    persistIndex, optimizedRestore,
    driveLoadTo, indexSweep, deltaIndexSweep,
    canvasHeight, viewportHeight,
  };
})();
