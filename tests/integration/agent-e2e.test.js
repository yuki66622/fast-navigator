"use strict";
/* V3 end-to-end: MCP client -> mcp_server.py -> HTTP bridge -> real side panel
 * (extension loaded in Chromium) -> core. Covers search / stats / status /
 * parse_query denial, and the locate error path (activeTab injection cannot be
 * automated, so locate's success path is covered by adapter tests instead). */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { EXT_DIR } = require("./helpers.js");
const { mergeRecords } = require("../../extension/core/indexer.js");
const { McpClient, toolPayload } = require("./mcp-client.js");

const PORT = 18600 + Math.floor(Math.random() * 90);
let client, context, userDataDir, extId, sw;

before(async () => {
  client = new McpClient({ AGENT_BRIDGE_PORT: String(PORT), AGENT_CALL_TIMEOUT: "20" });
  await client.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  client.notify("notifications/initialized");

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "afn-agent-test-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: ["--disable-extensions-except=" + EXT_DIR, "--load-extension=" + EXT_DIR],
  });
  sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  extId = new URL(sw.url()).host;

  const recs = [
    { id: "c-1", fields: { name: "Ada Chen", company: "Acme AI", role: "Founder", location: "Berlin, Germany" } },
    { id: "c-2", fields: { name: "Ben Diaz", company: "Beacon Labs", role: "CTO", location: "New York" } },
    { id: "c-3", fields: { name: "Cara Egan", company: "Acme AI", role: "Co-Founder", location: "London, UK" } },
  ];
  const { records } = mergeRecords({}, recs, { adapterId: "mock", url: "http://mock/", route: "list", scannedAt: Date.now() });
  await sw.evaluate(
    (data) => chrome.storage.local.set(data),
    {
      "afn:index": { records },
      "afn:settings": { agentBridge: true, bridgeUrl: "http://127.0.0.1:" + PORT, sidecarUrl: "http://127.0.0.1:1" },
    }
  );

  const panel = await context.newPage();
  await panel.goto("chrome-extension://" + extId + "/sidepanel/sidepanel.html");
  for (let i = 0; i < 100; i++) {
    const s = await (await fetch("http://127.0.0.1:" + PORT + "/v1/agent/status")).json();
    if (s.panelConnected) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("panel never connected to the agent bridge");
});

after(async () => {
  if (context) await context.close();
  if (client) client.kill();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

async function call(name, args) {
  const t0 = Date.now();
  const resp = await client.request("tools/call", { name, arguments: args || {} });
  return { resp, payload: toolPayload(resp), ms: Date.now() - t0 };
}

test("get_index_stats reflects the seeded index", async () => {
  const { resp, payload, ms } = await call("get_index_stats");
  assert.notEqual(resp.result.isError, true, JSON.stringify(payload));
  assert.equal(payload.totalRecords, 3);
  console.log("    stats round-trip: " + ms + "ms");
});

test("search_records: text and structured queries through the real engine", async () => {
  const text = await call("search_records", { query: "acme" });
  assert.equal(text.payload.total, 2);
  assert.deepEqual(text.payload.records.map((r) => r.fields.name).sort(), ["Ada Chen", "Cara Egan"]);

  const structured = await call("search_records", {
    structured: { all: [{ anyOf: ["founder", "co-founder"], field: "role" }, { anyOf: ["berlin"], field: "location" }] },
  });
  assert.equal(structured.payload.total, 1);
  assert.equal(structured.payload.records[0].fields.name, "Ada Chen");
  console.log("    search round-trip: " + structured.ms + "ms");
});

test("set_record_status persists to real extension storage", async () => {
  const { payload } = await call("set_record_status", { id: "c-2", status: "done" });
  assert.equal(payload.status, "done");
  const stored = await sw.evaluate(async () => (await chrome.storage.local.get("afn:status"))["afn:status"]);
  assert.equal(stored["mock:c-2"].status, "done");

  const filtered = await call("search_records", { status: "done" });
  assert.equal(filtered.payload.total, 1);
  assert.equal(filtered.payload.records[0].id, "c-2");
});

test("failures come back as clean tool errors, not hangs", async () => {
  const locate = await call("locate_record", { id: "c-1" });
  assert.equal(locate.resp.result.isError, true);
  assert.match(locate.payload.error, /content script not active/);

  const parse = await call("parse_query", { text: "founders" }); // sidecarUrl points nowhere
  assert.equal(parse.resp.result.isError, true);

  const badStatus = await call("set_record_status", { id: "c-1", status: "bogus" });
  assert.equal(badStatus.resp.result.isError, true);
  assert.match(badStatus.payload.error, /invalid status/);
});
