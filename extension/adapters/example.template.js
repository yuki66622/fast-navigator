/* Adapter template — copy this file to adapters/<yoursite>/adapter.js and fill
 * in the parts marked TODO. It implements the full adapter interface the
 * generic kernel expects; nothing here is site-specific, so it is safe to ship
 * in a public repo. The kernel never needs to change: all site knowledge
 * (selectors, field names, id format, routing) lives ONLY in an adapter.
 *
 * IMPORTANT (compliance): this template contains no real website's selectors,
 * domain, page structure, or logic. When you adapt it to a real site, you are
 * responsible for complying with that site's terms of service, robots/anti-bot
 * policies, and applicable law. Keep the adapter read-only: extract only what
 * the user has already loaded and can see; do not click reveal buttons, do not
 * auto-navigate or auto-paginate, do not bypass auth or human verification.
 *
 * See adapters/mock/adapter.js for a complete working example, and debug/ for
 * the read-only structure probe that helps you discover selectors, record ids
 * and scan roots on your target page.
 */
(function (global) {
  "use strict";

  // TODO: a short, unique id for this adapter (used as the index key prefix).
  const ADAPTER_ID = "example";

  // -- helpers ---------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // rAF is throttled/suspended in background tabs — race it with a timeout so
  // locate never hangs when the tab is not focused.
  async function settle() {
    await Promise.race([
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      sleep(150),
    ]);
    await sleep(30);
  }

  const adapter = {
    adapterId: ADAPTER_ID,

    /* Which pages this adapter is responsible for. Prefer a robust signal
     * (host + a stable page marker) over brittle URL patterns.
     * TODO: return true only on your target site's relevant pages. */
    matches(url, doc) {
      try {
        // e.g. return new URL(url).host === "your-target-host";
        return false; // template matches nothing until you fill this in
      } catch (_e) {
        return false;
      }
    },

    /* The region(s) of the page that should be scanned. The kernel does NO
     * structural guessing — the adapter draws the boundary.
     * TODO: return the container element(s) that hold the record rows. */
    getScanRoots(doc) {
      // e.g. return Array.from(doc.querySelectorAll("YOUR_LIST_CONTAINER"));
      return [];
    },

    /* Turn a scan root's DOM into structured records.
     * Return { records: [{id, fields}], mode }, where mode is:
     *   "primary"  — your main selectors matched
     *   "fallback" — main selectors failed but you recovered fields another way
     *   "none"     — nothing extractable (the kernel will flag structure-changed)
     * Anchor on STABLE attributes (data-*, aria role, text labels, structure),
     * not on hashed build classes, which change on every deploy.
     * TODO: extract id + fields for each row. */
    extractRecords(root) {
      const records = [];
      // for (const row of root.querySelectorAll("YOUR_ROW_SELECTOR")) {
      //   const id = this.getRecordId({ /* … */ });
      //   if (!id) continue;
      //   records.push({ id, fields: { name: "", company: "", role: "", location: "" } });
      // }
      return { records, mode: records.length ? "primary" : "none" };
    },

    /* A STABLE unique id for a record — the basis for dedup, status and
     * incremental updates. Prefer a real entity id from the page (an id in a
     * detail link or a data-* attribute); fall back to a semantic composite
     * key only if you must (it risks collisions).
     * TODO: derive a stable id. */
    getRecordId(record) {
      return record && record.id ? String(record.id) : null;
    },

    /* Interpret this site's route semantics. The kernel owns the mechanism
     * (it hooks history API / hashchange and polls); the adapter only says what
     * a given URL means. Return {view: "list"|"detail"|"other", id?}.
     * TODO: classify list vs detail and extract a detail id if present. */
    onRouteChange(url) {
      return { view: "other" };
    },

    /* Bring the record with this id into view and hand the mounted element back
     * to the kernel (which highlights it and records timing). You MUST return an
     * explicit result. If the row is not currently reachable (e.g. it lives on
     * another page of a paged list), fail explicitly rather than auto-navigating
     * — auto-pagination crosses the read-only boundary.
     * For virtualized lists: drive the list container's scroll, wait for the
     * target to mount (settle / MutationObserver), then return it.
     * TODO: implement location for your page. */
    async scrollToRecord(id) {
      const doc = document;
      // const row = doc.querySelector('YOUR_ROW_SELECTOR_FOR[' + id + ']');
      const row = null;
      if (!row) return { status: "failure", reason: "not-found" };
      row.scrollIntoView({ block: "center" });
      await settle();
      return { status: "success", mountedTarget: row };
    },
  };

  // Register with the kernel. Do NOT register the template itself in production;
  // this guard keeps the unmodified template inert.
  if (ADAPTER_ID !== "example") {
    global.AFN = global.AFN || {};
    if (global.AFN.adapters && typeof global.AFN.adapters.register === "function") {
      global.AFN.adapters.register(adapter);
    }
  }

  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})(typeof globalThis !== "undefined" ? globalThis : window);
