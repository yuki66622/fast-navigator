"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { assessScan } = require("../../extension/core/health.js");

test("no adapter -> error/no-adapter", () => {
  const h = assessScan({ adapterMatched: false });
  assert.equal(h.level, "error");
  assert.equal(h.code, "no-adapter");
});

test("roots missing -> error/structure-changed", () => {
  const h = assessScan({ adapterMatched: true, rootsFound: 0, recordCount: 0, extractionMode: "none" });
  assert.equal(h.level, "error");
  assert.equal(h.code, "structure-changed");
});

test("roots present but zero records -> explicit error, never silent empty", () => {
  const h = assessScan({ adapterMatched: true, rootsFound: 1, recordCount: 0, extractionMode: "none" });
  assert.equal(h.level, "error");
  assert.equal(h.code, "structure-changed");
});

test("fallback extraction -> warning", () => {
  const h = assessScan({ adapterMatched: true, rootsFound: 1, recordCount: 10, extractionMode: "fallback" });
  assert.equal(h.level, "warning");
  assert.equal(h.code, "fallback-extraction");
});

test("healthy scan -> ok", () => {
  const h = assessScan({ adapterMatched: true, rootsFound: 1, recordCount: 25, extractionMode: "primary" });
  assert.equal(h.level, "ok");
});
