/* Side panel: first client of the core. Reads the index from storage, queries
 * locally, and talks to the content runtime only for locate/rescan. */
(function () {
  "use strict";

  const KEYS = AFN.scanner.STORAGE_KEYS;
  const DEFAULT_SIDECAR = "http://127.0.0.1:8787";
  const DEFAULT_BRIDGE = "http://127.0.0.1:8788";

  const els = {
    search: document.getElementById("search"),
    nl: document.getElementById("nl"),
    ask: document.getElementById("ask"),
    derived: document.getElementById("derived"),
    derivedText: document.getElementById("derived-text"),
    derivedClear: document.getElementById("derived-clear"),
    statusFilter: document.getElementById("status-filter"),
    agentMode: document.getElementById("agent-mode"),
    agentLog: document.getElementById("agent-log"),
    rescan: document.getElementById("rescan"),
    clear: document.getElementById("clear"),
    health: document.getElementById("health"),
    notice: document.getElementById("notice"),
    results: document.getElementById("results"),
    footer: document.getElementById("footer"),
  };

  const MAX_ROWS = 500;
  const STATUS_CYCLE = { pending: "viewed", viewed: "done", done: "pending" };

  let records = {};
  let statusMap = {};
  let meta = null;
  let noticeTimer = null;
  let structured = null; // derived query from the sidecar (plain data)
  let structuredSource = "";
  let sidecarUrl = DEFAULT_SIDECAR;
  let bridgeUrl = DEFAULT_BRIDGE;
  let agentEnabled = false;
  let agentLoopRunning = false;
  let agentState = "off"; // shown in the footer

  function fmtAge(ts) {
    if (!ts) return "";
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  function showNotice(text, ms) {
    els.notice.textContent = text;
    els.notice.classList.remove("hidden");
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => els.notice.classList.add("hidden"), ms || 4000);
  }

  function sendToActiveTab(msg, cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) { cb(null, "no-active-tab"); return; }
      chrome.tabs.sendMessage(tab.id, msg, (resp) => {
        if (chrome.runtime.lastError) { cb(null, chrome.runtime.lastError.message); return; }
        cb(resp, null);
      });
    });
  }

  function renderHealth() {
    const h = meta && meta.health;
    if (!h) { els.health.classList.add("hidden"); return; }
    els.health.className = "health " + h.level;
    els.health.textContent = (h.level === "ok" ? "" : "[" + h.level.toUpperCase() + "] ") + h.message;
    els.health.classList.remove("hidden");
  }

  function renderFooter(shown, total) {
    const parts = ["showing " + shown + " / " + total + " indexed"];
    if (agentEnabled) parts.push("agent: " + agentState);
    if (meta && meta.lastScan) {
      const ls = meta.lastScan;
      parts.push(
        "last scan " + fmtAge(ls.at) + " (" + ls.reason + ", " + ls.durationMs.toFixed(0) + "ms, +" +
        ls.added + " new, " + ls.updated + " changed)"
      );
    }
    if (meta && meta.adapterId) parts.push("adapter: " + meta.adapterId);
    els.footer.textContent = parts.join(" · ");
  }

  function fieldKeys() {
    const keys = new Set();
    let n = 0;
    for (const k of Object.keys(records)) {
      if (n++ >= 50) break;
      for (const f of Object.keys(records[k].fields || {})) keys.add(f);
    }
    return [...keys].slice(0, 20);
  }

  function renderDerived() {
    if (!structured) { els.derived.classList.add("hidden"); return; }
    const groups = (structured.all || [])
      .map((g) => "(" + g.anyOf.join(" | ") + (g.field ? " @" + g.field : "") + ")")
      .join(" AND ");
    const none = (structured.none || []).length ? " NOT (" + structured.none.join(", ") + ")" : "";
    els.derivedText.textContent =
      (groups || none ? groups + none : "(no conditions derived)") + "  [" + structuredSource + "]";
    els.derived.classList.remove("hidden");
  }

  function ask() {
    const q = els.nl.value.trim();
    if (!q) return;
    fetch(sidecarUrl + "/v1/parse-query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, fields: fieldKeys() }),
    })
      .then((r) => r.json())
      .then((body) => {
        if (!body.ok) { showNotice("Sidecar error: " + (body.error || "unknown")); return; }
        structured = body.structured;
        structuredSource = body.source + (body.model ? ":" + body.model : "") + (body.note ? " — " + body.note : "");
        renderDerived();
        renderResults();
      })
      .catch(() => {
        showNotice("Sidecar not reachable at " + sidecarUrl +
          " — start it with: python3 sidecar/server.py (mock mode needs no key).", 6000);
      });
  }

  function renderResults() {
    const q = { text: els.search.value, status: els.statusFilter.value, structured };
    const matches = AFN.query.queryRecords(records, q, statusMap);
    els.results.textContent = "";
    for (const m of matches.slice(0, MAX_ROWS)) {
      const li = document.createElement("li");
      li.className = "result";

      const main = document.createElement("div");
      main.className = "main";
      main.title = "Click to locate on the page";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = m.record.fields.name || m.record.id;
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = [m.record.fields.company, m.record.fields.role, m.record.fields.location]
        .filter(Boolean).join(" · ");
      const age = document.createElement("div");
      age.className = "age";
      age.textContent = "scanned " + fmtAge(m.record.source.scannedAt);
      main.append(name, sub, age);
      main.addEventListener("click", () => locate(m));

      const statusBtn = document.createElement("button");
      statusBtn.className = "status-btn " + m.status;
      statusBtn.textContent = m.status;
      statusBtn.title = "Click to cycle pending → viewed → done";
      statusBtn.addEventListener("click", () => setStatus(m.key, STATUS_CYCLE[m.status] || "pending"));

      li.append(main, statusBtn);
      els.results.appendChild(li);
    }
    renderFooter(Math.min(matches.length, MAX_ROWS), Object.keys(records).length);
  }

  function render() {
    renderHealth();
    renderResults();
  }

  function locate(m) {
    sendToActiveTab({ type: "afn:locate", id: m.record.id }, (resp, err) => {
      if (err) {
        showNotice("Content script not active on this tab — click the Fast Navigator toolbar icon on the page first.");
        return;
      }
      if (resp && resp.status === "success") {
        showNotice("Located " + (m.record.fields.name || m.record.id) + " in " + resp.ms.toFixed(0) + "ms.");
      } else {
        showNotice("Locate failed: " + ((resp && resp.reason) || "unknown") +
          ". The record may no longer exist on the page.");
      }
    });
  }

  function setStatus(key, status) {
    statusMap[key] = { status, updatedAt: Date.now() };
    chrome.storage.local.set({ [KEYS.status]: statusMap });
  }

  // ---- agent bridge (V3): a local MCP server forwards tool calls here ------

  function sendToActiveTabP(msg) {
    return new Promise((resolve, reject) => {
      sendToActiveTab(msg, (resp, err) => {
        if (err) reject(new Error("content script not active on this tab — click the toolbar icon on the page tab first (" + err + ")"));
        else resolve(resp);
      });
    });
  }

  function resolveKey(id) {
    if (records[id]) return id;
    return Object.keys(records).find((k) => k.endsWith(":" + id)) || null;
  }

  /* Whitelisted, read-mostly operations only. Everything runs locally; the
   * only page effects are scroll + highlight (locate) and a rescan. */
  async function executeAgentTool(name, args) {
    if (name === "search_records") {
      const q = {
        text: typeof args.query === "string" ? args.query : "",
        structured: args.structured && typeof args.structured === "object" ? args.structured : null,
        status: ["all", "pending", "viewed", "done"].includes(args.status) ? args.status : "all",
      };
      const matches = AFN.query.queryRecords(records, q, statusMap);
      const limit = Math.min(Math.max(1, args.limit || 50), 200);
      return {
        total: matches.length,
        returned: Math.min(matches.length, limit),
        records: matches.slice(0, limit).map((m) => ({
          id: m.record.id,
          fields: m.record.fields,
          status: m.status,
          adapterId: m.record.source.adapterId,
          scannedAt: m.record.source.scannedAt,
        })),
      };
    }
    if (name === "get_index_stats") {
      return {
        totalRecords: Object.keys(records).length,
        adapterId: meta && meta.adapterId,
        health: meta && meta.health,
        lastScan: meta && meta.lastScan,
        counters: meta && meta.counters,
      };
    }
    if (name === "set_record_status") {
      if (!["pending", "viewed", "done"].includes(args.status)) throw new Error("invalid status: " + args.status);
      const key = resolveKey(String(args.id || ""));
      if (!key) throw new Error("unknown record id: " + args.id);
      setStatus(key, args.status);
      return { id: args.id, status: args.status };
    }
    if (name === "locate_record") {
      const resp = await sendToActiveTabP({ type: "afn:locate", id: String(args.id || "") });
      return resp;
    }
    if (name === "rescan_page") {
      return await sendToActiveTabP({ type: "afn:rescan" });
    }
    if (name === "list_page_actions") {
      const resp = await sendToActiveTabP({ type: "afn:capabilities" });
      return { adapterId: resp.adapterId, url: resp.url, actions: resp.actions || [] };
    }
    if (name === "run_page_action") {
      const actionName = String(args.action || "");
      if (!actionName) throw new Error("run_page_action requires an 'action' name");
      const resp = await sendToActiveTabP({
        type: "afn:action",
        name: actionName,
        args: args.args && typeof args.args === "object" ? args.args : {},
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
      });
      return resp;
    }
    if (name === "parse_query") {
      const r = await fetch(sidecarUrl + "/v1/parse-query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: String(args.text || ""), fields: fieldKeys() }),
      });
      const body = await r.json();
      if (!body.ok) throw new Error(body.error || "sidecar error");
      return { structured: body.structured, source: body.source, model: body.model || null };
    }
    throw new Error("unknown tool: " + name);
  }

  function setAgentState(s) {
    if (agentState === s) return;
    agentState = s;
    renderResults(); // footer shows it
  }

  /* Visible agent trace: one row per tool/action call with its result and time. */
  function logAgentAction(call, payload, ms) {
    const li = document.createElement("li");
    li.className = "agent-entry " + (payload.ok ? "ok" : "err");
    let label = call.name;
    let detail = "";
    // run_page_action carries its own structured status/reason from the page
    if (call.name === "run_page_action") {
      const a = (call.arguments && call.arguments.action) || "?";
      label = "action: " + a;
      const res = payload.ok && payload.result ? payload.result : null;
      if (res) detail = res.status + (res.reason ? " (" + res.reason + ")" : "");
      else if (!payload.ok) detail = "error";
    } else {
      detail = payload.ok ? "ok" : "error";
    }
    const name = document.createElement("span");
    name.className = "ae-name";
    name.textContent = label;
    const meta = document.createElement("span");
    meta.className = "ae-meta";
    meta.textContent = detail + " · " + ms + "ms";
    li.append(name, meta);
    els.agentLog.insertBefore(li, els.agentLog.firstChild);
    while (els.agentLog.children.length > 20) els.agentLog.removeChild(els.agentLog.lastChild);
    els.agentLog.classList.remove("hidden");
  }

  async function agentLoop() {
    if (agentLoopRunning) return;
    agentLoopRunning = true;
    while (agentEnabled) {
      try {
        const r = await fetch(bridgeUrl + "/v1/agent/pull?wait=25");
        const body = await r.json();
        setAgentState("connected");
        if (body.call) {
          let payload;
          const t0 = performance.now();
          try {
            payload = { ok: true, result: await executeAgentTool(body.call.name, body.call.arguments || {}) };
          } catch (e) {
            payload = { ok: false, error: String((e && e.message) || e) };
          }
          const ms = Math.round(performance.now() - t0);
          await fetch(bridgeUrl + "/v1/agent/result", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(Object.assign({ id: body.call.id }, payload)),
          });
          logAgentAction(body.call, payload, ms);
          showNotice("Agent call: " + body.call.name + (payload.ok ? "" : " (failed)"));
        }
      } catch (_e) {
        setAgentState("bridge unreachable");
        await new Promise((res) => setTimeout(res, 3000));
      }
    }
    agentLoopRunning = false;
    setAgentState("off");
  }

  function setAgentEnabled(on, persist) {
    agentEnabled = on;
    els.agentMode.checked = on;
    if (persist) {
      chrome.storage.local.get("afn:settings").then((got) => {
        const s = got["afn:settings"] || {};
        s.agentBridge = on;
        chrome.storage.local.set({ "afn:settings": s });
      });
    }
    if (on) agentLoop();
    else setAgentState("off");
  }

  async function load() {
    const got = await chrome.storage.local.get([KEYS.index, KEYS.meta, KEYS.status, "afn:settings"]);
    records = (got[KEYS.index] && got[KEYS.index].records) || {};
    meta = got[KEYS.meta] || null;
    statusMap = got[KEYS.status] || {};
    const settings = got["afn:settings"] || {};
    if (settings.sidecarUrl) sidecarUrl = settings.sidecarUrl;
    if (settings.bridgeUrl) bridgeUrl = settings.bridgeUrl;
    render();
    if (settings.agentBridge) setAgentEnabled(true, false);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[KEYS.index]) records = (changes[KEYS.index].newValue && changes[KEYS.index].newValue.records) || {};
    if (changes[KEYS.meta]) meta = changes[KEYS.meta].newValue || null;
    if (changes[KEYS.status]) statusMap = changes[KEYS.status].newValue || {};
    render();
  });

  els.search.addEventListener("input", renderResults);
  els.statusFilter.addEventListener("change", renderResults);
  els.ask.addEventListener("click", ask);
  els.nl.addEventListener("keydown", (e) => { if (e.key === "Enter") ask(); });
  els.derivedClear.addEventListener("click", () => {
    structured = null;
    renderDerived();
    renderResults();
  });
  els.agentMode.addEventListener("change", () => setAgentEnabled(els.agentMode.checked, true));

  els.rescan.addEventListener("click", () => {
    sendToActiveTab({ type: "afn:rescan" }, (resp, err) => {
      if (err) {
        showNotice("Content script not active on this tab — click the Fast Navigator toolbar icon on the page first.");
      } else {
        showNotice("Rescan triggered.");
      }
    });
  });

  els.clear.addEventListener("click", () => {
    if (!confirm("Clear the local index, scan metadata and progress statuses?")) return;
    chrome.storage.local.remove([KEYS.index, KEYS.meta, KEYS.status]).then(() => {
      records = {}; meta = null; statusMap = {};
      render();
      showNotice("Local index cleared.");
    });
  });

  load();
})();
