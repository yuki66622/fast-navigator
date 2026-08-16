/* MockAdapter: all MockCRM-specific knowledge lives here (selectors, id format,
 * row geometry, batch-loading behaviour). The core never sees any of it.
 * Extraction strategy:
 *   primary  — v1 markup (.contact-row + field classes)
 *   fallback — any [data-contact-id] row; fields = first four leaf-div texts
 *              in document order (survives the v2 class rename)
 *   v3 renames the id attribute itself -> zero records -> core health check
 *              reports "structure-changed".
 */
(function (global) {
  "use strict";

  const ADAPTER_ID = "mock";
  const DEFAULT_ROW_H = 56;
  const LOCATE_TIMEOUT_MS = 20000;
  const GROWTH_TIMEOUT_MS = 15000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // rAF is throttled/suspended in background tabs — race it with a timeout so
  // locate never hangs when the tab is not focused
  async function settle() {
    await Promise.race([
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      sleep(150),
    ]);
    await sleep(30);
  }

  async function waitFor(cond, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (cond()) return true;
      await sleep(50);
    }
    return false;
  }

  function text(el, sel) {
    const t = el.querySelector(sel);
    return t ? t.textContent.trim() : "";
  }

  function extractPrimary(row) {
    return {
      id: row.dataset.contactId,
      fields: {
        name: text(row, ".contact-name"),
        company: text(row, ".contact-company"),
        role: text(row, ".contact-role"),
        location: text(row, ".contact-location"),
      },
    };
  }

  function extractFallback(row) {
    const leaves = Array.from(row.querySelectorAll("div"))
      .filter((d) => d.children.length === 0 && d.textContent.trim() !== "");
    const [name, company, role, location] = leaves.map((d) => d.textContent.trim());
    return {
      id: row.dataset.contactId,
      fields: { name: name || "", company: company || "", role: role || "", location: location || "" },
    };
  }

  function parseIndex(id) {
    const m = /^c-(\d+)$/.exec(id);
    return m ? parseInt(m[1], 10) - 1 : null;
  }

  function measureRowHeight(canvas) {
    for (const child of canvas.children) {
      if (child.offsetHeight > 0) return child.offsetHeight;
    }
    return DEFAULT_ROW_H;
  }

  const adapter = {
    adapterId: ADAPTER_ID,

    matches(url, doc) {
      return !!(doc && doc.querySelector('meta[name="application-name"][content="MockCRM"]'));
    },

    getScanRoots(doc) {
      return Array.from(doc.querySelectorAll("#contact-list"));
    },

    extractRecords(root) {
      let rows = root.querySelectorAll(".contact-row[data-contact-id]");
      if (rows.length) return { records: Array.from(rows).map(extractPrimary), mode: "primary" };
      rows = root.querySelectorAll("[data-contact-id]");
      if (rows.length) return { records: Array.from(rows).map(extractFallback), mode: "fallback" };
      return { records: [], mode: "none" };
    },

    getRecordId(record) {
      return record.id;
    },

    onRouteChange(url) {
      const m = /#\/contact\/(.+)$/.exec(url);
      return m ? { view: "detail", id: m[1] } : { view: "list" };
    },

    /* Drives the virtual list until the target row is mounted:
     * jump toward the target when it is within the loaded range, otherwise
     * scroll to the bottom to trigger the next batch load and wait for growth.
     * Always returns an explicit status for the core executor. */
    async scrollToRecord(id) {
      const doc = document;
      const viewport = doc.querySelector(".list-viewport");
      const canvas = doc.querySelector("#contact-list");
      if (!viewport || !canvas) return { status: "failure", reason: "containers-not-found" };

      const find = () => doc.querySelector('[data-contact-id="' + CSS.escape(id) + '"]');
      const center = (el) => {
        viewport.scrollTop = Math.max(0, el.offsetTop - viewport.clientHeight / 2 + el.offsetHeight / 2);
      };

      let el = find();
      if (el) { center(el); await settle(); return { status: "success", mountedTarget: find() || el }; }

      const idx = parseIndex(id);
      if (idx === null) return { status: "failure", reason: "unrecognized-id" };

      const deadline = Date.now() + LOCATE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const rowH = measureRowHeight(canvas);
        const targetTop = idx * rowH;
        const loadedHeight = canvas.offsetHeight;
        if (targetTop + rowH <= loadedHeight) {
          viewport.scrollTop = Math.max(0, targetTop - viewport.clientHeight / 2 + rowH / 2);
          await settle();
          el = find();
          if (el) return { status: "success", mountedTarget: el };
          await sleep(50); // rows may still be rendering
        } else {
          const before = canvas.offsetHeight;
          viewport.scrollTop = canvas.scrollHeight; // clamp to bottom -> triggers batch load
          await settle();
          const grew = await waitFor(() => canvas.offsetHeight > before, GROWTH_TIMEOUT_MS);
          if (!grew) return { status: "failure", reason: "not-found" }; // data exhausted
        }
      }
      return { status: "failure", reason: "timeout" };
    },

    /* Only the main contacts list page is scannable; the flow demo's company /
     * detail views have no list and are idle rather than "structure-changed". */
    isScannable(doc) {
      return !!doc.querySelector("#contact-list");
    },

    /* MockCRM never shows login/captcha walls; the hook demonstrates where a
     * real adapter would detect them so the action layer reports "blocked". */
    detectBlockers(doc) {
      return doc.querySelector('[data-testid="login-wall"], [data-testid="captcha"]') ? "login-or-captcha" : null;
    },

    // ---- page actions (flow demo) ------------------------------------------
    // Each body uses only the generic helpers in ctx.h; the core enforces
    // unique-element / ambiguity / wait / timeout / structured-result rules.
    actions: {
      async read_employee_count({ h }) {
        h.requireAnchor('[data-testid="company"]', { describe: "company page" });
        const cell = h.unique('[data-field="employee-count"]', { describe: "employee-count" });
        const raw = h.text(cell);
        const digits = raw.replace(/[^\d]/g, "");
        if (!digits) throw new h.ActionError("not-found", "employee count text has no number: " + raw);
        return { employees: parseInt(digits, 10), raw };
      },

      async open_people({ h }) {
        h.requireAnchor('[data-testid="company"]', { describe: "company page" });
        const link = h.unique('[data-action="open-people"]', { describe: "open-people control" });
        h.click(link, "open-people");
        await h.waitForRoute((href) => /#\/team/.test(href), { describe: "team route" });
        const list = await h.waitFor(
          () => document.querySelector('[data-testid="people-list"]'),
          { describe: "people list" }
        );
        const people = h.collect('[data-testid="person-row"]', { within: list }).map((row) => ({
          id: row.getAttribute("data-person-id"),
          name: h.text(row.querySelector('[data-field="name"]')),
          role: h.text(row.querySelector('[data-field="role"]')),
        }));
        return { route: location.hash, count: people.length, people };
      },

      async open_contact({ h, args }) {
        const id = String(args.id || "");
        if (!id) throw new h.ActionError("not-found", "open_contact requires an id");
        h.requireAnchor('[data-testid="people-list"]', { describe: "people list" });
        const link = h.unique('[data-action="open-contact"]', {
          describe: "open-contact for " + id,
          filter: (a) => {
            const row = a.closest('[data-testid="person-row"]');
            return row && row.getAttribute("data-person-id") === id;
          },
        });
        h.click(link, "open-contact");
        await h.waitForRoute((href) => href.indexOf("#/contact/" + id) !== -1, { describe: "contact route" });
        const detail = await h.waitFor(
          () => document.querySelector('[data-testid="contact-detail"]'),
          { describe: "contact detail" }
        );
        return {
          id, route: location.hash,
          name: h.text(detail.querySelector('[data-field="name"]')),
          role: h.text(detail.querySelector('[data-field="role"]')),
        };
      },

      async open_contact_info({ h }) {
        h.requireAnchor('[data-testid="contact-detail"]', { describe: "contact detail" });
        const toggle = h.unique('[data-action="toggle-contact-info"]', { describe: "contact-info toggle" });
        if (toggle.getAttribute("aria-expanded") === "true" && document.querySelector('[data-testid="contact-info"]')) {
          return { opened: true, alreadyOpen: true };
        }
        h.click(toggle, "toggle-contact-info");
        await h.waitFor(
          () => {
            const p = document.querySelector('[data-testid="contact-info"]');
            return p && h.isVisible(p) ? p : null;
          },
          { describe: "contact-info panel visible" }
        );
        return { opened: true };
      },

      /* Click "Access email" and wait for the email text to actually appear in
       * the DOM, or for an explicit limit/permission message. Never fabricates
       * an email — the value returned is read verbatim from the page. */
      async reveal_email({ h }) {
        const panel = h.requireAnchor('[data-testid="contact-info"]', { describe: "contact info panel" });
        const existing = panel.querySelector('[data-field="email"]');
        if (existing) return { email: h.text(existing), alreadyRevealed: true };
        const btn = h.unique('[data-action="access-email"]', { within: panel, describe: "access-email button" });
        h.click(btn, "access-email");
        const outcome = await h.waitFor(
          () => panel.querySelector('[data-field="email"]') || panel.querySelector('[data-testid="reveal-error"]'),
          { describe: "email revealed or limit message" }
        );
        if (outcome.getAttribute("data-testid") === "reveal-error") {
          throw new h.ActionError("reveal-failed", "reveal blocked: " + h.text(outcome), { message: h.text(outcome) });
        }
        const email = h.text(outcome);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw new h.ActionError("reveal-failed", "revealed text is not an email: " + email);
        }
        return { email };
      },
    },

    actionsMeta: {
      read_employee_count: { description: "Read the company's employee count from the company page.", args: {} },
      open_people: { description: "Navigate from the company page to its People list; returns the people with roles.", args: {} },
      open_contact: { description: "Open a contact's detail page by record id from the People list.", args: { id: "record id" } },
      open_contact_info: { description: "Expand the Contact information section on a contact detail page.", args: {} },
      reveal_email: { description: "Click Access email and return the email that actually appears (never guessed).", args: {} },
    },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
  global.AFN = global.AFN || {};
  if (global.AFN.adapters && typeof global.AFN.adapters.register === "function") {
    global.AFN.adapters.register(adapter);
  }
  global.AFN.mockAdapter = adapter;
})(typeof globalThis !== "undefined" ? globalThis : window);
