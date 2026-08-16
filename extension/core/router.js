/* Route watcher. Content scripts cannot observe the page's pushState calls
 * (isolated world), so we rely on: Navigation API events when available,
 * popstate/hashchange listeners, and a polling safety net. Deduplicates by URL. */
(function (global) {
  "use strict";

  function createRouteWatcher({ win, onChange, pollMs }) {
    const interval = pollMs || 500;
    let lastHref = null;
    let timer = null;
    const listeners = [];

    function check() {
      const href = win.location.href;
      if (href !== lastHref) {
        lastHref = href;
        onChange(href);
      }
    }

    function listen(target, event) {
      if (!target || typeof target.addEventListener !== "function") return;
      const handler = () => check();
      target.addEventListener(event, handler);
      listeners.push([target, event, handler]);
    }

    return {
      start() {
        lastHref = win.location.href;
        listen(win, "popstate");
        listen(win, "hashchange");
        if (win.navigation) listen(win.navigation, "currententrychange");
        timer = setInterval(check, interval);
      },
      stop() {
        for (const [t, e, h] of listeners) t.removeEventListener(e, h);
        listeners.length = 0;
        if (timer !== null) { clearInterval(timer); timer = null; }
      },
      check, // exposed for tests and manual triggering
      current: () => lastHref,
    };
  }

  const api = { createRouteWatcher };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.AFN = global.AFN || {};
  global.AFN.router = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
