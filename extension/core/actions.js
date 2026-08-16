/* Generic page-action layer (site-agnostic).
 *
 * A "page action" is a deterministic DOM operation (navigate, read, click,
 * reveal) executed directly against the current tab — no vision, no cursor
 * movement, no coordinates. The core enforces the guarantees that make this
 * safe for an agent to drive:
 *   - the acting adapter must own the current URL (else `wrong-page`);
 *   - target elements are resolved to EXACTLY ONE visible node — 0 -> `not-found`,
 *     >1 -> `ambiguous` (the action stops instead of guessing);
 *   - every click is followed by an explicit wait for a completion condition
 *     (route change / DOM mutation / target state), never "click then assume";
 *   - login / captcha / permission walls -> `blocked` (stop, report, never bypass);
 *   - a missing structural anchor -> `structure-changed`;
 *   - a hard per-action timeout -> `timeout`;
 *   - every run returns a structured result with elapsed ms and a step trace.
 *
 * All site-specific knowledge (selectors, routes, action bodies) lives in the
 * adapter's `actions` map. The core never contains a selector or page string.
 */
(function (global) {
  "use strict";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* Typed failure an action body throws; `reason` is the machine-readable code
   * the core surfaces verbatim. */
  class ActionError extends Error {
    constructor(reason, message, detail) {
      super(message || reason);
      this.name = "ActionError";
      this.reason = reason;
      this.detail = detail || null;
    }
  }

  function isVisible(el) {
    if (!el || typeof el.getClientRects !== "function") return false;
    if (el.hidden) return false;
    const rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;
    const win = (el.ownerDocument && el.ownerDocument.defaultView) || global;
    if (win && typeof win.getComputedStyle === "function") {
      const cs = win.getComputedStyle(el);
      if (cs && (cs.visibility === "hidden" || cs.display === "none")) return false;
    }
    return true;
  }

  function makeHelpers(doc, win, trace, clock, t0, defaultTimeout) {
    const elapsed = () => Math.round(clock() - t0);
    function log(step, info) { trace.push(Object.assign({ step, ms: elapsed() }, info || {})); }

    async function settle() {
      await Promise.race([
        new Promise((r) =>
          win && typeof win.requestAnimationFrame === "function"
            ? win.requestAnimationFrame(() => win.requestAnimationFrame(r))
            : r()
        ),
        sleep(150),
      ]);
      await sleep(20);
    }

    function collect(selector, opts) {
      opts = opts || {};
      const within = opts.within || doc;
      let els = Array.from(within.querySelectorAll(selector));
      if (opts.filter) els = els.filter(opts.filter);
      if (opts.visibleOnly !== false) els = els.filter(isVisible);
      return els;
    }

    /* Resolve exactly one visible element. Ambiguity is a hard stop. */
    function unique(selector, opts) {
      opts = opts || {};
      const label = opts.describe || selector;
      const els = collect(selector, opts);
      if (els.length === 0) throw new ActionError("not-found", "no visible element for " + label, { target: label });
      if (els.length > 1) throw new ActionError("ambiguous", els.length + " elements match " + label + " — refusing to guess", { target: label, count: els.length });
      log("resolve", { target: label });
      return els[0];
    }

    /* A structural anchor that MUST exist for this page type; its absence means
     * the page is not shaped as expected. */
    function requireAnchor(selector, opts) {
      opts = opts || {};
      const label = (opts && opts.describe) || selector;
      const els = collect(selector, opts);
      if (els.length === 0) throw new ActionError("structure-changed", "expected page anchor missing: " + label, { anchor: label });
      log("anchor", { anchor: label });
      return els[0];
    }

    function optional(selector, opts) {
      const els = collect(selector, opts);
      return els.length ? els[0] : null;
    }

    function click(el, describe) {
      if (!el) throw new ActionError("not-found", "click target missing: " + (describe || ""));
      el.click();
      log("click", { target: describe || null });
    }

    /* Poll a predicate until truthy or timeout. Returns the truthy value. */
    async function waitFor(fn, opts) {
      opts = opts || {};
      const timeout = opts.timeout || defaultTimeout;
      const interval = opts.interval || 50;
      const deadline = clock() + timeout;
      let v = fn();
      while (!v) {
        if (clock() > deadline) throw new ActionError("timeout", "waited " + timeout + "ms for " + (opts.describe || "condition"), { waitedFor: opts.describe || null, timeout });
        await sleep(interval);
        v = fn();
      }
      log("wait", { for: opts.describe || null });
      return v;
    }

    /* Wait for the URL to satisfy a predicate (route change after a click). */
    async function waitForRoute(pred, opts) {
      opts = opts || {};
      return waitFor(
        () => {
          const href = (win && win.location && win.location.href) || (doc.location && doc.location.href) || "";
          return pred(href) ? href : null;
        },
        { timeout: opts.timeout, describe: opts.describe || "route change" }
      );
    }

    function text(el) { return el ? el.textContent.trim() : ""; }

    return { collect, unique, requireAnchor, optional, click, waitFor, waitForRoute, text, settle, isVisible, log, ActionError };
  }

  /* Run a single named action. cfg: {adapter, name, args, doc, win?, now?, timeoutMs?} */
  async function runAction(cfg) {
    const { adapter, name } = cfg;
    const doc = cfg.doc;
    const win = cfg.win || (doc && doc.defaultView) || (typeof window !== "undefined" ? window : null);
    const clock = cfg.now || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    const args = cfg.args || {};
    const defaultTimeout = cfg.timeoutMs || 15000;
    const t0 = clock();
    const trace = [];
    const url = (win && win.location && win.location.href) || (doc && doc.location && doc.location.href) || "";

    const done = (status, extra) =>
      Object.assign({ ok: status === "success", action: name, status, ms: Math.round(clock() - t0), url, trace }, extra || {});
    const fail = (reason, detail) => done("failure", { reason, detail: detail || null });

    if (!adapter) return fail("no-adapter", "no adapter is active on this page");
    try {
      if (!adapter.matches(url, doc)) return fail("wrong-page", "current page is not handled by adapter '" + adapter.adapterId + "'");
    } catch (e) {
      return fail("wrong-page", "adapter.matches threw: " + (e && e.message));
    }

    const actions = adapter.actions || {};
    if (typeof actions[name] !== "function") {
      return fail("unknown-action", { message: "adapter '" + adapter.adapterId + "' has no action '" + name + "'", available: Object.keys(actions) });
    }

    // Login / captcha / permission walls: stop and report, never bypass.
    if (typeof adapter.detectBlockers === "function") {
      let blocker = null;
      try { blocker = adapter.detectBlockers(doc); } catch (_e) { blocker = null; }
      if (blocker) return fail("blocked", { message: "page requires the user to act: " + blocker, blocker });
    }

    const h = makeHelpers(doc, win, trace, clock, t0, defaultTimeout);
    let guardTimer = null;
    const guard = new Promise((_resolve, reject) => {
      guardTimer = setTimeout(() => reject(new ActionError("timeout", "action exceeded " + defaultTimeout + "ms")), defaultTimeout + 1000);
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => actions[name]({ doc, win, args, h, ActionError })),
        guard,
      ]);
      if (guardTimer) clearTimeout(guardTimer);
      return done("success", { result: result === undefined ? null : result });
    } catch (e) {
      if (guardTimer) clearTimeout(guardTimer);
      if (e && e.reason) return fail(e.reason, e.detail != null ? e.detail : e.message);
      return fail("error", (e && e.message) || String(e));
    }
  }

  /* What actions this adapter offers on the current page (for discovery). */
  function listActions(adapter) {
    if (!adapter || !adapter.actions) return [];
    return Object.keys(adapter.actions).map((name) => {
      const meta = (adapter.actionsMeta && adapter.actionsMeta[name]) || {};
      return { name, description: meta.description || "", args: meta.args || {} };
    });
  }

  const api = { runAction, listActions, ActionError, isVisible };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.AFN = global.AFN || {};
  global.AFN.actions = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
