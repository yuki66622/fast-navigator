/* Query engine (pure): token AND-match over id + all field values,
 * optional structured query (V2: produced from natural language by the LLM
 * sidecar, but plain data — the engine stays deterministic), optional status
 * filter joined from the separate status map. */
(function (global) {
  "use strict";

  const DEFAULT_STATUS = "pending";

  function haystack(record) {
    return (record.id + " " + Object.values(record.fields).join(" ")).toLowerCase();
  }

  /* structured = { all: [{ anyOf: [term…], field?: key }…], none: [term…] }
   * Every group must have at least one matching term (OR within a group, AND
   * across groups); `field` scopes a group to one field value; `none` terms
   * must not appear anywhere. Substring, case-insensitive — same semantics as
   * text tokens. Malformed pieces are ignored rather than throwing. */
  function matchStructured(record, structured, hayAll) {
    if (!structured || typeof structured !== "object") return true;
    const groups = Array.isArray(structured.all) ? structured.all : [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.anyOf)) continue;
      const terms = g.anyOf.filter((t) => typeof t === "string" && t.trim()).map((t) => t.toLowerCase());
      if (!terms.length) continue;
      const scoped = g.field && record.fields[g.field] !== undefined
        ? String(record.fields[g.field]).toLowerCase()
        : hayAll;
      if (!terms.some((t) => scoped.includes(t))) return false;
    }
    const none = Array.isArray(structured.none) ? structured.none : [];
    for (const t of none) {
      if (typeof t === "string" && t.trim() && hayAll.includes(t.toLowerCase())) return false;
    }
    return true;
  }

  /**
   * @param records   {key: record} | record[]
   * @param q         {text?, structured?, status?}  status: "all" | "pending" | "viewed" | "done"
   * @param statusMap {key: {status}}   panel-owned; scanner never writes it
   * @returns array of {key, record, status} sorted naturally by id
   * text tokens and the structured query compose with AND when both are given.
   */
  function queryRecords(records, q, statusMap) {
    const list = Array.isArray(records)
      ? records.map((r, i) => ({ key: String(i), record: r }))
      : Object.keys(records).map((key) => ({ key, record: records[key] }));
    const tokens = (q && q.text ? q.text : "").toLowerCase().split(/\s+/).filter(Boolean);
    const structured = q && q.structured ? q.structured : null;
    const wantStatus = q && q.status && q.status !== "all" ? q.status : null;
    const out = [];
    for (const { key, record } of list) {
      const status = (statusMap && statusMap[key] && statusMap[key].status) || DEFAULT_STATUS;
      if (wantStatus && status !== wantStatus) continue;
      if (tokens.length || structured) {
        const hay = haystack(record);
        if (tokens.length && !tokens.every((t) => hay.includes(t))) continue;
        if (structured && !matchStructured(record, structured, hay)) continue;
      }
      out.push({ key, record, status });
    }
    out.sort((a, b) => a.record.id.localeCompare(b.record.id, undefined, { numeric: true }));
    return out;
  }

  const api = { queryRecords, matchStructured, DEFAULT_STATUS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.AFN = global.AFN || {};
  global.AFN.query = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
