/* Platform abstraction: the only place the core touches chrome.* APIs.
 * createMemoryPlatform lets the same core run in tests and in-page harnesses. */
(function (global) {
  "use strict";

  function createChromePlatform() {
    return {
      storageGet: (keys) => chrome.storage.local.get(keys),
      storageSet: (obj) => chrome.storage.local.set(obj),
      storageRemove: (keys) => chrome.storage.local.remove(keys),
      now: () => performance.now(),
    };
  }

  // Mimics chrome.storage.local.get/set semantics closely enough for the core.
  function createMemoryPlatform(initial) {
    const store = Object.assign({}, initial || {});
    function get(keys) {
      if (keys === null || keys === undefined) return Promise.resolve(Object.assign({}, store));
      if (typeof keys === "string") keys = [keys];
      const out = {};
      if (Array.isArray(keys)) {
        for (const k of keys) if (k in store) out[k] = store[k];
      } else {
        for (const k of Object.keys(keys)) out[k] = k in store ? store[k] : keys[k];
      }
      return Promise.resolve(out);
    }
    return {
      storageGet: get,
      storageSet: (obj) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); return Promise.resolve(); },
      storageRemove: (keys) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
        return Promise.resolve();
      },
      now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
      _store: store,
    };
  }

  const api = { createChromePlatform, createMemoryPlatform };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.AFN = global.AFN || {};
  global.AFN.platform = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
