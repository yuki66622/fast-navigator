/* Structure health check (pure). Hard rule: abnormal extraction results must
 * surface as explicit errors — never silently return an empty result. */
(function (global) {
  "use strict";

  /**
   * @param s {adapterMatched, rootsFound, recordCount, extractionMode}
   *   extractionMode: "primary" | "fallback" | "none"
   * @returns {level: "ok"|"warning"|"error", code, message}
   */
  function assessScan(s) {
    if (!s.adapterMatched) {
      return { level: "error", code: "no-adapter", message: "No adapter matches this page." };
    }
    if (s.rootsFound === 0) {
      return {
        level: "error", code: "structure-changed",
        message: "Scan roots not found — the page structure may have changed.",
      };
    }
    if (s.recordCount === 0) {
      return {
        level: "error", code: "structure-changed",
        message: "Scan roots exist but no records were extracted — the page structure may have changed.",
      };
    }
    if (s.extractionMode === "fallback") {
      return {
        level: "warning", code: "fallback-extraction",
        message: "Primary selectors failed; records were extracted via fallback heuristics. Verify field mapping.",
      };
    }
    return { level: "ok", code: "ok", message: "Scan looks healthy." };
  }

  const api = { assessScan };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.AFN = global.AFN || {};
  global.AFN.health = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
