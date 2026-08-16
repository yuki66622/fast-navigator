/* Background service worker: on toolbar click, open the side panel (must stay
 * inside the user-gesture call stack) and inject core + adapters + runtime
 * into the active tab. No host permissions: activeTab only. */

const INJECT_FILES = [
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
  "content/runtime.js",
];

chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id) return;
  // Open the side panel inside the toolbar-click user-gesture call stack. Wrap it
  // in its own try/catch so a SYNCHRONOUS throw (not just a rejected promise) can
  // never abort the listener before injection runs; also handle async rejection.
  try {
    const opening = chrome.sidePanel.open({ tabId: tab.id });
    if (opening && typeof opening.catch === "function") {
      opening.catch((e) => console.warn("AFN: side panel open failed:", e && e.message));
    }
  } catch (e) {
    console.warn("AFN: side panel open threw:", e && e.message);
  }
  // Always inject — regardless of whether sidePanel.open succeeded, rejected
  // asynchronously, or threw synchronously above.
  chrome.scripting
    .executeScript({ target: { tabId: tab.id }, files: INJECT_FILES })
    .catch((e) => {
      // chrome:// pages, the web store, etc. are not injectable — that's fine.
      console.warn("AFN: inject failed:", e && e.message);
    });
});
