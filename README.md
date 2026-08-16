# Fast Navigator

Fast Navigator is a local-first browser indexing and execution layer for humans and AI agents.

It converts long, dynamic webpage lists into a persistent local index that can be searched, restored, and deterministically located. AI agents can access the same index through MCP instead of repeatedly scrolling through and rereading the webpage.

## Why this project exists

Browser agents are often slow and unreliable when working with large list interfaces.

A typical agent workflow looks like this:

1. Observe the visible webpage.
2. Read the currently rendered rows.
3. Scroll the page.
4. Wait for more rows to load.
5. Read the page again.
6. Repeat until the target is found.

This becomes particularly inefficient on pages using virtualized lists, where only a small portion of the dataset exists in the DOM at one time.

Fast Navigator separates webpage understanding from webpage execution:

```text
Webpage
   ↓
Site Adapter
   ↓
Persistent Local Index
   ↓
Search / State / Record Location
   ↓
Human or AI Agent
```

The page is indexed once. Humans and agents can then query the index directly and only return to the webpage when an actual UI action is required.

## Scope of this repository

This public repository contains **only** the generic pieces: the site-independent
indexing kernel, the synthetic **MockCRM** demo and its `MockAdapter`, the adapter
interface and a development template, the natural-language sidecar, the MCP tools,
the benchmarks, and a read-only structure probe.

It does **not** contain adapters for any real website (no site-specific selectors,
domains, page structures, or scraped data). Real-site adapters are a matter of
private technical evaluation. If you build one from the interface below, you are
responsible for complying with the target website's terms of service, permissions,
and applicable law. The public demonstration uses synthetic data only.

## Core features

### Incremental webpage indexing

Fast Navigator extracts structured records from supported list interfaces and saves them locally. Previously observed records remain searchable even after they are no longer mounted in the DOM.

### Fast local search

Search indexed records by fields such as name, role, company, location, record ID, and processing status. The query engine supports both free-text search and structured field queries.

### Deterministic record location

Search results are connected back to real webpage records. When a user or agent selects a result, Fast Navigator attempts to:

1. locate the record by its stable ID;
2. drive the page or virtual list to the required position;
3. wait for the record to mount;
4. scroll it into view;
5. highlight the corresponding row.

### Persistent state

Indexed records and processing states survive page refreshes. Each record can be marked as:

```text
pending → viewed → done
```

### Natural-language queries

The optional sidecar can translate natural-language requests into structured queries. Without an API key it runs a deterministic offline mock converter (used by all tests); with an OpenRouter key it uses an LLM. The LLM only produces the query — execution stays in the deterministic engine.

Example:

```text
founders in berlin, not interns
```

Derived query:

```text
(founder | co-founder) @role
AND (berlin) @location
NOT (intern)
```

### MCP support

Fast Navigator exposes its index and execution functions through an MCP server. Available tools:

```text
get_index_stats
search_records
locate_record
set_record_status
rescan_page
parse_query
```

An AI agent can therefore query the local index without rereading the webpage. Example workflow:

```text
get_index_stats
→ search_records
→ locate_record
→ set_record_status
```

### Structure-change detection

Site adapters validate the webpage structure before extraction. Fast Navigator distinguishes between normal extraction, fallback extraction, and incompatible structure changes. When extraction is no longer safe, the extension reports an explicit error instead of silently returning an empty result.

## Architecture

Fast Navigator is divided into a site-independent kernel and site-specific adapters.

### Core kernel

The kernel handles local index storage, incremental updates, query execution, state persistence, record location, highlighting, route-change handling, benchmark instrumentation, and MCP communication.

### Site adapters

Each supported interface implements an adapter responsible for:

```text
matches(url)
getScanRoots(document)
extractRecords(root)
getRecordId(record)
scrollToRecord(id)
onRouteChange(url)
```

The adapter converts a specific webpage structure into the generic record model used by the kernel. No site-specific selectors, field names, or routing rules ever appear in the kernel — that separation is a hard architectural contract.

To build your own adapter, copy `extension/adapters/example.template.js` (a fully
commented skeleton implementing all five methods) and study
`extension/adapters/mock/adapter.js` as a working example. The `debug/` structure
probe helps you discover selectors, record IDs and scan roots on your target page,
producing only sanitized output. Keep adapters read-only and within the target
site's terms.

## Repository structure

```text
extension/
    Browser extension, indexing kernel, UI, and adapters

sidecar/
    Natural-language query service and MCP server

mock-site/
    Synthetic virtual-list test environment

bench/
    Benchmark driver and reports

tests/
    Automated tests

PROJECT_NOTES.md
    Architecture decisions, contracts, and benchmark design
```

## Local setup

### Requirements

- Node.js
- npm
- Python 3
- Chromium-based browser
- Claude Code (for the MCP demonstration)

### Install dependencies

```bash
cd /path/to/fast-navigator
npm install
```

## Run the mock environment

Start the synthetic test site:

```bash
npm run mock-site
```

Open:

```text
http://localhost:8765/?count=1000&batch=25&delay=300&seed=42
```

Load the browser extension from the `extension/` directory (`chrome://extensions` → Developer mode → Load unpacked), then click the toolbar icon on the page to open the side panel.

The mock environment simulates 1,000 structured records with batched loading, virtualized rendering, delayed DOM updates, stable record IDs, and controlled structure changes (`&structure=v2` / `&structure=v3`). All data is synthetic and seeded.

## Run the sidecar

```bash
npm run sidecar
```

This enables natural-language query translation. It binds to localhost only; the API key, when configured, lives in `.env` and never reaches the browser.

## Deterministic page actions

Beyond indexing and search, the core is a **deterministic execution layer**: an
agent drives fixed page steps through verified DOM elements — no vision, no
cursor movement, no coordinates. Each action resolves exactly one visible
element (stops with `ambiguous` if several match, `not-found` if none), performs
the click/read, and waits for the real completion condition (route change, DOM
mutation, or revealed text) before returning a structured `{status, result, ms,
trace}`. Login/captcha/permission walls return `blocked` and are never bypassed;
a missing structural anchor returns `structure-changed`; reveal-style actions
return only values actually present in the DOM (never guessed).

The bundled MockCRM **flow demo** (`mock-site/flow.html`) exercises a full
Company → People → contact → contact info → reveal-email chain on synthetic data:

```bash
npm run mock-site   # then open http://localhost:8765/flow.html
```

Actions live only in site adapters (see `extension/adapters/example.template.js`);
the core carries no selectors. Real-site action adapters are private and must
respect the target site's terms.

## MCP setup with Claude Code

Register the local MCP server:

```bash
claude mcp add fast-navigator -- python3 /path/to/fast-navigator/sidecar/mcp_server.py
```

Verify the connection:

```bash
claude mcp list
```

Open the side panel and enable the **Agent** toggle (off by default). Start a new Claude Code session and try:

```text
Use fast-navigator to inspect the current index,
find all founders in Berlin,
and mark the first result as viewed.
```

Expected tool sequence:

```text
get_index_stats
→ search_records
→ set_record_status
```

The agent has the index tools (`search_records`, `locate_record`,
`get_index_stats`, `set_record_status`, `rescan_page`, `parse_query`) plus the
page-action tools `list_page_actions` and `run_page_action`. A full page-action
chain looks like:

```text
run_page_action(read_employee_count)
→ run_page_action(open_people)
→ run_page_action(open_contact, {id})
→ run_page_action(open_contact_info)
→ run_page_action(reveal_email)   # returns the email actually shown, or reveal-failed
```

Every agent call is shown in the side panel's agent activity log (name, result,
timing), and the bridge listens on localhost only.

## Benchmarks

```bash
npm run bench          # npm run bench:quick for a single small tier
```

The MockCRM environment is used to evaluate, under strict fairness rules (same task, same visited data, same targets, result sets cross-checked, unmounted virtual rows never counted as readable DOM):

- **Indexing** — records indexed over time, incremental update latency, duplicate prevention, persistence after refresh.
- **Search** — free-text and structured-field query latency, result accuracy.
- **Record location** — successful location, number of virtual-list loading steps, total latency, failure classification.
- **Agent execution** — webpage observations avoided, MCP tool-call sequence, task completion latency, visible agent action trace.

Full methodology and the latest run are in [bench/results/latest.md](bench/results/latest.md).

## Current limitations

- Each real website requires a dedicated adapter.
- Record location depends on the capabilities of the underlying page.
- Cross-page records may remain searchable while only the current page is directly locatable.
- Free-text substring matching may produce false positives for short search terms.
- The extension does not bypass authentication, rate limits, bot detection, or human verification.
- The project does not automatically crawl entire websites.
- Direct integration with every browser agent platform is not included.

## Intended use

Fast Navigator is designed for synthetic browser-agent benchmarks, internal dashboards, CRM-style list interfaces, recruiting and operations tools, product catalogs, ticket and task systems, and research into deterministic browser-agent execution.

The included public demonstration uses synthetic data. Site-specific adapters must be developed and used in accordance with the relevant website terms, permissions, and applicable law.

## Project status

Fast Navigator is currently a functional research prototype. Implemented and tested: browser-side indexing, persistent record state, virtual-list record location, natural-language query translation, MCP-based agent access, synthetic structure-change testing, and browser-side agent call visibility.

## Design principle

Agents should not repeatedly reread a world that has already been indexed. Fast Navigator gives humans and agents a shared, persistent representation of webpage records, while keeping final execution connected to the real browser interface.
