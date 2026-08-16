# Debug Mode (M3): sanitized structure probe

Read-only structure analysis for a real site you are building an adapter for.
The probe reports **structure only** — repeated row groups, attribute names, id/href
value *patterns*, virtualization signals, scroll containers. It never captures
real names, emails, cookies, or raw DOM text: all text is letter/digit-redacted
(`John Smith 42` → `Aaaa Aaaaa 99`), uuid/hex/digit runs in attribute values
become `{uuid}` / `{hex24}` / `{n}` tokens, and deep URL path segments are
redacted (name slugs never survive). Sanitizers are unit-tested
([tests/unit/probe.test.js](../tests/unit/probe.test.js)) and the whole probe
is leak-checked against the mock site's generated dataset.

## Files

- [structure-probe.js](structure-probe.js) — the probe (UMD: browser global + Node-testable sanitizers)
- [probe-console-snippet.js](probe-console-snippet.js) — one-paste version for the DevTools console

## Running it manually (no extension needed)

1. Log into the target site in your own browser and open the page to analyze
   (typically a list page, then a detail page).
2. Open DevTools → Console.
3. Paste the entire contents of `probe-console-snippet.js` and press Enter.
4. The sanitized JSON report is printed and copied to your clipboard.
5. Save it under `debug/reports/` (e.g. `<site>-list.json`) or hand it to the
   analysis session. Only sanitized reports may enter the repository, and
   site-specific reports for real sites should be kept private (PROJECT_NOTES §2).

Run it once per distinct page type. The interesting outputs are
`repeatedGroups` (candidate record rows: signature, count, attribute names,
link patterns, positioning, scroll container) and `url` (host + path pattern,
for the minimal host-permission decision).
