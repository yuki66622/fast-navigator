"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { redactText, patternizeValue, patternizeHref } = require("../../debug/structure-probe.js");

test("redactText leaves no original letters or digits", () => {
  assert.equal(redactText("John Smith 42"), "Aaaa Aaaaa 99");
  assert.equal(redactText("张伟 Wang"), "aa Aaaa");
  const long = redactText("a".repeat(100));
  assert.ok(long.length <= 41 && long.endsWith("…"), "length-capped");
  assert.equal(redactText(null), "");
});

test("patternizeValue tokenizes ids but keeps short structural words", () => {
  assert.equal(patternizeValue("contact-12345"), "contact-{n}");
  assert.equal(
    patternizeValue("6f9619ff-8b86-4d01-b42d-00cf4fc964ff"),
    "{uuid}"
  );
  assert.equal(patternizeValue("66f3a1b2c4d5e6f7a8b9c0d1"), "{hex24}");
  assert.equal(patternizeValue("ab_xkR92"), "ab_xkR92", "short code-like tokens survive");
  assert.match(patternizeValue("dGhpcyBpcyBhIHNlY3JldCBwYXlsb2FkCg=="), /\{b64\}/);
});

test("patternizeHref keeps route words, redacts deep segments and query values", () => {
  assert.equal(patternizeHref("/records/66f3a1b2c4d5e6f7a8b9c0d1"), "/records/{hex24}");
  const slug = patternizeHref("/records/john-smith/details");
  assert.ok(!slug.includes("john"), "deep name slugs are redacted: " + slug);
  assert.ok(slug.startsWith("/records/"), "route word kept");
  const q = patternizeHref("/search?qKeywords=OpenAI&page=2");
  assert.ok(!q.includes("OpenAI"), "query values dropped: " + q);
  assert.ok(q.includes("qKeywords=…"), "query param names kept");
  const abs = patternizeHref("https://app.example.com/records/abc");
  assert.ok(abs.startsWith("{origin}/records"), "origin collapsed: " + abs);
});

test("patternizeHref handles hash-routed links as paths, not query strings", () => {
  const h = patternizeHref("#/contact/c-15");
  assert.ok(h.startsWith("#/contact/"), "hash route structure kept: " + h);
  assert.ok(!h.includes("=…"), "hash must not be parsed as a query: " + h);
  const mixed = patternizeHref("/app?tab=x#/records/jane-doe");
  assert.ok(!mixed.includes("jane"), "hash path slug redacted: " + mixed);
});
