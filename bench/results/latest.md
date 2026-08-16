# Fast Navigator — M2 benchmark report

Generated: 2026-07-24T17:13:09.101Z · Chromium 149.0.7827.55 · Node v24.16.0 · darwin arm64

## Fairness rules

- Baseline and optimized perform the **same task** over the **same visited data** and locate the **same targets**; result sets are cross-checked (**all checks passed**).
- Unmounted virtual rows are never counted as readable DOM — every variant only sees rows it actually mounted.
- The baseline reuses the adapter's extraction logic for free; a real agent pays far more per row to interpret the DOM. Ratios below are therefore conservative.
- The scanner's MutationObserver is disabled during baseline measurements; nothing pollutes baseline timings.

## Tier: 500 records (batch 50, delay 30ms, seed 42)

Setup: cold scan 1.2ms for 19 mounted rows · index build over visited range 1367ms (40 stops, 450 records)

### 1. Query over visited data

| query | matches | baseline (re-sweep) | optimized (index) | speedup | mounted-only ms | mounted-only completeness |
|---|---|---|---|---|---|---|
| `founder` | 60 | 1361ms | 0.600ms | 2268.2x | 0.200ms | 2% |
| `acme ai` | 14 | 1357ms | 0.500ms | 2714.7x | 0.100ms | 7% |
| `berlin` | 61 | 1355ms | 0.900ms | 1505.2x | 0.100ms | 2% |

Mounted-only search is fast but answers a smaller task — its completeness column shows how many true matches it finds. It is listed to keep the comparison honest, not as an equal baseline.

### 2. Locate a target record (both sides start from the top)

| target | baseline (sweep until mounted) | optimized (index → scrollToRecord) | speedup |
|---|---|---|---|
| c-45 | 164ms | 61.3ms | 3x |
| c-225 | 698ms | 62.1ms | 11x |
| c-405 | 1232ms | 62.4ms | 20x |

### 3. Incremental update (one new batch of 50 rows)

| variant | ms | rows touched |
|---|---|---|
| baseline: full rebuild sweep | 1529ms | 500 |
| optimized: delta sweep of new region | 228ms | ~50 |

Equal-knowledge check (delta-updated index covers all rows the rebuild saw): passed

### 4. State restore after reload (500 records)

| variant | ms |
|---|---|
| baseline: re-drive batches (300ms) + rebuild sweep (1528ms) | 1827ms |
| optimized: read persisted index | 0.400ms |

Note: optimized uses a localStorage read as a stand-in for chrome.storage.local (adds a few ms of IPC in the real extension); baseline must re-drive batched loading (network delays included) and re-read every row.

Aux: 1157 rows extracted across all scans deduplicated into 500 unique records. Cache-hit rate for queries is 100% by construction once the index is built; the honest cost of building it is the "index build" figure above.

## Tier: 2000 records (batch 200, delay 30ms, seed 42)

Setup: cold scan 0.200ms for 19 mounted rows · index build over visited range 5370ms (160 stops, 1800 records)

### 1. Query over visited data

| query | matches | baseline (re-sweep) | optimized (index) | speedup | mounted-only ms | mounted-only completeness |
|---|---|---|---|---|---|---|
| `founder` | 237 | 5360ms | 1.7ms | 3153x | 0.400ms | 0% |
| `acme ai` | 80 | 5343ms | 1.1ms | 4857x | 0.200ms | 1% |
| `berlin` | 230 | 5364ms | 2.1ms | 2554x | 0.200ms | 1% |

Mounted-only search is fast but answers a smaller task — its completeness column shows how many true matches it finds. It is listed to keep the comparison honest, not as an equal baseline.

### 2. Locate a target record (both sides start from the top)

| target | baseline (sweep until mounted) | optimized (index → scrollToRecord) | speedup |
|---|---|---|---|
| c-180 | 566ms | 61.4ms | 9x |
| c-900 | 2698ms | 62.3ms | 43x |
| c-1620 | 4832ms | 62.6ms | 77x |

### 3. Incremental update (one new batch of 200 rows)

| variant | ms | rows touched |
|---|---|---|
| baseline: full rebuild sweep | 5960ms | 2000 |
| optimized: delta sweep of new region | 665ms | ~200 |

Equal-knowledge check (delta-updated index covers all rows the rebuild saw): passed

### 4. State restore after reload (2000 records)

| variant | ms |
|---|---|
| baseline: re-drive batches (293ms) + rebuild sweep (5961ms) | 6254ms |
| optimized: read persisted index | 1.3ms |

Note: optimized uses a localStorage read as a stand-in for chrome.storage.local (adds a few ms of IPC in the real extension); baseline must re-drive batched loading (network delays included) and re-read every row.

Aux: 4518 rows extracted across all scans deduplicated into 2000 unique records. Cache-hit rate for queries is 100% by construction once the index is built; the honest cost of building it is the "index build" figure above.
