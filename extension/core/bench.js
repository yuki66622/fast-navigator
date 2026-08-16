/* Benchmark instrumentation: every core operation that M2 will measure goes
 * through here, so baseline and optimized paths report timings the same way. */
(function (global) {
  "use strict";

  function createBench(now) {
    const clock = now || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    const entries = [];
    return {
      async time(name, fn, meta) {
        const t0 = clock();
        const result = await fn();
        entries.push({ name, ms: clock() - t0, meta: meta || null, at: Date.now() });
        return result;
      },
      mark(name, ms, meta) {
        entries.push({ name, ms, meta: meta || null, at: Date.now() });
      },
      entries: () => entries.slice(),
      clear: () => { entries.length = 0; },
    };
  }

  const api = { createBench };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.AFN = global.AFN || {};
  global.AFN.bench = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
