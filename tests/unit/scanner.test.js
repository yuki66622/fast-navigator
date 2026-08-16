"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createScanner, STORAGE_KEYS } = require("../../extension/core/scanner.js");
const { createMemoryPlatform } = require("../../extension/platform/platform.js");

function fakeAdapter(pages) {
  // pages: mutable { rows: [{id, fields}], mode, roots }
  return {
    adapterId: "fake",
    getScanRoots: () => new Array(pages.roots).fill({}),
    extractRecords: () => ({ records: pages.rows.slice(), mode: pages.mode }),
    onRouteChange: () => ({ view: "list" }),
    scrollToRecord: async () => ({ status: "failure", reason: "n/a" }),
    getRecordId: (r) => r.id,
  };
}

const DOC = { location: { href: "http://fake/" } };

test("scan persists index + meta; second scan merges incrementally", async () => {
  const pages = { roots: 1, mode: "primary", rows: [{ id: "c-1", fields: { name: "A" } }] };
  const platform = createMemoryPlatform();
  const scanner = createScanner({ adapter: fakeAdapter(pages), platform, doc: DOC, getRoute: () => "list" });

  const r1 = await scanner.scanNow("initial");
  assert.equal(r1.health.level, "ok");
  assert.equal(r1.lastScan.added, 1);

  pages.rows = [{ id: "c-2", fields: { name: "B" } }]; // c-1 no longer mounted
  const r2 = await scanner.scanNow("mutation");
  assert.equal(r2.lastScan.added, 1);

  const got = await platform.storageGet(STORAGE_KEYS.index);
  const keys = Object.keys(got[STORAGE_KEYS.index].records);
  assert.equal(keys.length, 2, "index pool accumulates across scans");

  const meta = (await platform.storageGet(STORAGE_KEYS.meta))[STORAGE_KEYS.meta];
  assert.equal(meta.counters.scans, 2);
  assert.equal(meta.adapterId, "fake");
  assert.equal(typeof meta.lastScan.durationMs, "number");
});

test("zero records with roots present -> error health, index untouched", async () => {
  const pages = { roots: 1, mode: "primary", rows: [{ id: "c-1", fields: { name: "A" } }] };
  const platform = createMemoryPlatform();
  const scanner = createScanner({ adapter: fakeAdapter(pages), platform, doc: DOC });
  await scanner.scanNow("initial");

  pages.rows = [];
  pages.mode = "none"; // simulates a structure change breaking extraction
  const r = await scanner.scanNow("mutation");
  assert.equal(r.health.level, "error");
  assert.equal(r.health.code, "structure-changed");

  const got = await platform.storageGet(STORAGE_KEYS.index);
  assert.equal(Object.keys(got[STORAGE_KEYS.index].records).length, 1, "existing index survives");
});

test("fallback mode surfaces as warning in persisted meta", async () => {
  const pages = { roots: 1, mode: "fallback", rows: [{ id: "c-1", fields: { name: "A" } }] };
  const platform = createMemoryPlatform();
  const scanner = createScanner({ adapter: fakeAdapter(pages), platform, doc: DOC });
  await scanner.scanNow("initial");
  const meta = (await platform.storageGet(STORAGE_KEYS.meta))[STORAGE_KEYS.meta];
  assert.equal(meta.health.level, "warning");
  assert.equal(meta.health.code, "fallback-extraction");
});

test("overlapping scanNow calls queue a trailing rescan instead of interleaving", async () => {
  const pages = { roots: 1, mode: "primary", rows: [{ id: "c-1", fields: { name: "A" } }] };
  const platform = createMemoryPlatform();
  // slow storage to force overlap
  const slowSet = platform.storageSet;
  platform.storageSet = async (obj) => { await new Promise((r) => setTimeout(r, 20)); return slowSet(obj); };
  const scanner = createScanner({ adapter: fakeAdapter(pages), platform, doc: DOC });

  const p1 = scanner.scanNow("initial");
  const p2 = scanner.scanNow("mutation"); // should queue, resolve null
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok(r1);
  assert.equal(r2, null);
  await new Promise((r) => setTimeout(r, 120)); // let the queued rescan finish
  const meta = (await platform.storageGet(STORAGE_KEYS.meta))[STORAGE_KEYS.meta];
  assert.equal(meta.counters.scans, 2, "queued rescan ran exactly once");
});
