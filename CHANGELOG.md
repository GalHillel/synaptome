# Changelog

## 0.2.0 — unreleased (in development)

### Changed
- The product is now called **Synaptome**. Executable `synaptome`, package scope `@synaptome/*`, variables
  `SYNAPTOME_*`, database `synaptome.db`, MCP server `synaptome`. One identity module defines every name.
- The architecture document moved to `docs/ARCHITECTURE.md`.

### Added
- `synaptome migrate`: copies a home written by the previous version to a new home without modifying the
  original; verified, idempotent, with a guarded rollback and a post-migration delta export (`docs/MIGRATION.md`).
- Refusal to open an un-migrated legacy home.
- Master plan, decision log, acceptance matrix, naming clearance and resume documents under `docs/`.
- Routing v2 (`lexical-graph-v2`): classification, activation and exclusion conditions, confidence gate, per-prompt
  and per-capability token budgets, no injection for trivial or administrative prompts; `route --explain`,
  `bench routing`. Event stream authenticated by header instead of a URL token.
- Registry v3: lifecycle state machine with history, versions, sources with health, terms status, backoff and
  budgets; new connectors; foreground scheduler with incremental scans and update monitoring; notifications.
- Security and installation: malicious and benign corpora, licence and supply-chain checks, policy rules that can
  only tighten the gate; install, upgrade, downgrade, uninstall and rollback for skills, agents, commands and MCP
  entries, serialised per host, with edits never discarded silently.
- Workflow engine (`synaptome workflow …`): definitions as data, runs in the database, retries, timeouts,
  cancellation, resume after a crash, approvals for sensitive steps.
- Model providers (`synaptome providers …`) and agent teams (`synaptome team run`, `trace`).
- Skill Forge evaluation sets with held-out cases from an independent author; promotion on held-out evidence;
  deprecation and rollback (`synaptome evalset …`, `forge heldout|deprecate|rollback`).
- Web Command Center: Get started, Sources, Notifications, Integrations, Agents, Evaluation Lab and a capability
  graph; one design-token package for Web and TUI; works at phone width.
- Terminal Workbench: Sources, Notifications, Integrations, Agents, Evaluation Lab, Get started and a text network
  explorer; live updates from the shared event log; help per view; theme saved as a setting; opt-in mouse
  (`synaptome tui --mouse`); `scripts/tui-matrix.ps1` for real-terminal checks.
- Distribution: `npm run build` produces one dependency-free package (`synaptome` command, Node 24 check, prebuilt
  Web assets; CLI starts in about 0.3 s); `synaptome init`, `repair`, `upgrade` (with `--rollback`) and
  `uninstall --everything`; both interfaces open on Get started the first time; `docs/INSTALL.md`, `docs/QUICKSTART.md`.
- Discovery reports a search stopped by a rate limit as a partial scan with the reason.
- Release hardening: threat model, security review, `LICENSE`/`NOTICE`/`THIRD_PARTY_LICENSES.md` in the package,
  `npm run ci`, fuzzing and concurrency tests; zod 4 (security fix) and vitest 5; search index keyed by row id (schema 9),
  so large registries fill in linear time; performance at 1k/10k/50k in `docs/PERFORMANCE.md`.
- Release: `scripts/public-tree.ts` builds the tree of a fresh public history from a commit (development records left
  out, links into them made plain text, refuses on broken links, secret-like strings, machine or author identifiers
  and stray binaries) and can create its one parentless commit; the repository's own history is never changed.

### Deprecated
- The `drelqavo` command (forwards to `synaptome` with a notice) and `DRELQAVO_*` variables (read as a fallback).

## 0.1.0 — 2026-11-11 (first milestone, developed under the working name DRELQAVO)

### Added
- Core: SQLite schema v1 with FTS5, versioned capability record, immutable snapshot store, append-only events,
  validated settings.
- Discovery: connector contract and registry; GitHub connector (repository expansion into skills, agents, plugins,
  prompts, workflows, hooks and MCP manifests; pinned commits; ETag cache; search-budget floor); official MCP
  registry connector; read-only local Claude Code inventory; broad, incremental and need-driven scans; ranking,
  duplicate and overlap flags, evaluation queue, scan history, source health, schedule plan.
- Acquisition: quarantine, static audit, licence evidence, tiers and trust, evidence-based scorecard, eleven-check
  promotion gate with deny rules, approve/reject, per-host install with staged sandbox, real-install budget,
  upgrade with backup, rollback, uninstall, update inspection.
- Routing: deterministic task analysis, rarity-weighted retrieval, direct-match pass, exclusions with reasons, gap
  recording, plan, activation and outcome records; MCP server; project-scoped bridge; UserPromptSubmit hook entry.
- Skill Forge: brief with alternatives, structural lint, security screening, positive and negative activation
  tests, baseline evaluation through pluggable runners, promote/reject/hold, revision.
- Service layer: one command surface; loopback HTTP server with token, origin checks and resumable SSE.
- Web Command Center and Terminal Workbench on shared state.
- CLI with `--json` and stable exit codes.

### Fixed during the milestone (found by tests or live runs)
- A licence merely declared by a source was accepted as compatible; it is now `unknown` unless licence text is
  retrieved.
- The concealment rule flagged ordinary style guidance; narrowed to phrasing that acts behind the user's back.
- Router precision on a 1,000-skill registry: generic words ignored, weak single-keyword domains no longer select,
  coverage weighted by keyword rarity.
- The forged WebGL skill was selected for a generic frontend task; revised through the forge with tighter tags and
  two added negative activation tests.
- Headless model provider misreported the failure cause on Windows because of argument quoting; configuration and
  system prompt now go through files.
- Terminal Workbench acted on stale state when keys arrived faster than a render; interaction state is now read
  synchronously.

### Known gaps
See `docs/PROGRESS.md`.
