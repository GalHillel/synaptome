# Synaptome — master execution plan (Phases 0–12)

## Context

DRELQAVO is a working MVP (discovery, audit, install/rollback, routing, Skill Forge, CLI, MCP bridge, Web
Command Center, Ink TUI). The goal is a production-quality, independently branded product that another
developer can install on a clean supported system, configure, use, extend, update and uninstall reliably.
"Synapse OS" failed name clearance; the product is **Synaptome**, executable `synaptome`, licence
**Apache-2.0** for eligible original code. Existing working code and Git history are preserved.

## Fixed decisions

- **The repository stays in its existing `DRELQAVO` folder on the owner's desktop.** No rename, move, duplicate or session
  restart. The folder name is a legacy path only; nothing in the product may depend on or display it.
- **Everything else is rebranded** to Synaptome: packages and scope, bin, env vars, data dir and db, MCP
  server, bridge skill, hook, UI, docs, tests, fixtures, artifacts. Legacy names survive only in the migration
  code, a deprecated compatibility shim, the changelog and internal provenance records.
- **Continuous execution.** After approval, phases run in order without stopping at phase boundaries.
  Ordinary coding, testing, local commits, docs and project-local changes need no further permission.
- **Explicit approval still required for:** installs into personal AI hosts, global Claude Code config,
  persistent scheduled tasks/services, domain purchases, npm publish, creating/modifying remotes, pushing,
  visibility changes, public releases, anything else touching external systems or the personal environment.
- **Truthfulness.** Statuses are VERIFIED / PARTIAL / BLOCKED / NOT STARTED with evidence. Passing tests, an
  opening dashboard, a built package or a single demo are milestones, not completion.

## Verified baseline (2026-11-11)

95/95 tests, typecheck clean · 11 commits on `main`, clean tree, no remote · TypeScript on Node 24 via `tsx`,
`node:sqlite`, 11 packages + 3 apps, ~11.7k lines · 520 `drelqavo` occurrences in 80 files, 8 `DRELQAVO_*`
env vars · data only in `.drelqavo-dev/` · no code from the upstream project, 7 docs mention it as provenance · web server has
loopback bind, Host/Origin allow-list, token, CSP, but SSE token in the query string · the UserPromptSubmit
hook fired in a fresh session yet injected 20.5 KB of weakly relevant skills into a planning prompt.

## Conventions for every phase

- **Slices.** Each phase is cut into vertical slices (listed as S1, S2…). A slice ends with: `npm test`,
  `npm run typecheck`, evidence under `docs/evidence/<phase>/`, one local commit.
- **Item 19 (commit and docs), identical for all phases:** local commit per slice on `rebrand/synaptome`
  (later `main` after merge); update `docs/PROGRESS.md`, `docs/NEXT_SESSION.md` (exact next action),
  `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (ADR entries), `docs/ACCEPTANCE_MATRIX.md`, `ROADMAP.md`, `CHANGELOG.md`.
- **Item 17 (rollback), default for all phases:** every phase starts from a tag `phase-N-start`; a failed
  slice is reverted with `git revert`/reset to the last green commit; data changes are copy-based with a
  verified backup. Phase-specific additions are listed where they exist.
- **Isolation.** Risky tests use disposable homes (`SYNAPTOME_HOME` in a temp dir) and sandbox hosts
  (`SYNAPTOME_CLAUDE_ROOT` pointing at a temp tree). The real `~/.claude` is read-only to the project.
- **If a session ends** (context, usage limit, interruption): the repository docs above hold the exact state;
  work resumes from the last green commit.

Numbered fields below: 1 Objectives · 2 Functional requirements · 3 Architecture · 4 Packages/components ·
5 Preserve/improve · 6 User-facing · 7 CLI · 8 Web · 9 TUI · 10 Security · 11 Tests · 12 Integration tests ·
13 Real-world verification · 14 Acceptance criteria · 15 Prerequisites · 16 Deliverables · 17 Rollback · 18 Done.

---

## Phase 0 — Baseline, name clearance, programme scaffolding

1. Freeze a verified starting point; clear the name before any rebrand work.
2. Preliminary clearance for "Synaptome"; rerun reported live behaviours; create continuity documents.
3. None.
4. Docs only.
5. Everything; no source changes.
6–9. None.
10. Clearance uses public lookups only; no purchases or registrations. Live reruns use a disposable home and sandbox host.
11. Baseline `npm test`, typecheck. 12. Live GitHub + MCP-registry scan, candidate audit, sandbox install and rollback.
13. `doctor`, dashboard and TUI opened once to confirm they start.
14. Clearance report covers USPTO, EUIPO, WIPO Global Brand Database, Israeli register (classes 9/42); npm
    unscoped `synaptome` and `@synaptome` scope; PyPI, crates.io, Docker Hub; GitHub user/org/repos;
    .com/.dev/.io/.ai availability; commercial products. Every reported MVP claim is marked re-verified or not.
15. Network access. 16. `docs/NAMING_CLEARANCE.md`, `docs/NEXT_SESSION.md`, `docs/DECISIONS.md`,
    `docs/ACCEPTANCE_MATRIX.md` (skeleton, all subsystems A–N), branch `rebrand/synaptome`, tag `drelqavo-0.1.0`.
17. Nothing to roll back. 18. Report committed; **if a material conflict appears, stop and ask before Phase 1**;
    final legal validation remains a Phase 12 gate.

Slices: S1 branch, tag, docs skeleton · S2 clearance report · S3 live reruns and evidence.

## Phase 1 — In-place rebrand and recoverable data migration

1. The active product is Synaptome everywhere except the folder path; data migrated safely; integrations keep working in this session.
2. Rename all identifiers; migrate the dev home; refresh project-scoped MCP/hook config; temporary legacy compatibility.
3. One identity source: `PRODUCT` in `packages/core/src/index.ts` gains `bin`, `envPrefix`, `dataDir`,
   `dbFile`, `tokenHeader`, `mcpName`; all other sites read it. Repo root is found from the launcher's own
   location (already the case in `apps/cli/bin`), never from the folder name.
4. All `package.json` (`@drelqavo/*` → `@synaptome/*`), `tsconfig.json` paths, `apps/cli/bin/synaptome.mjs`,
   `packages/core/src/db.ts` (`resolveHome`, `pathsFor`), `packages/service`, `packages/mcp-server`,
   `apps/command-center/src/{build.ts,lib.tsx}`, `apps/cli/src/commands/routing.ts` (bridge/hook),
   `packages/discovery` (task names), all tests/fixtures, all docs. New `packages/core/src/migrate.ts`.
5. All behaviour unchanged; 95 tests keep passing under new names.
6. Product name, titles, messages, diagnostics all say Synaptome.
7. `synaptome …` for every existing command; new `synaptome migrate [--from] [--dry-run] [--rollback]`.
   `apps/cli/bin/drelqavo.mjs` stays as a deprecated shim (prints one notice to stderr, forwards) so the
   hook and MCP server already loaded in this running session keep working.
8. Title, meta token name, header renamed. 9. Title and labels renamed.
10. Migration is copy-based and never writes to the source: (a) stop dashboard/TUI/MCP where possible, but
    correctness must not depend on it; (b) open the source **read-only** and copy the database with the SQLite
    online backup API (`node:sqlite` `backup()`), which yields a transactionally consistent copy including
    WAL content without checkpointing, vacuuming or otherwise modifying the source files; no
    `wal_checkpoint`, no `VACUUM` against the source; source file hashes are recorded before and after to
    prove it was untouched; (c) `integrity_check` and `foreign_key_check` on the copy (read-only
    `quick_check` on the source); (d) non-db files copied to a staging dir; per-table row counts compared and
    every snapshot re-hashed against its manifest; (e) atomic rename staging → new home, write a marker with
    source hashes and counts (rerun = no-op); (f) old home never modified or deleted.
    **Rollback never silently destroys data:** `migrate --rollback` compares the new home with the marker;
    if anything was created or changed after migration it refuses, keeps both homes, reports the differences
    and requires an explicit recovery choice (keep new, export the delta, or discard with a named confirmation
    flag after a backup of the new home is written). `DRELQAVO_*` env read as fallback with a warning.
    Bridge files rewritten only in the project (`.mcp.json`, `.claude/settings.local.json`, bridge skill); global config untouched.
11. Unit tests for `resolveHome` precedence and legacy fallback; migration tests: fresh, repeated
    (idempotent), consistency while another process is writing to the source, interrupted mid-copy (staging
    discarded, no partial home), corrupted source, integrity failure, snapshot hash mismatch, source
    byte-identical afterwards, rollback with and without post-migration data, recovery paths; shim test; old
    `.drelqavo-bridge.json` cleaned exactly.
12. Full suite against a migrated copy of the real dev data. 13. Run migrate on a copy of `.drelqavo-dev`,
    then for real to `.synaptome-dev`; `synaptome status/doctor/skills/route/forge list`, dashboard, TUI and
    `synaptome mcp` (stdio handshake) all exercised from the unchanged folder. Integration refresh: `bridge
    remove` (old) then `bridge init` (new); verified by an isolated `claude -p` process in a temp project where
    login allows; whether the *current* session hot-reloads is recorded as observed, not assumed, and is not a prerequisite.
14. `git grep -i drelqavo` hits only shim, migration code, changelog, `docs/internal/`; row counts and
    snapshot hashes identical pre/post; second migrate run changes nothing; rollback restores the prior state; ≥95 tests green.
15. Phase 0 clearance without material conflict. 16. Rebranded tree, migration tool, `docs/MIGRATION.md`,
    `docs/internal/PROVENANCE.md` (upstream tracker, audit findings, naming history moved here, not deleted).
17. Old home intact at all times; `synaptome migrate --rollback` as defined in 10 (refuses when post-migration data exists); tag `phase-1-start`; shim keeps old config valid.
18. All of 14 plus manual pass of CLI/Web/TUI/MCP/router/forge under the new name.

Slices: S1 identity source + package/scope rename · S2 bin, env, db, header, MCP, shim · S3 migrate tool and
tests · S4 real data migration and bridge refresh · S5 docs and provenance move.

## Phase 2 — Context efficiency, reliable routing, host integration proof (subsystems D, E)

1. Synaptome must lower context overhead and know when not to activate.
2. Per-task context budgets; compact summaries; on-demand full instructions; activation/exclusion
   conditions; minimum confidence; zero injection when nothing genuinely qualifies; trivial, administrative,
   irrelevant and purely meta prompts never inject. **Planning is not excluded as a category:** substantive
   technical planning, architecture, security engineering and complex design tasks stay eligible and receive
   specialised capabilities when activation conditions and the confidence threshold are met, within the same
   strict budgets. Measured tokens and latency; false-activation regression tests; verified Claude Code
   integration; SSE authentication fix (moved here from Phase 8).
3. Router pipeline becomes: classify (task type, domains, complexity) → retrieve (FTS5/BM25 + metadata
   filters) → graph expand → condition filter → score (lexical + quality evidence + outcome history) →
   confidence gate → budget. `RoutingStrategy` kept; new strategy id `lexical-graph-v2`; v1 kept for comparison.
   Capabilities gain `activation`/`exclusion` condition fields and a stored `summary` (schema migration v2).
4. `packages/router`, `packages/core` (schema v2, taxonomy, summary generator), `packages/mcp-server`,
   hook in `apps/cli/src/commands/{routing,forge}.ts`, `packages/router/test/benchmark/`,
   `packages/service/src/index.ts` and `apps/command-center/src/lib.tsx` (event-stream authentication).
5. Keep deterministic explainable routing, decision records, gaps. Improve precision.
6. Decisions show why something was or was not activated, with tokens and ms.
7. `synaptome route --explain` (confidence, rejected candidates and reasons), `synaptome bench routing`,
   `synaptome decisions` with overhead columns, `config set routing.*` budgets.
8. Routing Explorer shows classification, confidence, budget use. 9. Same in the Routing view.
10. Served capability text stays labelled as reference material beneath user instructions; hook never
    injects blocked/unapproved capabilities; budgets cannot be raised by capability content.
    **SSE authentication:** the query-string token is removed; the event stream authenticates with an
    HttpOnly, SameSite=Strict, path-scoped session cookie issued only on the token-authenticated page load
    (or a header-carrying fetch stream if the cookie proves weaker in testing). Loopback bind, per-start
    random token, Host and Origin allow-lists, CSP and cross-site request protection are all preserved; the
    token never appears in URLs, logs or screenshots. Done before workflows and agents extend the service.
11. Unit tests for classifier, gate, budgets, summary size. Benchmark ≥150 labelled tasks: simple,
    engineering, design, research, multi-domain, no-capability, must-not-activate, trivial/administrative/meta,
    and substantive planning/architecture/security-design tasks that **must** activate the right capability.
    Server tests: wrong Host, foreign Origin, missing/invalid credentials and cross-site attempts are rejected
    on every route including the stream; old `?token=` URLs are refused.
12. Hook end-to-end through the real CLI with host-shaped payloads; MCP `route_task` → `get_capability` → `record_outcome`.
13. Fresh `claude -p` session in a temp project: explicit invocation and unprompted routing (needs `claude`
    login; if expired, exact steps are given and the item stays BLOCKED, not claimed). Replay of this
    session's prompt must stay within budget and inject only capabilities that pass conditions and
    confidence (the two weak picks observed must not recur). Dashboard live updates verified in the browser after the auth change.
14. Hook injection ≤ 800 estimated tokens per prompt, ≤ 300 per capability, 0 for non-qualifying prompts;
    benchmark false-activation rate ≤ 5%, precision@selected ≥ 0.85, must-not-activate set 100% clean;
    p95 routing latency ≤ 150 ms in-process at 1k capabilities, hook wall time reported. Numbers are
    measured and committed before/after; thresholds enforced in CI. If lexical cannot meet them, add an
    optional local semantic or model-assisted strategy, justified by the benchmark, off by default.
15. Phase 1. 16. Router v2, benchmark + report, compact hook, evidence of live sessions.
17. Strategy switch `routing.strategy` back to v1; schema migration backs up the db first.
18. Thresholds met, live proof recorded with its real status.

Slices: S1 SSE authentication replacement + server tests · S2 measurement + benchmark harness (baseline
numbers) · S3 compact summaries, budgets, zero-injection rules · S4 conditions, classifier, confidence gate ·
S5 outcome/evidence scoring · S6 live host proof.

## Phase 3 — Canonical registry and autonomous discovery (A, B)

1. One scalable registry and a discovery system that runs continuously, visibly and politely.
2. Lifecycle states, versions, relations, dependencies, evidence, install history, evaluation results;
   connectors for more legitimate sources; scheduling; incremental scans; update detection; dedup and overlap;
   gap-driven discovery; source health; retry/backoff; rate budgets; provenance; notifications.
3. Schema v3: `capability_versions`, `dependencies`, lifecycle state machine with enforced transitions,
   `sources` table (health, budget, terms/robots status), `notifications`. Scheduler is an explicit
   foreground-or-registered runner (`synaptome scheduler run`), no hidden services.
4. `packages/core` (schema, state machine), `packages/connectors` (GitLab, official Agent Skills repos,
   vendor extension sources, curated lists, npm/PyPI package signals), `packages/discovery` (scheduler,
   dedup, ranking, update monitor), new `packages/notify`.
5. Keep `DiscoveryConnector` contract, GitHub/MCP-registry/local connectors, scan history.
6. Source management, schedules, update and quality notices. 7. `sources add|enable|disable|health`,
   `scan`, `schedule show|enable|disable` (registration prints the OS command and asks), `updates`, `notifications`.
8. Discovery, Sources, Updates screens. 9. Discovery and Sources views.
10. robots.txt and terms respected per source (skills.sh stays blocked); tokens read at runtime, never
    stored or logged; registering an OS scheduled task requires explicit approval.
11. Connector contract tests with recorded fixtures; state-machine property tests; dedup tests; backoff tests with a fake clock.
12. Scheduler run over fake sources; update detection against a local git fixture repo that changes upstream.
13. Live scans against each enabled source; a 24-hour foreground scheduler soak if session time allows, else recorded as PARTIAL.
14. ≥5 live sources healthy; incremental scan fetches only changed items; registry queries p95 ≤ 50 ms at
    10k capabilities; duplicates of a seeded set detected ≥ 95%; no source exceeds its rate budget.
15. Phase 2 schema. 16. Connectors, scheduler, update monitor, registry v3, docs. 17. Per-migration db backup; connector disable switch.
18. Criteria met with evidence; unsupported sources documented honestly.

Slices: S1 schema v3 + lifecycle · S2 source management, health, backoff, budgets · S3 new connectors ·
S4 scheduler + incremental + update monitor · S5 dedup/overlap/gap-driven discovery + notifications.

## Phase 4 — Security, audit, trust and installation lifecycle (C, E)

1. Untrusted capability content can never execute or silently gain permissions; installs are reversible.
2. Quarantine; licence detection (SPDX); supply-chain checks (pinned refs, hashes, dependency advisories,
   publisher change); permission analysis; policy engine; malicious-content and prompt-injection detection;
   promotion gates; isolation; auto-acquisition only when all gates pass; full install lifecycle.
3. Policy engine as data (`policies` in settings, evaluated by `PermissionPolicy`); audit rules versioned.
   **Static analysis is the default and preferred path for untrusted candidates.** Dynamic testing of
   untrusted executable content is allowed only inside a strong isolation boundary with explicit
   filesystem, network, credential and process restrictions: Windows Sandbox or a container/VM with no
   network, no host mounts beyond a read-only copy of the candidate, no credentials or user environment,
   and a hard process/time limit. The Node.js permission model, a child process or a stripped env are not
   treated as a boundary. An `IsolationProvider` probes what is available; **if no sufficiently strong
   isolation exists the dynamic test is BLOCKED and the candidate cannot pass on it** (the gate is never weakened).
4. `packages/security` (rules, licence, permissions, policy), `packages/acquisition` (lifecycle), `packages/adapters`
   (Claude Code full kinds: skills, agents, commands, MCP entries, project scope; OpenCode verified against its docs).
5. Keep the static audit, tiers, scorecard, snapshot integrity, rollback, real-install budget.
6. Clear reasons for every hold/block. 7. `audit`, `policy show|set`, `install|upgrade|downgrade|uninstall|rollback`, `verify`.
8. Security and Installation Queue screens with diff views for updates. 9. Security and Queue views.
10. No install into personal hosts without asking; never overwrite content Synaptome did not create;
    generated or acquired capabilities cannot widen their own permissions.
11. Malicious corpus (prompt override, pipe-to-shell, hidden Unicode, exfiltration, hook abuse, MCP tool
    poisoning) with expected findings; false-positive corpus of benign security docs.
12. Install matrix in sandbox hosts: fresh, repeat, upgrade, downgrade, failed upgrade, concurrent installs,
    uninstall, rollback, config conflict, pre-existing user skill of the same name.
13. Audit of the 1,015 locally indexed skills re-run and compared with the earlier 20 findings.
14. 100% of the malicious corpus blocked; false positives ≤ 10% on the benign corpus; every matrix case
    leaves the host byte-identical after rollback; concurrent installs never corrupt records.
15. Phase 3 versions. 16. Hardened pipeline, policy engine, adapters, `docs/SECURITY_MODEL.md`.
17. Installation records + snapshots restore any host state. 18. Criteria met; adapter statuses reflect what was tested.

Slices: S1 corpora + rule upgrades · S2 licence/supply-chain/permission analysis · S3 policy engine + auto-acquisition
gate · S4 install matrix + concurrency · S5 adapters (Claude Code kinds, OpenCode verification).

## Phase 5 — Workflow engine (H)

1. Real, controlled execution of workflows, replacing the plan-only executor.
2. Typed steps with input/output contracts, DAG dependencies, checkpoints, retries, timeouts, cancellation,
   resumability, error propagation, approvals, permission boundaries, execution history.
3. New `packages/workflow`: definitions (validated schema), scheduler over the DAG, step runners
   (`api-call` to `createApi`, `model` via `ModelProvider`, `agent`, `approval`, `shell` restricted to an
   allow-list and off by default), state in SQLite (`workflow_runs`, `step_runs`, `checkpoints`), events to the shared stream.
4. `packages/workflow`, `packages/service` (API), CLI, Web, TUI.
5. `WorkflowExecutor` interface extended, plan output from the router reused as a workflow draft.
6. Run, watch, approve, cancel, resume workflows. 7. `workflow list|show|run|status|approve|cancel|resume|history`.
8. Workflows screen with live DAG and step logs. 9. Workflows view with step tree and log tail.
10. Each step declares required permissions; approval gates before anything that installs or writes outside the home.
11. Engine unit tests: ordering, parallel branches, retry with backoff, timeout, cancellation, contract violations.
12. Kill the process mid-run and resume from checkpoint; approval round-trip across CLI and Web.
13. Real workflow 1: discover → audit → sandbox install → verify → report. Real workflow 2: gap → forge draft → evaluate.
14. Both workflows complete end to end; resume after kill loses no completed step; history fully reconstructable.
15. Phases 3–4. 16. Engine, two shipped workflows, docs. 17. Runs are append-only; a failed run can be resumed or abandoned.
18. Criteria met in CLI, Web and TUI.

Slices: S1 schema + definitions + sequential runner · S2 DAG parallelism, retries, timeouts · S3 checkpoints,
cancel, resume · S4 approvals + permissions · S5 interfaces + shipped workflows.

## Phase 6 — Model providers and multi-agent orchestration (G, I)

1. Provider-neutral model layer and a real specialist-agent orchestrator.
2. Providers with availability/auth/privacy/cost metadata and task-based selection; agent definitions with
   capability requirements; decomposition; sequential and parallel execution; handoffs; shared task state;
   structured results; failure recovery; cancellation; timeouts; budgets; traces; approval gates.
3. `packages/providers`: registry over `ModelProvider`; adapters for headless Claude Code (existing),
   Anthropic API, OpenAI-compatible HTTP (covers OpenAI and local servers such as Ollama), Gemini; each
   marked VERIFIED only after a live call with credentials from the environment, otherwise UNVERIFIED.
   `packages/agents`: orchestrator built on the workflow engine (agents are steps), blackboard state in SQLite.
4. `packages/providers`, `packages/agents`, service/CLI/Web/TUI.
5. Existing `ModelProvider`, evaluation runners. 6. Pick a team, run, inspect trace and cost.
7. `providers list|test`, `agents list|show`, `team run <task>`, `trace <run>`.
8. Agents, Integrations screens; run trace viewer. 9. Agents view; trace tree.
10. No credentials stored or logged; private data is not sent to an external provider unless the privacy
    setting allows that provider; per-run token/cost/time budgets enforced; no simulated runs reported as real.
11. Orchestrator tests with a deterministic fake provider: handoff, parallel fan-out, failure recovery, budget stop, cancel.
12. Provider contract tests; orchestration through the workflow engine with checkpoints.
13. One real Research → Architecture → Implementation → Review → Testing run on a small coding task in a
    temp repo using an authenticated provider (headless Claude Code; needs `claude` login).
14. Real run completes with a trace, per-agent outputs and budget accounting; every provider's status is evidence-backed.
15. Phase 5. 16. Provider registry, orchestrator, 5 specialist definitions, trace UI. 17. Runs resumable/abandonable.
18. Real run recorded; unavailable providers reported as such.

Slices: S1 provider registry + availability · S2 additional adapters · S3 agent definitions + sequential team ·
S4 parallelism, handoffs, budgets, recovery · S5 real end-to-end run + interfaces.

## Phase 7 — Skill Forge maturity (F)

1. A capability-engineering loop whose promotions are justified by evidence.
2. Gap detection, prior-art research, generation, refinement, activation/exclusion conditions, test
   generation, security inspection, functional evaluation, baselines, regression tests, versioning,
   promotion, rejection, deprecation, rollback.
3. Forge runs as a workflow; evaluation datasets are first-class (`eval_sets`, train/held-out split,
   authorship recorded); graders deterministic plus optional independent model judge from a different provider.
4. `packages/forge`, `packages/evaluation`, workflow definitions.
5. Existing draft/check/eval/revise/decide loop and WebGL evidence. 6. Forge pipeline with evidence per version.
7. `forge new|research|author|check|eval|revise|promote|reject|deprecate|rollback`, `eval sets`.
8. Skill Forge and Evaluation Lab screens. 9. Forge view.
10. Generated skills pass the full Phase 4 audit and cannot declare new permissions; promotion requires the gate.
11. Unit tests incl. `forge revise`; overfitting detector (train vs held-out gap); regression gate on revise.
12. Full forge workflow with fake provider; version promote then rollback.
13. Two real gaps forged with ≥20 cases each (≥10 held-out, not authored by the generating run), baseline vs skill, sample sizes documented.
14. Promotion only when held-out improvement is positive with stated n; a deliberately overfit skill is rejected; rollback restores the prior version.
15. Phases 4–6. 16. Forge v2, datasets, evidence. 17. Version rollback. 18. Criteria met; limits of small n stated.

Slices: S1 eval sets + held-out · S2 research + generation + conditions · S3 regression/overfitting gates ·
S4 versioning/deprecation/rollback · S5 real forged skills.

## Phase 8 — Web Command Center and Synaptome identity (J)

1. A premium, fully functional console with an original identity.
2. Screens: Overview, Discovery, Sources, Library, Inspector, Queue, Security, Routing Explorer, Forge,
   Evaluation Lab, Agents, Workflows, Integrations, Activity, Settings, Onboarding. Command palette, shortcuts,
   search/filter, loading/error/offline states, responsive layout, theme persistence, accessible dialogs, live events.
3. Design system in `packages/ui-tokens` shared with the TUI: restrained palette, type scale, spacing,
   density modes, light/dark. Capability graph: clustered by domain/kind with level-of-detail (canvas),
   expand-on-select, search, filters, dependency/conflict highlighting, plus a table alternative. Mark: an
   abstract junction/gap motif, no brain, no neon, no glass.
4. `apps/command-center` (split `views.tsx` into per-screen modules), `packages/ui-tokens`, `branding/`.
5. Existing React app, esbuild bundling, API client. 6–8. As in 2. 9. Tokens shared.
10. Server authentication was fixed in Phase 2 and is regression-tested here for every new route;
    privileged actions need confirmation; no token in URLs, logs or screenshots.
11. Component tests; server tests asserting wrong-host, cross-origin and unauthenticated requests are
    rejected on every route including the stream. 12. Playwright flows for each screen against a seeded home.
13. Manual pass of every control in the browser pane, both themes; axe run; keyboard-only pass.
14. Every screen backed by real data; zero console errors; WCAG AA contrast; graph interactive at 60 fps
    with 1k capabilities and usable at 10k via clustering; no dead controls.
15. Phases 2–7 APIs. 16. Rebuilt UI, design system, brand assets, screenshots. 17. Previous UI recoverable from git; feature by feature commits.
18. Criteria met with screenshots and test evidence.

Slices: S1 tokens, shell, navigation, palette · S2 core screens · S3 graph ·
S4 workflow/agent/forge/eval screens · S5 onboarding, settings, a11y, responsive.

## Phase 9 — Terminal Workbench (K)

1. A first-class TUI, independent of the browser.
2. All subsystems reachable; multi-pane adaptive layout with narrow fallback; palette; search; filters;
   inspectors; contextual actions; logs; live updates; themes; help; error handling; clean process exit;
   text-based network explorer (tree and adjacency navigation); mouse support if reliable in Windows Terminal.
3. Keep Ink; split `index.tsx` into view modules; shared tokens; event subscription instead of coarse polling.
4. `apps/terminal-workbench`. 5. Existing model, layouts and 9 tests. 6–9. As in 2.
10. Same confirmations as Web for privileged actions. 11. ink-testing-library tests per view and width.
12. Action in TUI visible in CLI/Web and reverse. 13. Manual runs in Windows Terminal, PowerShell and cmd.
14. Every view works at 80, 120 and 200 columns; no orphan processes after exit; startup ≤ 1.5 s.
15. Phases 2–7 APIs. 16. Completed TUI, screenshots. 17. Git. 18. Criteria met with evidence.

Slices: S1 structure + live events · S2 remaining views · S3 network explorer · S4 logs, help, themes, mouse · S5 terminal matrix.

## Phase 10 — Distribution, installer, onboarding (L)

1. A real installable product.
2. Production build; npm package; `init` covering OS detection, prerequisites, host detection, permission
   explanation, storage init, selected adapters only, project-scoped integration offer, verification,
   onboarding launch; upgrade, repair, uninstall, rollback, diagnostics; first-run onboarding in Web and TUI.
3. Build with tsup/esbuild to `dist/` (bundled workspaces, prebuilt web assets, no `tsx` at runtime); one
   published package; engine check for Node ≥ 24 with a clear message. Name and scope availability re-checked before anything is reserved.
4. Build scripts, `apps/cli` (`init`, `upgrade`, `repair`, `uninstall`, `doctor`), onboarding flows.
5. Dev workflow through `tsx` stays. 6. Install → init → working product without reading source.
7. Commands above. 8. Onboarding wizard. 9. Onboarding flow.
10. Never modifies all detected hosts automatically; every host change is opt-in, recorded and reversible; uninstall removes only what was created.
11. Build smoke tests; `npm pack` content test (no dev data, no internal docs, no secrets).
12. Install from tarball into a temp prefix; upgrade from an older tarball; repair after deleting files; uninstall leaves nothing.
13. Clean-room run of the 15 external-user steps in Windows Sandbox or a fresh local user profile with no
    dev state; recorded step by step. macOS/Linux only via CI, claimed only if green.
14. All 15 steps pass from the tarball; CLI cold start ≤ 500 ms; uninstall leaves zero files outside the user's own data choice.
15. Phases 1–9. 16. Tarball, installer commands, onboarding, `docs/INSTALL.md`, `docs/QUICKSTART.md`.
17. `upgrade` keeps the previous version and db backup for rollback. 18. Clean-room evidence committed.

Slices: S1 build pipeline · S2 packaging + pack test · S3 init/doctor/repair/uninstall · S4 upgrade/rollback ·
S5 onboarding · S6 clean-room.

## Phase 11 — Release hardening (N)

1. Evidence that the product is safe, fast, accessible and compliant enough to publish.
2. Security review; privacy review; dependency scan; licence compliance; performance; accessibility; reliability; platform matrix.
3. CI workflows in `.github/workflows` (run locally with the same scripts until a remote exists): typecheck,
   unit, integration, benchmark thresholds, audit, pack validation, installer tests; Windows required, macOS/Linux reported.
4. CI, `scripts/`, `docs/SECURITY_REVIEW.md`, `docs/THREAT_MODEL.md`, `docs/PERFORMANCE.md`, `THIRD_PARTY_LICENSES.md`, `NOTICE`, `LICENSE`.
5. All. 6–9. Fixes found by the reviews.
10. Threat model covering malicious skills, prompt injection, MCP tool poisoning, supply chain, credential
    exposure, unsafe shell, filesystem/network access, hooks, privilege escalation, unsafe updates, local HTTP,
    CSRF/DNS rebinding, db integrity, multi-process concurrency; every finding fixed or accepted in writing.
11. Fuzz tests for parsers and the HTTP API; concurrency stress (CLI + TUI + Web writers). 12. Full suite on CI matrix.
13. Secret and history scan (gitleaks); `npm audit`; licence scan of all dependencies and bundled content;
    measurements at 1k, 10k, 50k capabilities: CLI/TUI/Web start, query latency, discovery throughput, routing
    latency, context overhead, memory, event processing, install time.
14. No high/critical open findings; no secrets or personal paths in tracked files or history (evidence files
    sanitised); all dependencies licence-compatible with Apache-2.0; performance table published with real numbers.
15. Phases 1–10. 16. Reports, CI, licence files, completed acceptance matrix. 17. Git. 18. Release gates all green or explicitly BLOCKED with reason.

Slices: S1 CI scripts · S2 threat model + fixes · S3 scans + licence audit · S4 performance · S5 a11y + reliability.

## Phase 12 — Public product and launch (M) — gated

1. A professional public presence and a verified public install.
2. README, architecture, install guide, quick start, CLI examples, screenshots (Web and TUI), demo, security
   policy, contributing, issue/PR templates, changelog, release notes, Code of Conduct, support; landing page
   in `site/` using the product identity with no invented metrics, testimonials or platform claims.
3. Static site built from the same tokens. 4. `site/`, `.github/`, root docs. 5. Internal provenance stays out of the package and public docs where not required; truthful history kept in `docs/internal/` (decision at release audit on whether that folder is public).
6–9. Documentation of everything shipped.
10. Final legal/naming validation. **Publication review of the exact Git tree and full history before any
    push:** accurate provenance, licensing and security history is kept, but `docs/internal/`, evidence
    files and all historical commits (including the DRELQAVO-era ones, personal paths, names and upstream
    notes) become public with the repository. The review lists every sensitive item found in tree and
    history and proposes options (publish as is, exclude paths going forward, publish from a fresh
    history with the full history kept privately, or a filtered history). **No history rewriting or
    exclusion strategy is applied without your approval**; the local repository's original history is never altered.
11. Link check, docs commands executed as tests. 12. Install from the packed artifact following the public docs verbatim.
13. After explicit approval, in order and each separately confirmed: create GitHub repo → push → CI green →
    npm publish (prerelease tag first) → GitHub release → install from public sources on a clean environment → publish site if hosting is approved.
14. Public install reproduces the clean-room result; staged release labels honest (private alpha → public beta → 1.0 only when criteria are met).
15. Phase 11 gates green; your approval for each external step. 16. Public repo-ready tree, site, release notes.
17. npm deprecate/unpublish window, release retraction, repo visibility revert, documented beforehand. 18. Acceptance matrix complete.

Slices: S1 docs set · S2 screenshots + demo · S3 landing page · S4 release audit · S5 gated launch steps.

---

## Final acceptance matrix (`docs/ACCEPTANCE_MATRIX.md`)

One row per subsystem A–N and per Definition-of-Done item (clean install, onboarding, discovery, update
monitoring, auditing, controlled install, rollback, host integration, routing, forge, workflow execution,
agent orchestration, shared state, themes, documentation, CI/CD, security review, licence review,
distribution artifacts, reproducible release validation). Columns: Status · Evidence · Tests · Known
limitations · Release impact. Updated at the end of every phase; nothing unimplemented is marked VERIFIED.

## Known dependencies on you

- `claude` login in a terminal when a headless host proof is reached (Phases 2 and 6); work continues on other slices meanwhile.
- Approvals listed under "Explicit approval still required".

## Verification summary

`npm test` + `npm run typecheck` after every slice · phase acceptance numbers measured and committed ·
CLI, Web, TUI, MCP exercised by hand each phase from the unchanged folder · clean-room install in Phase 10 ·
release gates in Phase 11 · public-source install in Phase 12.
