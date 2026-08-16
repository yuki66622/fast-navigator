#!/usr/bin/env python3
"""Fast Navigator MCP server (V3) — the core as an agent tool.

Spoken protocol: MCP over stdio (newline-delimited JSON-RPC). An agent host
(e.g. `claude mcp add fast-navigator -- python3 sidecar/mcp_server.py`) spawns
this process; tool calls are forwarded over a localhost HTTP bridge to the
extension's side panel, which executes them against the local index / page and
posts results back. Nothing here touches the network beyond 127.0.0.1, and the
indexed data never leaves the machine — the agent host runs locally too.

The side panel must be open with "Agent" enabled; otherwise tool calls fail
fast with a clear error instead of hanging.

Bridge endpoints (for the panel):
  GET  /v1/agent/pull?wait=25   long-poll for the next queued tool call
  POST /v1/agent/result         {id, ok, result|error}
  GET  /v1/agent/status         {panelConnected}
  POST /v1/agent/call           {name, arguments, timeout} -> {payload, isError}

Several hosts may spawn this server at once (one process per agent session,
plus one-shot health checks). Only one can own the bridge port, so the first
process to bind becomes the owner and the rest run as forwarding clients:
they speak MCP on their own stdio but relay every tool call to the owner over
/v1/agent/call, so the extension panel still talks to a single queue. If the
owner exits, the next call from a client promotes that client to owner.

Env: AGENT_BRIDGE_PORT (default 8788), AGENT_CALL_TIMEOUT seconds (default 30).
"""
import errno
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BRIDGE_PORT = int(os.environ.get("AGENT_BRIDGE_PORT", "8788"))
CALL_TIMEOUT = float(os.environ.get("AGENT_CALL_TIMEOUT", "30"))
PANEL_FRESH_SECS = 35  # a panel long-polling every <=30s counts as connected


class Bridge:
    def __init__(self):
        self.cond = threading.Condition()
        self.pending = []
        self.results = {}
        self.last_pull = 0.0

    def enqueue(self, name, arguments):
        cid = uuid.uuid4().hex
        with self.cond:
            self.pending.append({"id": cid, "name": name, "arguments": arguments})
            self.cond.notify_all()
        return cid

    def pull(self, wait):
        deadline = time.time() + wait
        with self.cond:
            self.last_pull = time.time()
            while not self.pending and time.time() < deadline:
                self.cond.wait(min(1.0, max(0.05, deadline - time.time())))
                self.last_pull = time.time()
            return self.pending.pop(0) if self.pending else None

    def put_result(self, cid, payload):
        with self.cond:
            self.results[cid] = payload
            self.cond.notify_all()

    def wait_result(self, cid, timeout):
        deadline = time.time() + timeout
        with self.cond:
            while cid not in self.results and time.time() < deadline:
                self.cond.wait(min(1.0, max(0.05, deadline - time.time())))
            return self.results.pop(cid, None)

    def panel_connected(self):
        return (time.time() - self.last_pull) < PANEL_FRESH_SECS


bridge = Bridge()


class BridgeHandler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/v1/agent/pull"):
            wait = 25.0
            if "wait=" in self.path:
                try:
                    wait = min(30.0, max(0.0, float(self.path.split("wait=")[1].split("&")[0])))
                except ValueError:
                    pass
            self._send(200, {"call": bridge.pull(wait)})
        elif self.path.startswith("/v1/agent/status"):
            self._send(200, {"ok": True, "panelConnected": bridge.panel_connected()})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path not in ("/v1/agent/result", "/v1/agent/call"):
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            length = min(int(self.headers.get("Content-Length", 0)), 262144)
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            if self.path == "/v1/agent/call":
                timeout = min(max(float(body.get("timeout") or CALL_TIMEOUT), 1.0), 300.0)
                payload, is_error = dispatch_local(body.get("name"), body.get("arguments") or {}, timeout)
                self._send(200, {"payload": payload, "isError": is_error})
                return
            bridge.put_result(str(body.get("id")), body)
            self._send(200, {"ok": True})
        except Exception as e:
            self._send(400, {"ok": False, "error": type(e).__name__})

    def log_message(self, fmt, *args):
        pass


TOOLS = [
    {
        "name": "search_records",
        "description": "Search the locally indexed page records (deterministic engine; no LLM). Free-text tokens AND-match across all fields; optional structured query {all:[{anyOf:[...],field?}],none:[...]} for synonym groups; optional progress-status filter. Returns matching records with fields, status and scan age.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "free-text tokens, AND-matched, case-insensitive"},
                "structured": {"type": "object", "description": "synonym groups: {all:[{anyOf:[terms],field?}],none:[terms]}"},
                "status": {"type": "string", "enum": ["all", "pending", "viewed", "done"]},
                "limit": {"type": "integer", "minimum": 1, "maximum": 200},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "locate_record",
        "description": "Scroll the current page to the record with this id and highlight it (the site adapter drives virtual lists / batch loading; on paged sites records on other pages fail explicitly with not-on-current-page). Requires the extension content script active on the page tab.",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string", "description": "record id as returned by search_records"}},
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_index_stats",
        "description": "Current local index state: total records, adapter, structure-health verdict, last scan details and counters. Cheap; call this before searching to know what knowledge already exists.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "set_record_status",
        "description": "Mark task progress on a record (pending / viewed / done). Progress persists locally across page reloads.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "status": {"type": "string", "enum": ["pending", "viewed", "done"]},
            },
            "required": ["id", "status"],
            "additionalProperties": False,
        },
    },
    {
        "name": "rescan_page",
        "description": "Trigger a fresh scan of the currently open page into the index. Requires the content script active on the page tab.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "parse_query",
        "description": "Convert a natural-language request into the structured query format via the local sidecar (LLM if configured, deterministic mock otherwise). Useful before search_records.",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_page_actions",
        "description": "List the deterministic page actions the active tab's adapter offers right now (name + description + args). Call this to discover what run_page_action can do on the current page. Requires the extension content script active on the page tab.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "run_page_action",
        "description": (
            "Execute one deterministic page action directly via the DOM of the active tab — no vision, no cursor, no coordinates. "
            "The extension resolves a single verified element (stops with 'ambiguous' if several match, 'not-found' if none), performs the click/read, "
            "and waits for the real completion condition (route change, DOM mutation, or revealed text) before returning. "
            "Returns {ok, status, result, ms, trace} on success, or a structured failure with an explicit reason: "
            "wrong-page, unknown-action, ambiguous, not-found, structure-changed, blocked (login/captcha/permission — never bypassed), reveal-failed, or timeout. "
            "Use list_page_actions to see available action names and their args. Reveal-style actions return only values actually present in the DOM (e.g. an email is never guessed)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "description": "action name from list_page_actions"},
                "args": {"type": "object", "description": "action arguments, e.g. {\"id\": \"p-3\"}"},
                "timeoutMs": {"type": "integer", "minimum": 500, "maximum": 60000},
            },
            "required": ["action"],
            "additionalProperties": False,
        },
    },
]


def rpc_result(mid, result):
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def rpc_error(mid, code, message):
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}


def tool_text(payload, is_error=False):
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}], "isError": is_error}


NOT_CONNECTED = {
    "error": "extension panel not connected",
    "hint": "open the Fast Navigator side panel and enable the Agent toggle",
}

_owner_lock = threading.Lock()
_is_owner = False


def dispatch_local(name, args, timeout=None):
    """Run a tool call against this process's own bridge. Returns (payload, is_error)."""
    if name not in {t["name"] for t in TOOLS}:
        return {"error": "unknown tool: %s" % name}, True
    if not bridge.panel_connected():
        return dict(NOT_CONNECTED), True
    timeout = CALL_TIMEOUT if timeout is None else timeout
    cid = bridge.enqueue(name, args)
    res = bridge.wait_result(cid, timeout)
    if res is None:
        return {"error": "tool call timed out after %ss" % timeout}, True
    if res.get("ok"):
        return res.get("result"), False
    return {"error": res.get("error", "unknown")}, True


def bridge_url(path):
    return "http://127.0.0.1:%d%s" % (BRIDGE_PORT, path)


def claim_bridge():
    """Try to become the bridge owner. Returns True if this process owns it."""
    global _is_owner
    with _owner_lock:
        if _is_owner:
            return True
        try:
            server = ThreadingHTTPServer(("127.0.0.1", BRIDGE_PORT), BridgeHandler)
        except OSError as e:
            if e.errno in (errno.EADDRINUSE, errno.EACCES):
                return False
            raise
        threading.Thread(target=server.serve_forever, daemon=True).start()
        _is_owner = True
        return True


def bridge_is_ours():
    """True if something on BRIDGE_PORT answers like our bridge."""
    try:
        with urllib.request.urlopen(bridge_url("/v1/agent/status"), timeout=3) as resp:
            return "panelConnected" in json.loads(resp.read().decode("utf-8"))
    except Exception:
        return False


def dispatch_remote(name, args):
    body = json.dumps({"name": name, "arguments": args, "timeout": CALL_TIMEOUT}).encode()
    req = urllib.request.Request(
        bridge_url("/v1/agent/call"), data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=CALL_TIMEOUT + 10) as resp:
        out = json.loads(resp.read().decode("utf-8"))
    return out.get("payload"), bool(out.get("isError"))


def call_tool(name, args):
    if _is_owner:
        return dispatch_local(name, args)
    try:
        return dispatch_remote(name, args)
    except Exception as e:
        # The owner may have exited between calls — take over the port and retry locally.
        if claim_bridge():
            return dispatch_local(name, args)
        return {"error": "bridge unreachable on port %d: %s" % (BRIDGE_PORT, type(e).__name__)}, True


def handle(msg):
    method = msg.get("method")
    mid = msg.get("id")
    if method == "initialize":
        proto = (msg.get("params") or {}).get("protocolVersion", "2025-03-26")
        return rpc_result(mid, {
            "protocolVersion": proto,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fast-navigator", "version": "0.3.0"},
        })
    if method == "ping":
        return rpc_result(mid, {})
    if method == "tools/list":
        return rpc_result(mid, {"tools": TOOLS})
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        if name not in {t["name"] for t in TOOLS}:
            return rpc_error(mid, -32602, "unknown tool: %s" % name)
        payload, is_error = call_tool(name, args)
        return rpc_result(mid, tool_text(payload, is_error=is_error))
    if method and method.startswith("notifications/"):
        return None
    if mid is not None:
        return rpc_error(mid, -32601, "method not found: %s" % method)
    return None


def main():
    if claim_bridge():
        sys.stderr.write("fast-navigator MCP server: bridge on http://127.0.0.1:%d\n" % BRIDGE_PORT)
    elif bridge_is_ours():
        sys.stderr.write(
            "fast-navigator MCP server: port %d already served by another instance; "
            "forwarding tool calls to it\n" % BRIDGE_PORT)
    else:
        sys.stderr.write(
            "fast-navigator MCP server: port %d is taken by an unrelated process. "
            "Set AGENT_BRIDGE_PORT to a free port.\n" % BRIDGE_PORT)
        sys.exit(1)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        reply = handle(msg)
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
