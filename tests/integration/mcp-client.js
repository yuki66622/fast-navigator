"use strict";
/* Minimal MCP stdio client for tests: newline-delimited JSON-RPC. */

const { spawn } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");

class McpClient {
  constructor(env) {
    this.proc = spawn("python3", [path.join(__dirname, "..", "..", "sidecar", "mcp_server.py")], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.pending = new Map();
    this.nextId = 0;
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (_e) { return; }
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        waiter(msg);
      }
    });
  }

  request(method, params, timeoutMs) {
    const id = ++this.nextId;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP request timed out: " + method));
      }, timeoutMs || 40000);
      this.pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }) + "\n");
  }

  kill() {
    this.proc.kill();
  }
}

/* Parses a tools/call response's text payload. */
function toolPayload(resp) {
  return JSON.parse(resp.result.content[0].text);
}

module.exports = { McpClient, toolPayload };
