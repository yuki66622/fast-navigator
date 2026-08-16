/* Content runtime: thin glue between chrome messaging and the core.
 * Injected on demand (activeTab); guards against double injection. */
(function () {
  "use strict";

  if (window.__AFN_RUNTIME__) {
    window.__AFN_RUNTIME__.rescan("reinject");
    return;
  }

  const KEYS = AFN.scanner.STORAGE_KEYS;
  const platform = AFN.platform.createChromePlatform();
  const bench = AFN.bench.createBench(() => performance.now());
  const adapter = AFN.adapters.select(location.href, document);

  if (!adapter) {
    platform.storageSet({
      [KEYS.meta]: {
        adapterId: null,
        url: location.href,
        health: AFN.health.assessScan({ adapterMatched: false }),
        lastScan: null,
        counters: null,
      },
    });
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === "afn:ping") sendResponse({ ok: true, adapterId: null, url: location.href });
      if (msg && msg.type === "afn:capabilities") sendResponse({ ok: true, adapterId: null, url: location.href, actions: [] });
      if (msg && msg.type === "afn:action") sendResponse({ ok: false, action: msg.name, status: "failure", reason: "no-adapter", url: location.href });
    });
    window.__AFN_RUNTIME__ = { rescan() {} };
    return;
  }

  let route = adapter.onRouteChange(location.href);

  const scanner = AFN.scanner.createScanner({
    adapter,
    platform,
    doc: document,
    bench,
    getRoute: () => (route && route.view) || null,
  });

  const watcher = AFN.router.createRouteWatcher({
    win: window,
    onChange: (href) => {
      route = adapter.onRouteChange(href);
      scanner.scanNow("route");
    },
  });

  scanner.start();
  watcher.start();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "afn:ping") {
      sendResponse({ ok: true, adapterId: adapter.adapterId, url: location.href });
      return;
    }
    if (msg.type === "afn:capabilities") {
      sendResponse({
        ok: true,
        adapterId: adapter.adapterId,
        url: location.href,
        actions: AFN.actions.listActions(adapter),
      });
      return;
    }
    if (msg.type === "afn:action") {
      AFN.actions
        .runAction({
          adapter,
          name: msg.name,
          args: msg.args || {},
          doc: document,
          win: window,
          now: () => performance.now(),
          timeoutMs: msg.timeoutMs,
        })
        .then((r) => {
          bench.mark("action:" + msg.name, r.ms, { status: r.status, reason: r.reason || null });
          sendResponse(r);
        });
      return true;
    }
    if (msg.type === "afn:rescan") {
      scanner.scanNow("manual").then((r) => sendResponse(r || { queued: true }));
      return true;
    }
    if (msg.type === "afn:locate") {
      AFN.locator
        .locateRecord({ id: msg.id, adapter, doc: document, now: () => performance.now() })
        .then((r) => {
          bench.mark("locate", r.ms, { id: msg.id, status: r.status });
          sendResponse(r);
        });
      return true;
    }
    if (msg.type === "afn:bench") {
      sendResponse({ entries: bench.entries(), counters: scanner.getCounters() });
      return;
    }
  });

  window.__AFN_RUNTIME__ = {
    rescan: (reason) => scanner.scanNow(reason || "manual"),
  };
})();
