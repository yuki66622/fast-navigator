"use strict";
/* MCP server protocol contract, no browser: initialize / tools list / call
 * forwarding through the HTTP bridge (a fake in-process "panel" long-polls
 * and answers), and the fail-fast path when no panel is connected. */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { McpClient, toolPayload } = require("./mcp-client.js");

const PORT = 18500 + Math.floor(Math.random() * 100);
const BRIDGE = "http://127.0.0.1:" + PORT;
let client;
let fakePanelRunning = false;

async function fakePanelLoop() {
  fakePanelRunning = true;
  while (fakePanelRunning) {
    try {
      const r = await fetch(BRIDGE + "/v1/agent/pull?wait=2");
      const body = await r.json();
      if (body.call) {
        await fetch(BRIDGE + "/v1/agent/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: body.call.id, ok: true, result: { echo: body.call.arguments, tool: body.call.name } }),
        });
      }
    } catch (_e) {
      await new Promise((res) => setTimeout(res, 100));
    }
  }
}

before(async () => {
  client = new McpClient({ AGENT_BRIDGE_PORT: String(PORT), AGENT_CALL_TIMEOUT: "5" });
  const init = await client.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.serverInfo.name, "fast-navigator");
  client.notify("notifications/initialized");
});

after(() => {
  fakePanelRunning = false;
  if (client) client.kill();
});

test("tools/list exposes the index and page-action tools with schemas", async () => {
  const resp = await client.request("tools/list");
  const names = resp.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "get_index_stats", "list_page_actions", "locate_record", "parse_query",
    "rescan_page", "run_page_action", "search_records", "set_record_status",
  ]);
  for (const t of resp.result.tools) {
    assert.equal(t.inputSchema.type, "object", t.name + " has a JSON schema");
    assert.ok(t.description.length > 20, t.name + " is described");
  }
});

test("tools/call without a connected panel fails fast with a clear hint", async () => {
  const resp = await client.request("tools/call", { name: "search_records", arguments: { query: "x" } });
  assert.equal(resp.result.isError, true);
  const payload = toolPayload(resp);
  assert.match(payload.error, /panel not connected/);
  assert.match(payload.hint, /Agent toggle/);
});

test("unknown tool is a JSON-RPC error", async () => {
  const resp = await client.request("tools/call", { name: "drop_database", arguments: {} });
  assert.ok(resp.error, "must be a protocol error, not a forwarded call");
  assert.match(resp.error.message, /unknown tool/);
});

test("bridge round-trip: call reaches the panel and the result returns", async () => {
  fakePanelLoop();
  // wait until the bridge counts the fake panel as connected
  for (let i = 0; i < 30; i++) {
    const s = await (await fetch(BRIDGE + "/v1/agent/status")).json();
    if (s.panelConnected) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const t0 = Date.now();
  const resp = await client.request("tools/call", { name: "search_records", arguments: { query: "founder berlin" } });
  const ms = Date.now() - t0;
  assert.notEqual(resp.result.isError, true, JSON.stringify(resp.result));
  const payload = toolPayload(resp);
  assert.equal(payload.tool, "search_records");
  assert.equal(payload.echo.query, "founder berlin");
  assert.ok(ms < 3000, "round-trip took " + ms + "ms");
  fakePanelRunning = false;
});
