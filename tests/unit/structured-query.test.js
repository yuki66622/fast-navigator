"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { queryRecords } = require("../../extension/core/query.js");
const { mergeRecords } = require("../../extension/core/indexer.js");

const SRC = { adapterId: "mock", url: "http://x/", route: "list", scannedAt: 1 };

function idx() {
  return mergeRecords({}, [
    { id: "c-1", fields: { name: "Ada Chen", company: "Acme AI", role: "Founder", location: "Berlin, Germany" } },
    { id: "c-2", fields: { name: "Ben Diaz", company: "Beacon Labs", role: "CTO", location: "New York" } },
    { id: "c-3", fields: { name: "Cara Egan", company: "Acme AI", role: "VP Engineering", location: "Berlin, Germany" } },
    { id: "c-4", fields: { name: "Dan Ito", company: "Driftwave", role: "Engineering Intern", location: "Berlin, Germany" } },
  ], SRC).records;
}

const run = (structured, text) =>
  queryRecords(idx(), { text: text || "", structured }, {}).map((m) => m.record.id);

test("groups OR within, AND across", () => {
  assert.deepEqual(
    run({ all: [{ anyOf: ["cto", "vp engineering"] }, { anyOf: ["berlin"] }] }),
    ["c-3"], "technical leader in Berlin"
  );
  assert.deepEqual(run({ all: [{ anyOf: ["founder", "cto"] }] }), ["c-1", "c-2"]);
});

test("field scoping restricts a group to one field", () => {
  // "engineering" appears in c-3's role and c-4's role; scoping to company matches neither
  assert.deepEqual(run({ all: [{ anyOf: ["engineering"], field: "company" }] }), []);
  assert.deepEqual(run({ all: [{ anyOf: ["acme"], field: "company" }] }), ["c-1", "c-3"]);
  // unknown field key falls back to the full haystack instead of failing
  assert.deepEqual(run({ all: [{ anyOf: ["berlin"], field: "no_such_field" }] }), ["c-1", "c-3", "c-4"]);
});

test("none excludes anywhere", () => {
  assert.deepEqual(
    run({ all: [{ anyOf: ["berlin"] }], none: ["intern"] }),
    ["c-1", "c-3"]
  );
});

test("structured composes with text tokens (AND)", () => {
  assert.deepEqual(run({ all: [{ anyOf: ["berlin"] }] }, "acme"), ["c-1", "c-3"]);
  assert.deepEqual(run({ all: [{ anyOf: ["berlin"] }] }, "beacon"), []);
});

test("malformed pieces are ignored, never throw", () => {
  assert.deepEqual(run({ all: [null, { anyOf: [] }, { anyOf: [42, "  "] }], none: [null] }).length, 4);
  assert.equal(run("not-an-object").length, 4);
  assert.equal(run({ all: "nope", none: "nope" }).length, 4);
});
