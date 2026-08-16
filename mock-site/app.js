/* MockCRM app: parameterized reproduction of four real-site difficulties.
 *   1. virtual scrolling  — only rows near the viewport are mounted
 *   2. batched loading    — data arrives in async batches while scrolling
 *   3. SPA routing        — pushState navigation, no page load, no hashchange
 *   4. structure change   — v1/v2/v3 markup variants simulate site redeploys
 *
 * URL params: ?count=1000&batch=25&delay=300&seed=42&structure=v1
 * Test hook: window.__MOCK_SITE__ (read-only introspection; adapters must NOT use it).
 */
(function () {
  "use strict";

  const qs = new URLSearchParams(location.search);
  const params = {
    count: clampInt(qs.get("count"), 1, 100000, 1000),
    batch: clampInt(qs.get("batch"), 1, 10000, 25),
    delay: clampInt(qs.get("delay"), 0, 10000, 300),
    seed: clampInt(qs.get("seed"), 0, 2 ** 31, 42),
    structure: ["v1", "v2", "v3"].includes(qs.get("structure")) ? qs.get("structure") : "v1",
    // manual=1: batches load only via __MOCK_SITE__.loadNextBatch(), never on
    // scroll — lets benchmarks control data arrival deterministically
    manual: qs.get("manual") === "1",
  };

  function clampInt(raw, min, max, dflt) {
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  }

  const ROW_H = 56;
  const BUFFER = 6;
  const LOAD_THRESHOLD_ROWS = 3;

  const dataset = MockData.generateContacts(params.count, params.seed);
  const byId = new Map(dataset.map((c) => [c.id, c]));

  let loadedCount = Math.min(params.batch, params.count);
  let loading = false;
  let batchLoads = 0;

  const viewport = document.getElementById("list-viewport");
  const canvas = document.getElementById("contact-list");
  const viewList = document.getElementById("view-list");
  const viewDetail = document.getElementById("view-detail");
  const detailCard = document.getElementById("detail-card");
  const statusbar = document.getElementById("statusbar");
  const paramsBar = document.getElementById("params-bar");
  const structureSwitch = document.getElementById("structure-switch");

  // ---- structure variants -------------------------------------------------

  function renderRowV1(c, top) {
    const row = document.createElement("div");
    row.className = "contact-row";
    row.dataset.contactId = c.id;
    row.style.top = top + "px";
    row.innerHTML =
      '<div class="contact-name"></div><div class="contact-company"></div>' +
      '<div class="contact-role"></div><div class="contact-location"></div>' +
      '<a class="contact-detail-link" href="#/contact/' + c.id + '">View</a>';
    row.querySelector(".contact-name").textContent = c.name;
    row.querySelector(".contact-company").textContent = c.company;
    row.querySelector(".contact-role").textContent = c.role;
    row.querySelector(".contact-location").textContent = c.location;
    return row;
  }

  // v2: classes renamed + extra wrapper, but data-contact-id and field text
  // order survive — a resilient adapter should still extract via fallback.
  function renderRowV2(c, top) {
    const row = document.createElement("div");
    row.className = "cr-item";
    row.dataset.contactId = c.id;
    row.style.top = top + "px";
    const inner = document.createElement("div");
    inner.className = "cr-inner";
    for (const val of [c.name, c.company, c.role, c.location]) {
      const d = document.createElement("div");
      d.className = "cr-f";
      d.textContent = val;
      inner.appendChild(d);
    }
    const a = document.createElement("a");
    a.className = "cr-link";
    a.href = "#/contact/" + c.id;
    a.textContent = "View";
    inner.appendChild(a);
    row.appendChild(inner);
    return row;
  }

  // v3: record identifier attribute renamed (data-contact-id -> data-row-key).
  // Adapters anchored on data-contact-id extract zero records -> health check
  // must report a structure change instead of silently returning nothing.
  function renderRowV3(c, top) {
    const row = renderRowV2(c, top);
    delete row.dataset.contactId;
    row.dataset.rowKey = c.id;
    return row;
  }

  const renderRow = { v1: renderRowV1, v2: renderRowV2, v3: renderRowV3 }[params.structure];

  // ---- virtual list -------------------------------------------------------

  const mounted = new Map(); // id -> element

  function renderList() {
    canvas.style.height = loadedCount * ROW_H + "px";
    const first = Math.max(0, Math.floor(viewport.scrollTop / ROW_H) - BUFFER);
    const last = Math.min(
      loadedCount - 1,
      Math.ceil((viewport.scrollTop + viewport.clientHeight) / ROW_H) + BUFFER
    );
    const want = new Set();
    for (let i = first; i <= last; i++) want.add(dataset[i].id);
    for (const [id, el] of mounted) {
      if (!want.has(id)) {
        el.remove();
        mounted.delete(id);
      }
    }
    for (let i = first; i <= last; i++) {
      const c = dataset[i];
      if (!mounted.has(c.id)) {
        const el = renderRow(c, i * ROW_H);
        canvas.appendChild(el);
        mounted.set(c.id, el);
      }
    }
    renderStatus();
  }

  function loadNextBatch() {
    if (loading || loadedCount >= params.count) return false;
    loading = true;
    renderStatus();
    setTimeout(() => {
      loadedCount = Math.min(params.count, loadedCount + params.batch);
      batchLoads++;
      loading = false;
      renderList();
    }, params.delay);
    return true;
  }

  function maybeLoadMore() {
    if (params.manual) return;
    if (loading || loadedCount >= params.count) return;
    const nearBottom =
      viewport.scrollTop + viewport.clientHeight >=
      loadedCount * ROW_H - LOAD_THRESHOLD_ROWS * ROW_H;
    if (!nearBottom) return;
    if (loadNextBatch()) {
      // re-check after arrival: a tall viewport may still be near the new bottom
      setTimeout(() => requestAnimationFrame(maybeLoadMore), params.delay + 20);
    }
  }

  viewport.addEventListener("scroll", () => {
    renderList();
    maybeLoadMore();
  });

  // ---- SPA routing (deliberately silent: pushState, no hashchange) --------

  function currentRoute() {
    const m = location.hash.match(/^#\/contact\/(.+)$/);
    return m ? { view: "detail", id: m[1] } : { view: "list" };
  }

  function renderRoute() {
    const r = currentRoute();
    if (r.view === "detail") {
      const c = byId.get(r.id);
      detailCard.innerHTML = "";
      const h = document.createElement("h2");
      h.className = "detail-name";
      h.textContent = c ? c.name : "Unknown contact";
      detailCard.appendChild(h);
      if (c) {
        for (const [label, val] of [["Company", c.company], ["Role", c.role], ["Location", c.location], ["ID", c.id]]) {
          const f = document.createElement("div");
          f.className = "detail-field";
          f.innerHTML = '<span class="label"></span><span class="value"></span>';
          f.querySelector(".label").textContent = label;
          f.querySelector(".value").textContent = val;
          detailCard.appendChild(f);
        }
      }
      const back = document.createElement("span");
      back.className = "detail-back";
      back.textContent = "← Back to list";
      back.addEventListener("click", () => history.back());
      detailCard.appendChild(back);
      viewList.classList.add("hidden");
      viewDetail.classList.remove("hidden");
    } else {
      viewDetail.classList.add("hidden");
      viewList.classList.remove("hidden");
      renderList();
    }
  }

  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href^='#/contact/']");
    if (!a) return;
    e.preventDefault();
    history.pushState({}, "", a.getAttribute("href")); // silent SPA navigation
    renderRoute();
  });

  window.addEventListener("popstate", renderRoute);

  // ---- chrome -------------------------------------------------------------

  function renderStatus() {
    statusbar.innerHTML = "";
    const s = document.createElement("span");
    s.textContent =
      "Loaded " + loadedCount + " / " + params.count +
      " · batches " + batchLoads +
      " · seed " + params.seed +
      " · delay " + params.delay + "ms" +
      " · structure " + params.structure;
    statusbar.appendChild(s);
    if (loading) {
      const l = document.createElement("span");
      l.className = "loading";
      l.textContent = " · loading next batch…";
      statusbar.appendChild(l);
    }
  }

  function renderChrome() {
    paramsBar.textContent =
      "params: count=" + params.count + " batch=" + params.batch +
      " delay=" + params.delay + " seed=" + params.seed +
      " structure=" + params.structure;
    structureSwitch.innerHTML = "";
    for (const v of ["v1", "v2", "v3"]) {
      const a = document.createElement("a");
      const p = new URLSearchParams(qs);
      p.set("structure", v);
      a.href = location.pathname + "?" + p.toString();
      a.textContent = v;
      if (v === params.structure) a.className = "active";
      structureSwitch.appendChild(a);
    }
  }

  // introspection for tests/benchmarks; adapters must not touch this
  window.__MOCK_SITE__ = {
    params,
    get loadedCount() { return loadedCount; },
    get batchLoads() { return batchLoads; },
    get mountedCount() { return mounted.size; },
    datasetSize: dataset.length,
    loadNextBatch,
  };

  renderChrome();
  renderRoute();
  maybeLoadMore();
})();
