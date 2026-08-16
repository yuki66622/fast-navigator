"use strict";
/* Deterministic page actions against the real mock flow page in real Chromium:
 * the full Company → People → Contact → Contact info → Access email → email
 * chain, plus ambiguity, structure-changed, no-guess-email, wait-for-DOM,
 * timeout, and wrong-page. Proves the execution layer without any real site. */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startMockServer, launchBrowser, injectHarness } = require("./helpers.js");

let server, base, browser;

before(async () => {
  ({ server, base } = await startMockServer()); // serves mock-site/
  browser = await launchBrowser();
});
after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

async function open(pathAndQuery) {
  const page = await browser.newPage();
  await page.goto(base + "/flow.html" + (pathAndQuery || ""));
  await injectHarness(page);
  return page;
}

test("full chain: employee count → people → open contact → contact info → reveal email", async () => {
  const page = await open();
  assert.equal(await page.evaluate(() => window.__H.adapterId), "mock");

  const caps = await page.evaluate(() => window.__H.capabilities().map((a) => a.name).sort());
  assert.deepEqual(caps, ["open_contact", "open_contact_info", "open_people", "read_employee_count", "reveal_email"]);

  const emp = await page.evaluate(() => window.__H.action("read_employee_count"));
  assert.equal(emp.ok, true, JSON.stringify(emp));
  assert.equal(emp.result.employees, 1240);

  const people = await page.evaluate(() => window.__H.action("open_people"));
  assert.equal(people.ok, true, JSON.stringify(people));
  assert.ok(people.result.people.length >= 4);
  const founder = people.result.people.find((p) => /founder/i.test(p.role));
  assert.ok(founder, "a founder is present: " + JSON.stringify(people.result.people));

  const opened = await page.evaluate((id) => window.__H.action("open_contact", { id }), founder.id);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.match(opened.result.role, /founder/i);

  const info = await page.evaluate(() => window.__H.action("open_contact_info"));
  assert.equal(info.ok, true, JSON.stringify(info));

  const email = await page.evaluate(() => window.__H.action("reveal_email"));
  assert.equal(email.ok, true, JSON.stringify(email));
  assert.equal(email.result.email, "dana@acme-robotics.example");
  // the returned email is exactly what is now in the DOM (not fabricated)
  const domEmail = await page.evaluate(() => document.querySelector('[data-field="email"]').textContent.trim());
  assert.equal(email.result.email, domEmail);
  assert.ok(email.trace.some((t) => t.step === "click"), "trace records the click");
  await page.close();
});

test("role priority: Founder → CEO → Talent → HR selects the founder first", async () => {
  const page = await open();
  const people = (await page.evaluate(() => window.__H.action("open_people"))).result.people;
  const priority = [/founder/i, /chief executive|ceo/i, /talent/i, /(^|\b)hr\b|human resources/i];
  const pick = priority.map((re) => people.find((p) => re.test(p.role))).find(Boolean);
  assert.ok(pick && /founder/i.test(pick.role), "founder chosen first: " + JSON.stringify(pick));
  await page.close();
});

test("ambiguous Access email -> stops, does not click, reveals nothing", async () => {
  const page = await open("?dup=1#/contact/p-1");
  await page.evaluate(() => window.__H.action("open_contact_info"));
  const r = await page.evaluate(() => window.__H.action("reveal_email"));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "ambiguous");
  assert.equal(r.detail.count, 2);
  const hasEmail = await page.evaluate(() => !!document.querySelector('[data-field="email"]'));
  assert.equal(hasEmail, false, "nothing was revealed");
  await page.close();
});

test("broken structure -> structure-changed, not a silent failure", async () => {
  const page = await open("?broken=1#/contact/p-1");
  const r = await page.evaluate(() => window.__H.action("open_contact_info"));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "structure-changed");
  await page.close();
});

test("credit limit -> reveal-failed, never returns a guessed email", async () => {
  const page = await open("?limit=1#/contact/p-1");
  await page.evaluate(() => window.__H.action("open_contact_info"));
  const r = await page.evaluate(() => window.__H.action("reveal_email"));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "reveal-failed");
  assert.equal(r.result, undefined, "no email field on failure");
  assert.match(r.detail.message, /credit/i);
  await page.close();
});

test("reveal waits for the delayed email to actually appear", async () => {
  const page = await open("?revealDelay=500#/contact/p-1");
  await page.evaluate(() => window.__H.action("open_contact_info"));
  const r = await page.evaluate(() => window.__H.action("reveal_email"));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.ms >= 400, "action waited for the ~500ms reveal, took " + r.ms + "ms");
  await page.close();
});

test("timeout when the reveal is slower than the deadline", async () => {
  const page = await open("?revealDelay=3000#/contact/p-1");
  await page.evaluate(() => window.__H.action("open_contact_info"));
  const r = await page.evaluate(() => window.__H.action("reveal_email", {}, 600));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "timeout");
  await page.close();
});

test("adapter does not own the page -> wrong-page (no action runs)", async () => {
  const page = await open("#/contact/p-1");
  // remove the marker the adapter matches on; the same action now must refuse
  const r = await page.evaluate(() => {
    document.querySelector('meta[name="application-name"]').remove();
    return window.__H.action("read_employee_count");
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "wrong-page");
  await page.close();
});
