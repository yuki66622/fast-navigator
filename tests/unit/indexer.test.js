"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mergeRecords, recordKey } = require("../../extension/core/indexer.js");

const SRC = { adapterId: "mock", url: "http://x/", route: "list", scannedAt: 1000 };

function rec(id, name) {
  return { id, fields: { name, company: "Acme" } };
}

test("merge into empty index adds all records with firstSeenAt", () => {
  const r = mergeRecords({}, [rec("c-1", "Ada"), rec("c-2", "Ben")], SRC);
  assert.equal(r.added, 2);
  assert.equal(r.updated, 0);
  assert.equal(r.unchanged, 0);
  const k = recordKey("mock", "c-1");
  assert.equal(r.records[k].fields.name, "Ada");
  assert.equal(r.records[k].source.firstSeenAt, 1000);
  assert.equal(r.records[k].source.scannedAt, 1000);
});

test("re-merging identical fields counts unchanged but refreshes scannedAt", () => {
  const first = mergeRecords({}, [rec("c-1", "Ada")], SRC);
  const later = { ...SRC, scannedAt: 2000 };
  const r = mergeRecords(first.records, [rec("c-1", "Ada")], later);
  assert.equal(r.added, 0);
  assert.equal(r.unchanged, 1);
  const k = recordKey("mock", "c-1");
  assert.equal(r.records[k].source.scannedAt, 2000);
  assert.equal(r.records[k].source.firstSeenAt, 1000, "firstSeenAt must survive rescans");
});

test("changed fields count as updated", () => {
  const first = mergeRecords({}, [rec("c-1", "Ada")], SRC);
  const r = mergeRecords(first.records, [rec("c-1", "Ada Lovelace")], { ...SRC, scannedAt: 2000 });
  assert.equal(r.updated, 1);
  assert.equal(r.records[recordKey("mock", "c-1")].fields.name, "Ada Lovelace");
});

test("merge is incremental: existing records survive scans that do not see them", () => {
  // virtual list scenario: scan 2 only has rows 3-4 mounted; rows 1-2 must persist
  const s1 = mergeRecords({}, [rec("c-1", "A"), rec("c-2", "B")], SRC);
  const s2 = mergeRecords(s1.records, [rec("c-3", "C"), rec("c-4", "D")], { ...SRC, scannedAt: 2000 });
  assert.equal(Object.keys(s2.records).length, 4);
  assert.equal(s2.added, 2);
});

test("records without id are skipped; input map is not mutated", () => {
  const existing = {};
  const r = mergeRecords(existing, [{ id: null, fields: {} }, rec("c-1", "A")], SRC);
  assert.equal(r.added, 1);
  assert.deepEqual(existing, {}, "mergeRecords must be pure");
});

test("same page id under different adapters does not collide", () => {
  const a = mergeRecords({}, [rec("c-1", "A")], SRC);
  const b = mergeRecords(a.records, [rec("c-1", "Other")], { ...SRC, adapterId: "othersite" });
  assert.equal(Object.keys(b.records).length, 2);
});
