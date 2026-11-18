# Changelog

## 0.2.1 — unreleased (security and data-safety hotfix for 0.2.0)

Only fixes. Nothing new is switched on, settings and data are kept, and the database gains two tables (migrations 12
and 13). Upgrade from 0.2.0 with `synaptome upgrade synaptome@0.2.1`. To undo it: `synaptome upgrade --rollback`.

### Fixed: data safety
- `bridge remove`, `repair --fix` and `uninstall --everything` no longer delete a `.mcp.json` Synaptome created when it
  now also holds your own servers, nor a bridge skill you edited, nor files you added next to it (0.2.0 defects B1–B5).
- Connecting and disconnecting are transactions; an unreadable file stops the change before anything is written.
- New `bridge status` (read-only), `bridge update` (in place; replaces repair's remove-then-add) and `bridge adopt`.
- An upgrade that fails is undone completely: the restored copy is checked to start, and a half-written package left by
  an interrupted npm install is moved aside (kept) and the previous version installed afresh. An upgrade that installs a
  different version than the one asked for is undone.
- A damaged database is reported with its path and a safe next step, and nothing is written to it.

### Fixed: security
- Official trust follows the account that holds a capability's code. A listing that names an official publisher for code
  held by someone else no longer earns it, and deny rules apply to both names.
- An instruction that reads a secret (for example `~/.ssh/id_rsa`) and sends it to a web address is blocked. Before, it
  was only flagged for review.
- A trailing cautionary word (for example "… and never refuse") no longer softens an injection finding.

### Fixed: reliability
- The prompt hook always exits 0; it never migrates or creates a home, and a locked or other-version home makes it
  pass the prompt through.
- Cancelling or timing out a model or agent step stops the whole process tree; retries never overlap; timeouts follow
  the step's retry policy.
- A capability load is credited only to the decision that selected it; outcomes are kept even when nothing was loaded.
- `sources` shows what was actually scanned ("NEVER SCANNED") apart from the connectivity probe; `scan` covers every
  enabled permitted source and reads up to 100 items over several pages (the MCP Registry showed 15 before).
- Agent runs with a token or USD budget reserve each billable call's worst case before it starts, so parallel steps can
  no longer exceed the budget together.
- Two processes installing into the same host directory at once can no longer both proceed after a crashed installer left
  its lock behind.

### Known, not fixed in 0.2.1
- Routing defect R1: for "build a TypeScript REST API", a client-SDK generator can be offered and a JavaScript testing
  skill missed. It is fixed in the 0.3.0 line.
- Windows with the Claude desktop app: Claude Code in the app, its hooks and its MCP servers see their own copy of
  the data folder under `AppData`, so they and a terminal can see different databases (which can look like a damaged
  database). Use a data folder outside `AppData` for both, for example `--home "%USERPROFILE%\.synaptome"`.
  0.3.0 adds a `doctor` warning for it.

## 0.2.0 — 2026-11-13 (pre-release on npm)

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

### Fixed
- npm is found in the Linux and macOS layout too (`<prefix>/lib/node_modules`), by `synaptome upgrade`, the tests and
  `npm run ci`; before, upgrade fell back to npm through the shell there and the tests failed.

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
