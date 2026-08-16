/* Read-only, sanitizing structure probe (M3 Debug Mode).
 *
 * Runs in any page and reports STRUCTURE ONLY:
 *   - repeated sibling groups (candidate record rows) and their signatures
 *   - attribute names, id/href/data-* VALUE PATTERNS (never raw values)
 *   - virtualization signals (positioning, transforms, scroll containers)
 *   - framework hints, route shape, aria grid/table usage
 *
 * Sanitization rules (hard requirements, see PROJECT_NOTES §2):
 *   - text content is letter/digit-redacted (Abc12 -> Aaa99), length-capped
 *   - uuid / long-hex / base64ish / digit runs in attribute values become
 *     {uuid} {hex#} {b64} {n} tokens; deep URL path segments are redacted
 *   - class names and attribute NAMES are kept (they are code, not data)
 *   - no raw innerText, no full-page snapshots, no cookies, ever
 *
 * UMD-ish: string sanitizers are require()-able for unit tests; in a browser
 * call window.__AFN_PROBE__() and it returns a JSON-safe report.
 */
(function (global) {
  "use strict";

  // ---- sanitizers (pure, unit-tested) ------------------------------------

  function redactText(s, max) {
    const cap = max === undefined ? 40 : max;
    if (typeof s !== "string") return "";
    const cut = s.length > cap;
    return (
      s.slice(0, cap)
        .replace(/[A-Z]/g, "A")
        .replace(/[a-zÀ-ɏ一-鿿]/g, "a")
        .replace(/[0-9]/g, "9") + (cut ? "…" : "")
    );
  }

  function patternizeValue(v) {
    if (typeof v !== "string") return "";
    let out = v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{uuid}");
    out = out.replace(/[0-9a-f]{16,}/gi, (m) => "{hex" + m.length + "}");
    out = out.replace(/[A-Za-z0-9+/_-]{24,}={0,2}/g, "{b64}");
    out = out.replace(/\d{3,}/g, "{n}");
    return out;
  }

  /* URL paths: keep the first two path segments (route words like /people),
   * patternize/redact everything deeper — deep segments can be name slugs. */
  function patternizeHref(href) {
    if (typeof href !== "string") return "";
    let rest = href, prefix = "";
    const m = /^[a-z]+:\/\/[^/]+/i.exec(rest);
    if (m) { prefix = "{origin}"; rest = rest.slice(m[0].length); }
    let hash = "";
    const hIdx = rest.indexOf("#");
    if (hIdx >= 0) { hash = rest.slice(hIdx + 1); rest = rest.slice(0, hIdx); }
    let query = "";
    const qIdx = rest.indexOf("?");
    if (qIdx >= 0) { query = rest.slice(qIdx + 1); rest = rest.slice(0, qIdx); }
    const segs = rest.split("/").map((seg, i) => {
      if (seg === "") return seg;
      const p = patternizeValue(seg);
      if (p !== seg) return p; // contained an id-ish token
      // only the first real segment (the route word) is kept verbatim —
      // deeper alpha segments can be personal name slugs
      return i <= 1 ? seg : redactText(seg, 24);
    });
    let q = "";
    if (query) {
      const names = [];
      for (const pair of query.split("&")) {
        const name = pair.split("=")[0];
        if (name) names.push(patternizeValue(name));
      }
      q = "?" + names.map((n) => n + "=…").join("&");
    }
    let h = "";
    if (hash) h = "#" + (hash.startsWith("/") ? patternizeHref(hash) : patternizeValue(hash));
    return prefix + segs.join("/") + q + h;
  }

  const sanitizers = { redactText, patternizeValue, patternizeHref };
  if (typeof module !== "undefined" && module.exports) module.exports = sanitizers;

  if (typeof window === "undefined" || typeof document === "undefined") return;

  // ---- DOM analysis (browser only) ----------------------------------------

  const KEEP_ATTR_VALUE = new Set(["class", "role", "type", "aria-label", "aria-expanded", "aria-selected", "contenteditable", "draggable", "tabindex"]);

  function attrSummary(el) {
    const out = {};
    for (const a of el.attributes || []) {
      if (a.name === "style") { out.style = a.value.length > 0 ? "(inline)" : ""; continue; }
      if (a.name === "href" || a.name === "src") out[a.name] = patternizeHref(a.value);
      else if (KEEP_ATTR_VALUE.has(a.name)) out[a.name] = a.value.slice(0, 120);
      else out[a.name] = patternizeValue(a.value).slice(0, 120);
    }
    return out;
  }

  function sanitizeTree(el, depth, childCap) {
    if (!el || el.nodeType !== 1 || depth < 0) return null;
    const node = {
      tag: el.tagName.toLowerCase(),
      attrs: attrSummary(el),
      text: null,
      children: [],
    };
    let ownText = "";
    for (const c of el.childNodes) {
      if (c.nodeType === 3 && c.textContent.trim()) ownText += c.textContent.trim() + " ";
    }
    if (ownText) node.text = redactText(ownText.trim());
    if (depth > 0) {
      let n = 0;
      for (const c of el.children) {
        if (n++ >= childCap) { node.children.push({ tag: "…", omitted: el.children.length - childCap }); break; }
        node.children.push(sanitizeTree(c, depth - 1, childCap));
      }
    } else if (el.children.length) {
      node.children.push({ tag: "…", omitted: el.children.length });
    }
    return node;
  }

  function shapeSig(el) {
    const cls = [...el.classList].sort().slice(0, 6).join(".");
    const kids = [...el.children].slice(0, 6).map((c) => c.tagName.toLowerCase()).join(",");
    return el.tagName.toLowerCase() + (cls ? "." + cls : "") + "[" + kids + "]";
  }

  function ancestorPath(el, n) {
    const parts = [];
    let cur = el;
    for (let i = 0; i < n && cur && cur !== document.documentElement; i++) {
      let s = cur.tagName.toLowerCase();
      if (cur.id) s += "#" + patternizeValue(cur.id);
      const cls = [...cur.classList].slice(0, 4).join(".");
      if (cls) s += "." + cls;
      parts.unshift(s);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function scrollContainerOf(el) {
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      const cs = getComputedStyle(cur);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && cur.scrollHeight > cur.clientHeight + 4) {
        return {
          path: ancestorPath(cur, 3),
          clientHeight: cur.clientHeight,
          scrollHeight: cur.scrollHeight,
        };
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function findRepeatedGroups() {
    const byParent = new Map();
    const all = document.querySelectorAll("*");
    const cap = Math.min(all.length, 30000);
    for (let i = 0; i < cap; i++) {
      const el = all[i];
      const p = el.parentElement;
      if (!p) continue;
      let groups = byParent.get(p);
      if (!groups) { groups = new Map(); byParent.set(p, groups); }
      const sig = shapeSig(el);
      groups.set(sig, (groups.get(sig) || []).concat(el));
    }
    const candidates = [];
    for (const [parent, groups] of byParent) {
      for (const [sig, els] of groups) {
        if (els.length < 5) continue;
        const size = els[0].querySelectorAll("*").length;
        if (size < 3) continue; // rows of real records are not trivial nodes
        candidates.push({ parent, sig, els, size, score: els.length * Math.min(size, 80) });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, 8).map((c) => {
      const first = c.els[0];
      const cs = getComputedStyle(first);
      const attrNames = new Set();
      for (const el of c.els.slice(0, 10)) for (const a of el.attributes) attrNames.add(a.name);
      const links = [...first.querySelectorAll("a[href]")].slice(0, 6).map((a) => patternizeHref(a.getAttribute("href")));
      return {
        count: c.els.length,
        rowSig: c.sig,
        subtreeSize: c.size,
        parentPath: ancestorPath(c.parent, 5),
        rowAttrNames: [...attrNames].sort(),
        positioning: { position: cs.position, transform: cs.transform !== "none" ? "yes" : "no", top: cs.top },
        scrollContainer: scrollContainerOf(first),
        linksInFirstRow: links,
        sampleRow: sanitizeTree(first, 4, 8),
      };
    });
  }

  function frameworkHints() {
    const h = [];
    if (document.querySelector("[data-reactroot], #__next")) h.push("react-root-marker");
    for (const k of Object.keys(window)) {
      if (/^(React|__REACT|__NEXT|angular|__NUXT|Vue)/.test(k)) h.push("window." + k.slice(0, 24));
      if (h.length > 6) break;
    }
    const el = document.querySelector("body *");
    if (el) for (const key of Object.keys(el)) if (key.startsWith("__react")) { h.push("react-fiber-keys"); break; }
    return h;
  }

  global.__AFN_PROBE__ = function () {
    const roleRows = document.querySelectorAll('[role="row"]').length;
    return {
      probeVersion: 1,
      when: new Date().toISOString(),
      url: {
        host: location.host, // needed for the host-permission decision
        pathPattern: patternizeHref(location.pathname),
        queryParamNames: [...new URLSearchParams(location.search).keys()].map(patternizeValue),
        hashPattern: patternizeHref(location.hash),
      },
      title: redactText(document.title, 30),
      framework: frameworkHints(),
      counts: {
        elements: document.querySelectorAll("*").length,
        roleRows,
        roleGrid: document.querySelectorAll('[role="grid"], [role="table"]').length,
        tables: document.querySelectorAll("table").length,
        checkboxes: document.querySelectorAll('input[type="checkbox"]').length,
      },
      repeatedGroups: findRepeatedGroups(),
    };
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

/* auto-run + copy: paste this whole file into the DevTools console on the
 * target page, wait a second, then the sanitized JSON is on your clipboard. */
(function () {
  if (typeof window === "undefined") return; // browser-only
  var report = window.__AFN_PROBE__();
  var json = JSON.stringify(report, null, 2);
  console.log(json);
  if (typeof copy === "function") { copy(json); console.log("--- sanitized report copied to clipboard ---"); }
  else console.log("--- select and copy the JSON above ---");
})();
