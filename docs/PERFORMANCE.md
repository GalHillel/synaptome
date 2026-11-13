# Performance

Measured 2026-11-13 on the development machine (Windows 11, Node 24.14.1), with `scripts/perf.ts` on the built package
(`npm run build`). Each size is a disposable home holding the 70 labelled routing-benchmark capabilities plus synthetic
ones up to the size (varied names, domains, tags and descriptions). In-process times exclude Node start-up; CLI and
dashboard times include it. p50 / p95 over the stated number of runs. Raw results: `docs/evidence/phase-11/perf.json`.

| Measure | 1k | 10k | 50k |
|---|---|---|---|
| Fill the registry (one write per capability) | 2.3 s | 25.9 s | 110 s |
| Database size | 3.7 MB | 30.1 MB | 148 MB |
| Overview (20 runs) | 1.3 / 6.3 ms | 58.5 / 68.7 ms | 219 / 248 ms |
| First page of the registry, 200 rows (30) | 10.1 / 11.9 ms | 9.9 / 14.2 ms | 7.2 / 10.5 ms |
| Search, one word, 200 rows (50) | 10.3 / 12.8 ms | 41.8 / 58.6 ms | 151 / 185 ms |
| Capability graph, all nodes and edges (5) | 8.7 / 10.6 ms | 192 / 226 ms | 644 / 747 ms |
| Route a task (60 benchmark tasks) | 10.8 / 16.3 ms | 56.9 / 92.1 ms | 228 / 382 ms |
| Memory of the process after the above | 121 MB | 180 MB | 331 MB |
| 2,000 events written in a burst, seen by a watcher on another connection | 329 ms | 359 ms | 245 ms |
| Sandbox install (snapshot, write, verify, fingerprint) (5) | 25 / 45 ms | 28 / 31 ms | 19 / 34 ms |
| CLI `status --json`, cold (5, median / max) | 328 / 347 ms | 439 / 518 ms | 527 / 542 ms |
| CLI `route`, cold (5, median / max) | 531 / 601 ms | 463 / 966 ms | 535 / 621 ms |
| Dashboard: start to first page served | 482 ms | 1,026 ms | 298 ms |

Terminal Workbench (real terminals, built package, development data of 1,038 capabilities): first paint 225–337 ms,
first data within 1 s (`docs/evidence/phase-9/terminal-workbench.md`). Graph drawing in the browser: 1,015 nodes in
2–3 ms per frame (Phase 8); 10k nodes not measured in a browser (needs the Playwright download approval).

## Against the targets

| Target (plan) | Result |
|---|---|
| Routing p95 ≤ 150 ms in-process at 1k capabilities (Phase 2) | met: 16.3 ms (92 ms at 10k) |
| CLI cold start ≤ 500 ms (Phase 10) | met at 1k: 328 ms median (`--version` 326 ms); 10k 439 ms; 50k 527 ms (over) |
| Registry queries p95 ≤ 50 ms at 10k (Phase 3) | first page 14 ms met; **one-word search 58.6 ms, not met in this run** (40 ms in an earlier run of the same queries) |
| TUI startup ≤ 1.5 s (Phase 9) | met with the built package |

## Variance and what changed

Two full runs were made the same day. Numbers vary by up to about ±50% between runs on this machine (other work
competes for the CPU; the dashboard row moved between 249 ms and 1,026 ms with no change in between), so single
values near a target are not conclusive. Between the runs, the bundled validation library moved from zod 3 to zod 4
(security fix): the bundle grew from 1.6 to 2.3 MB and `--version` from 291 to 326 ms.

One real problem was found and fixed: filling the registry slowed down as it grew (10k took 67 s, 50k took 17 minutes)
because every write looked up its full-text row by an unindexed column. Rows are now keyed by the capability rowid
(schema 9, D-029); writes take constant time (about 1.3 ms each at any size) and 50k fills in under two minutes.

## Where the time goes at 50k

Overview counts the whole registry; search ranks every match with BM25 before taking 200; the graph returns every node
and edge; routing scores more candidates. None of these is indexed for 50k yet. If 50k becomes a real use, the next
steps are cached counts for the overview, a match limit before ranking, and graph data per domain on demand.
