"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { queryRecords } = require("../../extension/core/query.js");
const { mergeRecords } = require("../../extension/core/indexer.js");

const SRC = { adapterId: "mock", url: "http://x/", route: "list", scannedAt: 1 };

function buildIndex() {
  const recs = [
    { id: "c-1", fields: { name: "Ada Chen", company: "Acme AI", role: "Founder", location: "Berlin" } },
    { id: "c-2", fields: { name: "Ben Diaz", company: "Beacon Labs", role: "CTO", location: "New York" } },
    { id: "c-10", fields: { name: "Cara Egan", company: "Acme AI", role: "Co-founder", location: "London" } },
  ];
  return mergeRecords({}, recs, SRC).records;
}

test("empty query returns everything, naturally sorted by id (c-2 before c-10)", () => {
  const out = queryRecords(buildIndex(), { text: "" }, {});
  assert.deepEqual(out.map((m) => m.record.id), ["c-1", "c-2", "c-10"]);
});

test("tokens AND-match across all fields, case-insensitively", () => {
  const out = queryRecords(buildIndex(), { text: "acme founder" }, {});
  assert.deepEqual(out.map((m) => m.record.id), ["c-1", "c-10"]);
  const narrower = queryRecords(buildIndex(), { text: "acme co-founder" }, {});
  assert.deepEqual(narrower.map((m) => m.record.id), ["c-10"]);
});

test("id is searchable", () => {
  const out = queryRecords(buildIndex(), { text: "c-2" }, {});
  assert.deepEqual(out.map((m) => m.record.id), ["c-2"]);
});

test("status filter joins the panel-owned status map; default is pending", () => {
  const idx = buildIndex();
  const statusMap = { "mock:c-1": { status: "done" } };
  assert.deepEqual(
    queryRecords(idx, { text: "", status: "done" }, statusMap).map((m) => m.record.id),
    ["c-1"]
  );
  assert.deepEqual(
    queryRecords(idx, { text: "", status: "pending" }, statusMap).map((m) => m.record.id),
    ["c-2", "c-10"]
  );
  assert.equal(queryRecords(idx, { text: "", status: "all" }, statusMap).length, 3);
});

test("no matches returns empty array, never throws", () => {
  assert.deepEqual(queryRecords(buildIndex(), { text: "zzz-nothing" }, {}), []);
  assert.deepEqual(queryRecords({}, { text: "x" }, {}), []);
});
