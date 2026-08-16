/* MockCRM flow demo: a synthetic Company → People → Contact → Contact info →
 * Access email → email-appears workflow. It models the SHAPE of a real
 * outreach tool (multi-view SPA, a reveal-on-demand email gated behind a
 * button and a delay) WITHOUT copying any real site's structure. Used to prove
 * the deterministic page-action layer in public tests.
 *
 * Semantic hooks the adapter relies on (all generic):
 *   [data-testid="company"] / [data-field="employee-count"] / [data-action="open-people"]
 *   [data-testid="people-list"] / [data-testid="person-row"][data-person-id]
 *     / [data-field="name"] / [data-field="role"] / [data-action="open-contact"]
 *   [data-testid="contact-detail"] / [data-action="toggle-contact-info"]
 *     / [data-testid="contact-info"] / [data-action="access-email"]
 *     / [data-field="email"] (only inserted AFTER a successful reveal)
 *     / [data-testid="reveal-error"] (credit/permission limit path)
 *
 * URL params: ?revealDelay=300  ?dup=1 (duplicate access-email → ambiguous)
 *             ?broken=1 (drop detail hooks → structure-changed)  ?limit=1
 *             (reveal returns a credit limit, no email is ever shown)
 */
(function () {
  "use strict";

  const qs = new URLSearchParams(location.search);
  const REVEAL_DELAY = Math.max(0, parseInt(qs.get("revealDelay"), 10) || 300);
  const DUP = qs.get("dup") === "1";
  const BROKEN = qs.get("broken") === "1";
  const LIMIT = qs.get("limit") === "1";

  const COMPANY = { id: "acme", name: "Acme Robotics", employees: 1240 };
  const PEOPLE = [
    { id: "p-1", name: "Dana Lin", role: "Founder & CEO", email: "dana@acme-robotics.example" },
    { id: "p-2", name: "Ravi Shah", role: "Chief Executive Officer", email: "ravi@acme-robotics.example" },
    { id: "p-3", name: "Mei Ko", role: "Head of Talent", email: "mei@acme-robotics.example" },
    { id: "p-4", name: "Tom Bauer", role: "HR Manager", email: "tom@acme-robotics.example" },
    { id: "p-5", name: "Ada Reyes", role: "Software Engineer", email: "ada@acme-robotics.example" },
  ];
  const byId = new Map(PEOPLE.map((p) => [p.id, p]));

  const app = document.getElementById("app");
  const el = (tag, attrs, text) => {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  };

  function route() {
    const h = location.hash;
    let m = /^#\/contact\/([\w-]+)/.exec(h);
    if (m) return { view: "contact", id: m[1] };
    if (/^#\/team/.test(h)) return { view: "people" };
    return { view: "company" };
  }

  function crumb(items) {
    const c = el("div", { class: "breadcrumb" });
    items.forEach((it, i) => {
      if (i) c.appendChild(document.createTextNode(" / "));
      if (it.href) { const a = el("a", { href: it.href }, it.label); c.appendChild(a); }
      else c.appendChild(document.createTextNode(it.label));
    });
    return c;
  }

  function renderCompany() {
    app.innerHTML = "";
    const card = el("div", { class: "card", "data-testid": "company", "data-company-id": COMPANY.id });
    card.appendChild(crumb([{ label: COMPANY.name }]));
    card.appendChild(el("h2", null, COMPANY.name));
    card.appendChild(el("div", { "data-field": "employee-count", class: "muted" },
      COMPANY.employees.toLocaleString() + " employees"));
    const p = el("p");
    p.appendChild(el("a", { class: "btn", "data-action": "open-people", "aria-label": "View people",
      href: "#/team?company=" + COMPANY.id }, "People"));
    card.appendChild(p);
    app.appendChild(card);
  }

  function renderPeople() {
    app.innerHTML = "";
    const card = el("div", { class: "card", "data-testid": "people-list" });
    card.appendChild(crumb([{ label: COMPANY.name, href: "#/company/" + COMPANY.id }, { label: "People" }]));
    card.appendChild(el("h2", null, "People at " + COMPANY.name));
    for (const person of PEOPLE) {
      const row = el("div", { class: "person-row", "data-testid": "person-row", "data-person-id": person.id });
      const grow = el("div", { class: "grow" });
      grow.appendChild(el("div", { "data-field": "name" }, person.name));
      grow.appendChild(el("div", { "data-field": "role" }, person.role));
      row.appendChild(grow);
      row.appendChild(el("a", { class: "btn", "data-action": "open-contact", "aria-label": "Open " + person.name,
        href: "#/contact/" + person.id }, "Open"));
      card.appendChild(row);
    }
    app.appendChild(card);
  }

  function renderContact(id) {
    app.innerHTML = "";
    const person = byId.get(id);
    const card = el("div", { class: "card" });
    if (!BROKEN) card.setAttribute("data-testid", "contact-detail");
    card.setAttribute("data-person-id", id);
    card.appendChild(crumb([
      { label: COMPANY.name, href: "#/company/" + COMPANY.id },
      { label: "People", href: "#/team?company=" + COMPANY.id },
      { label: person ? person.name : "Unknown" },
    ]));
    if (!person) { card.appendChild(el("p", null, "Unknown contact.")); app.appendChild(card); return; }

    card.appendChild(el("h2", { "data-field": "name" }, person.name));
    card.appendChild(el("div", { "data-field": "role", class: "muted" }, person.role));

    // Collapsible "Contact information" section
    const toggle = el("button", BROKEN ? {} : { "data-action": "toggle-contact-info", "aria-expanded": "false" },
      "Contact information");
    card.appendChild(el("div", null)).appendChild(toggle);

    const panel = el("div", { class: "info-panel hidden" });
    if (!BROKEN) panel.setAttribute("data-testid", "contact-info");
    const emailRow = el("div");
    emailRow.appendChild(el("span", { class: "muted" }, "Email: "));
    const accessBtn = el("button", BROKEN ? {} : { "data-action": "access-email" }, "Access email");
    emailRow.appendChild(accessBtn);
    if (DUP && !BROKEN) {
      // second, competing Access email button to exercise ambiguity handling
      emailRow.appendChild(el("button", { "data-action": "access-email" }, "Access email"));
    }
    panel.appendChild(emailRow);
    card.appendChild(panel);
    app.appendChild(card);

    toggle.addEventListener("click", () => {
      const open = panel.classList.toggle("hidden") === false;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });

    const doReveal = () => {
      if (emailRow.querySelector('[data-field="email"], [data-testid="reveal-error"], .spinner')) return;
      const spin = el("span", { class: "spinner" }, " revealing…");
      emailRow.appendChild(spin);
      setTimeout(() => {
        spin.remove();
        if (LIMIT) {
          emailRow.appendChild(el("span", { "data-testid": "reveal-error", class: "reveal-error" },
            "No credits remaining"));
        } else {
          emailRow.appendChild(el("span", { "data-field": "email", class: "email-shown" }, person.email));
        }
      }, REVEAL_DELAY);
    };
    accessBtn.addEventListener("click", doReveal);
    if (DUP && !BROKEN) emailRow.querySelectorAll('[data-action="access-email"]').forEach((b) => b.addEventListener("click", doReveal));
  }

  function render() {
    const r = route();
    if (r.view === "people") renderPeople();
    else if (r.view === "contact") renderContact(r.id);
    else renderCompany();
  }

  window.addEventListener("hashchange", render);
  // test/introspection hook (adapters must not use this)
  window.__MOCK_FLOW__ = { company: COMPANY, people: PEOPLE, params: { REVEAL_DELAY, DUP, BROKEN, LIMIT } };
  render();
})();
