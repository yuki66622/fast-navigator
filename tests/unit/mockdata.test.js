"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateContacts } = require("../../mock-site/data.js");

test("same seed -> identical dataset (reproducible tests and benchmarks)", () => {
  const a = generateContacts(200, 42);
  const b = generateContacts(200, 42);
  assert.deepEqual(a, b);
});

test("different seed -> different dataset", () => {
  const a = generateContacts(200, 42);
  const b = generateContacts(200, 43);
  assert.notDeepEqual(a, b);
});

test("count respected, ids sequential and unique", () => {
  const a = generateContacts(50, 1);
  assert.equal(a.length, 50);
  assert.equal(a[0].id, "c-1");
  assert.equal(a[49].id, "c-50");
  assert.equal(new Set(a.map((c) => c.id)).size, 50);
  for (const c of a) {
    assert.ok(c.name && c.company && c.role && c.location, "all fields populated");
  }
});
