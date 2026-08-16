/* MockCRM seeded fake-data generator.
 * UMD-ish: usable as a browser global (MockData) and via Node require() for tests.
 * All data is generated and fake; determinism (same seed -> same data) is a hard
 * requirement so integration tests and benchmarks are reproducible. */
(function (global) {
  "use strict";

  // mulberry32: tiny deterministic PRNG, good enough for fixture data.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const FIRST = ["Ada", "Ben", "Cara", "Dan", "Elena", "Felix", "Grace", "Hugo",
    "Iris", "Jonas", "Kira", "Liam", "Mona", "Nils", "Olga", "Pavel",
    "Quinn", "Rosa", "Sam", "Tara"];
  const LAST = ["Anders", "Brooks", "Chen", "Diaz", "Egan", "Fischer", "Gupta",
    "Hansen", "Ito", "Jung", "Kova", "Larsen", "Meyer", "Novak",
    "Okafor", "Petrov", "Quist", "Rossi", "Silva", "Tanaka"];
  const COMPANIES = ["Acme AI", "Beacon Labs", "Cobalt Systems", "Driftwave",
    "Emberline", "Fjord Analytics", "Glacier Bio", "Helix Grid",
    "Ionfold", "Juniper Stack", "Kestrel Data", "Lumen Forge",
    "Meridian Ops", "Northloop", "Orbital Ink", "Pinecone Robotics",
    "Quartz Signal", "Riverbend AI", "Solstice Cloud", "Tidepool",
    "Umbra Metrics", "Vantage Peak", "Willow Compute", "Zephyr Net"];
  const ROLES = ["Founder", "Co-founder", "CEO", "CTO", "VP Engineering",
    "Engineering Manager", "Technical Recruiter", "Head of Talent",
    "Hiring Manager", "Product Manager", "Data Scientist",
    "ML Engineer", "Software Engineer", "Sales Director",
    "Account Executive", "Operations Lead"];
  const LOCATIONS = ["New York", "San Francisco", "Austin", "Seattle", "Boston",
    "London", "Berlin", "Amsterdam", "Toronto", "Singapore",
    "Tokyo", "Sydney"];

  function generateContacts(count, seed) {
    const rand = mulberry32(seed);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push({
        id: "c-" + (i + 1),
        name: pick(FIRST) + " " + pick(LAST),
        company: pick(COMPANIES),
        role: pick(ROLES),
        location: pick(LOCATIONS),
      });
    }
    return out;
  }

  const api = { mulberry32, generateContacts };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.MockData = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
