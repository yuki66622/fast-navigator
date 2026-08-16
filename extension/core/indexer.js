/* Index merge logic (pure). The global index pool only ever grows or updates;
 * scanning never deletes records — unmounted rows in virtual lists stay indexed. */
(function (global) {
  "use strict";

  function recordKey(adapterId, id) {
    return adapterId + ":" + id;
  }

  function fieldsEqual(a, b) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (a[k] !== b[k]) return false;
    return true;
  }

  /**
   * @param existing  {key: record} current index (not mutated)
   * @param incoming  [{id, fields}] extracted from the page just now
   * @param source    {adapterId, url, route, scannedAt}
   * @returns {records, added, updated, unchanged}
   * Every incoming record refreshes source metadata (scannedAt/url/route);
   * added/updated/unchanged classify by identity and field content.
   */
  function mergeRecords(existing, incoming, source) {
    const records = Object.assign({}, existing);
    let added = 0, updated = 0, unchanged = 0;
    for (const rec of incoming) {
      if (!rec || !rec.id) continue;
      const key = recordKey(source.adapterId, rec.id);
      const prev = records[key];
      const next = {
        id: rec.id,
        fields: Object.assign({}, rec.fields),
        source: {
          adapterId: source.adapterId,
          url: source.url,
          route: source.route || null,
          scannedAt: source.scannedAt,
          firstSeenAt: prev ? prev.source.firstSeenAt : source.scannedAt,
        },
      };
      if (!prev) added++;
      else if (!fieldsEqual(prev.fields, next.fields)) updated++;
      else unchanged++;
      records[key] = next;
    }
    return { records, added, updated, unchanged };
  }

  const api = { mergeRecords, recordKey };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.AFN = global.AFN || {};
  global.AFN.indexer = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
