/* Generic locate/highlight executor. The adapter does the site-specific work
 * (driving virtual-list scroll, waiting for the row to mount) and must return
 * an explicit {status, mountedTarget}; the core highlights and reports timing. */
(function (global) {
  "use strict";

  const STYLE_ID = "afn-highlight-style";
  const HIGHLIGHT_CLASS = "afn-highlight";
  const HIGHLIGHT_MS = 2500;

  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "." + HIGHLIGHT_CLASS + " { outline: 3px solid #ff8800 !important; " +
      "outline-offset: -3px; box-shadow: 0 0 0 6px rgba(255,136,0,.25) !important; }";
    doc.documentElement.appendChild(style);
  }

  function highlight(doc, el) {
    ensureStyle(doc);
    el.classList.add(HIGHLIGHT_CLASS);
    setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS);
  }

  /**
   * @returns {status: "success"|"failure", reason?, ms}
   */
  async function locateRecord({ id, adapter, doc, now }) {
    const clock = now || (() => Date.now());
    const t0 = clock();
    let res;
    try {
      res = await adapter.scrollToRecord(id);
    } catch (e) {
      res = { status: "failure", reason: "adapter-error: " + (e && e.message) };
    }
    const ms = clock() - t0;
    if (res && res.status === "success" && res.mountedTarget) {
      highlight(doc, res.mountedTarget);
      return { status: "success", ms };
    }
    return { status: "failure", reason: (res && res.reason) || "not-found", ms };
  }

  const api = { locateRecord, highlight, HIGHLIGHT_CLASS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.AFN = global.AFN || {};
  global.AFN.locator = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
