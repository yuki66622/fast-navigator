/* Adapter registry: the boundary where site knowledge plugs into the core. */
(function (global) {
  "use strict";

  const list = [];

  const api = {
    register(adapter) { list.push(adapter); },
    select(url, doc) {
      for (const a of list) {
        try { if (a.matches(url, doc)) return a; } catch (_e) { /* a broken matcher must not break selection */ }
      }
      return null;
    },
    all: () => list.slice(),
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.AFN = global.AFN || {};
  global.AFN.adapters = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
