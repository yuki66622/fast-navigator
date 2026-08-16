"use strict";
/* Sidecar HTTP contract, mock mode (deterministic, no key, no network). */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

const PORT = 18700 + Math.floor(Math.random() * 200);
const BASE = "http://127.0.0.1:" + PORT;
let proc;

async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + "/v1/health");
      if (r.ok) return r.json();
    } catch (_e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("sidecar did not become healthy");
}

async function parse(query, fields) {
  const r = await fetch(BASE + "/v1/parse-query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields ? { query, fields } : { query }),
  });
  return { status: r.status, cors: r.headers.get("access-control-allow-origin"), body: await r.json() };
}

before(async () => {
  proc = spawn("python3", [path.join(__dirname, "..", "..", "sidecar", "server.py")], {
    env: { ...process.env, MOCK_LLM: "1", SIDECAR_PORT: String(PORT) },
    stdio: "ignore",
  });
  const h = await waitHealthy();
  assert.equal(h.mode, "mock");
});

after(() => { if (proc) proc.kill(); });

test("role + location produce scoped OR-groups", async () => {
  const { status, cors, body } = await parse("find founders in berlin");
  assert.equal(status, 200);
  assert.equal(cors, "*", "CORS header required for the extension page fetch");
  assert.equal(body.source, "mock");
  const groups = body.structured.all;
  const role = groups.find((g) => g.field === "role");
  const loc = groups.find((g) => g.field === "location");
  assert.ok(role && role.anyOf.includes("founder") && role.anyOf.includes("co-founder"), JSON.stringify(groups));
  assert.ok(loc && loc.anyOf.includes("berlin"), JSON.stringify(groups));
});

test("negation lands in none (naively singularized)", async () => {
  const { body } = await parse("engineers not interns");
  assert.ok(body.structured.none.includes("intern"), JSON.stringify(body.structured));
  const role = body.structured.all.find((g) => g.field === "role");
  assert.ok(role && role.anyOf.includes("engineer"));
});

test("chinese keywords map through", async () => {
  const { body } = await parse("找柏林的创始人");
  const groups = body.structured.all;
  assert.ok(groups.some((g) => g.anyOf.includes("founder")), JSON.stringify(groups));
  assert.ok(groups.some((g) => g.anyOf.includes("berlin")), JSON.stringify(groups));
});

test("field scoping only uses caller-provided fields", async () => {
  const { body } = await parse("founders in berlin", ["name", "company"]);
  for (const g of body.structured.all) {
    assert.ok(!("field" in g) || ["name", "company"].includes(g.field), JSON.stringify(g));
  }
});

test("bad requests are 400, never 500", async () => {
  const { status } = await parse("");
  assert.equal(status, 400);
  const long = await parse("x".repeat(600));
  assert.equal(long.status, 400);
});

test("preflight OPTIONS succeeds with CORS headers", async () => {
  const r = await fetch(BASE + "/v1/parse-query", { method: "OPTIONS" });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.match(r.headers.get("access-control-allow-headers"), /Content-Type/);
});
