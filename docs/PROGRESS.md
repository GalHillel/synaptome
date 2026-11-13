# Progress

Updated 2026-11-12. Statuses: **VERIFIED** (implemented, tested, and observed working end to end) ·
**PARTIAL** · **BLOCKED** (exact blocker given) · **NOT STARTED**.

The product is being completed under [`MASTER_PLAN.md`](MASTER_PLAN.md) (Phases 0–12). This file records
what each phase delivered. Release-level status per subsystem is in
[`ACCEPTANCE_MATRIX.md`](ACCEPTANCE_MATRIX.md); the resume point is [`NEXT_SESSION.md`](NEXT_SESSION.md);
decisions are in [`DECISIONS.md`](DECISIONS.md). The first milestone's own record, written when the product
was called DRELQAVO, is preserved unchanged in
`internal/MILESTONE_1_PROGRESS.md`.

Development data: `.synaptome-dev/` (git-ignored). Run against it with
`node apps/cli/bin/synaptome.mjs --home .synaptome-dev status`.

Test suite: **178 tests in 19 files, all passing** (`npm test`); `npm run typecheck` clean.

## Phases

| Phase | Status | Commits |
|---|---|---|
| 0 Baseline, name clearance, scaffolding | Complete | `0ab9481`, `926955d` |
| 1 In-place rebrand and recoverable data migration | Complete, with the limits listed below | `168b6e7`→amended, `7d16601`, `a012465`, and the documentation commit |
| 2 Context efficiency, routing reliability, host proof | Complete; host proof run 2026-11-12: explicit VERIFIED, unprompted routing VERIFIED, unprompted consumption not observed | `b2c3540`, `8965d27`, `b86fbea`, `374f3c9`, and the documentation commit |
| 3 Canonical registry and autonomous discovery | Complete (24-hour soak not run) | `477d5bc`, `11a116c`, `ac73724`, `250cfad`, `62ebad0`, `8374edc`, and the documentation commit |
| 4 Security, audit, trust and installation lifecycle | IN PROGRESS: S1–S3 done; S4–S5 next | `0312a38`, `bfc19ff`, `500b262` |
| 5–12 | NOT STARTED | — |

## Phase 0 — baseline and name clearance

**Implemented.** Branch `rebrand/synaptome`, tag `drelqavo-0.1.0`; clearance report; master plan, decision
log, acceptance matrix and resume file in the repository.

**Evidence.** 95/95 tests and clean typecheck on the untouched tree; `NAMING_CLEARANCE.md`;
`evidence/phase-0/live-rerun.txt` (live GitHub and MCP-registry scan, audit, 12-check gate, sandbox
auto-install, sandbox rollback, route) run in a disposable home against a sandbox host.

**Re-verification of the milestone-1 report.** Confirmed: test count and typecheck, live discovery from two
sources, audit and gate, sandbox auto-promotion, sandbox rollback. Observed for the first time: the
UserPromptSubmit hook firing in a fresh host session, where it injected 20.5 KB of weakly relevant
capabilities. Confirmed weakness: routing selected a second capability on the single word "audit". Not
repeated: the 1,015-skill local inventory, a real-host install (permission spent), the forge evaluation.

**Limits.** EUIPO, WIPO and the Israeli register could not be queried programmatically. A live US
application for the neighbouring mark SYNAPTOMIX was found; the owner chose to proceed (D-006).

## Phase 1 — rebrand and migration

**Implemented.**
- One identity source, `packages/core/src/identity.ts` (`PRODUCT`, `LEGACY`, `env()`); package scope
  `@synaptome/*`; executable `synaptome`; `SYNAPTOME_*` variables with a deprecated fallback to the old ones;
  `synaptome.db`; token header, MCP server name, bridge skill, install marker, snapshot manifest, user agent,
  interface titles and wordmarks; product documentation.
- Deprecated `drelqavo` launcher that forwards with a notice.
- Refusal to open an un-migrated legacy home, so no second database can be written beside an old one.
- `synaptome migrate` (`packages/core/src/migrate.ts`): copy-based, staged, verified, idempotent, with a
  guarded rollback and a post-migration delta export. Details: `MIGRATION.md`.
- Legacy-aware `bridge remove` and install-marker lookup.
- Provenance and milestone-1 records moved to `docs/internal/` unchanged apart from redacting the local user name.

**Tests.** 15 new tests in `packages/core/test/migrate.test.ts`; the 95 existing tests pass under the new names.

**Real-world verification (2026-11-12, from the unchanged repository folder).**
- Development home migrated: 12,621 rows in 24 tables, 1,258 files, 20 snapshots verified against their
  manifests, 29 legacy files renamed, 74 stored paths updated, integrity ok. Rolled back and migrated again.
  The source tree hashed identically before and after (1,260 files including database and log).
  `evidence/phase-1/migration-report.txt`, `evidence/phase-1/app-on-migrated-home.txt`.
- CLI on the migrated home: `status`, `doctor`, `skills search`, `installs`, `forge list`, `decisions`,
  `gaps`, `route --explain`.
- MCP server: stdio handshake returned server `synaptome` 0.2.0 and the four tools.
- Web Command Center: started on the migrated home; Overview with live data; Library, Discovery, Queue,
  Security, Routing, Forge, Activity and Settings pages opened; wordmark and title read Synaptome.
- Terminal Workbench: started in a real terminal tab on the migrated home; Overview rendered with live data.
- Project bridge removed with the old binary and re-initialised with the new one (`--no-hook`).

**What the running session picked up without a restart (observed, not assumed).** The re-created bridge
skill `synaptome` appeared in the session's skill list immediately. The new project MCP server entry did
not connect at first; later the running session did pick up `synaptome` and dropped `drelqavo` (observed
2026-11-12 after the login). The bridge skill's shell fallback (`synaptome route --json`) works meanwhile. A fresh host
process is needed for the MCP entry; that proof is a Phase 2 item and does not block the rebrand.

**Known limitations.**
- The UserPromptSubmit hook is deliberately **not** installed in this repository until Phase 2 gives it a
  context budget.
- Dashboard pages were opened, not exercised control by control (Phase 2 and Phase 8).
- Two console errors (a connection reset and one 401) appeared in a browser tab that was left open across a
  dashboard restart: the stale page reconnected its event stream with the previous start's token. Expected
  with per-start tokens; the event-stream authentication is redesigned in Phase 2 S1.
- The interim wordmark and favicon are placeholders for the Phase 8 identity.
- A mistake during this phase: the rename changed the ignore rule for the legacy data folder and one local
  commit captured the development data. It was amended immediately, before any other commit, and never
  pushed. Recorded in `internal/PROVENANCE.md` §7 for the publication review.
- `routing decisions` store the full prompt text. To be reviewed in the Phase 2 privacy pass.

**Acceptance against the plan.** `git grep -i drelqavo` in code hits only `identity.ts` (`LEGACY`), the
deprecated launcher and its `bin` entries, and the migration test; in documents only `MIGRATION.md`,
`CHANGELOG.md`, the README's migration pointer, the planning and decision records, and `docs/internal/`.
Row counts and snapshot hashes identical; second run a no-op; rollback verified on real data; 110 tests green.

## Phase 2 — context efficiency, routing reliability, host proof

**Implemented.**
- **Event stream authentication (S1).** `/api/events/stream` takes the per-start token in the `x-synaptome-token`
  header on a fetch stream; a `token` in any URL is refused on every route; requests a browser labels as not
  same-origin never reach `/api/*`; constant-time comparison. Loopback bind, Host and Origin allow-lists and CSP
  unchanged. Cookie option rejected (D-010).
- **Routing benchmark (S2).** `packages/router/src/benchmark/`: 74 fixture capabilities, 167 labelled tasks in nine
  categories (simple, engineering, design, research, multi-domain, planning, no-capability,
  trivial/administrative/meta, must-not-activate), a fixed quarter held out. `synaptome bench routing` runs it in a
  throw-away home; `--registry` also runs the 58 must-select-nothing prompts against your own registry, read-only.
- **lexical-graph-v2 (S3–S5)**, now the default (D-011): intent gate; anchors from a capability's name, tags and
  declared trigger phrases (two words of one phrase); refusal of capabilities built for a language, vendor or
  framework the task does not name; `requires:`/`never:` conditions and exclusion sentences; confidence floor 0.55;
  a further capability only for a different part of the work, never for the task's topic; outcome history lowers
  the confidence of capabilities that repeatedly failed; long prompts reduced to their 24 most salient terms.
- **Compact host context (S3).** Hook and MCP `route_task` send summaries and a load instruction only, at most 800
  tokens per prompt and 300 per capability, nothing when nothing qualifies (D-012). Offering is not activating:
  only an explicit load is recorded. Each decision stores routing time, candidates, tokens sent and hook time.
- Prompt hook re-enabled in this repository (project-local settings only) now that it meets its budget (D-008).

**Measured (`docs/evidence/phase-2/`).**

| | v1 (milestone 1) | v2 |
|---|---|---|
| Fixture precision / recall | 75.0% / 78.8% | 95.8% / 82.8% |
| Fixture held-out precision / recall | 74.2% / 71.0% | 96.2% / 80.7% |
| Fixture false activation (must select nothing) | 31.0% (18/58) | 0% |
| Forbidden selections (keyword traps) | 15 | 0 |
| **Real registry (1,034 capabilities): must-select-nothing prompts that selected something** | **19/58** | **2/58** |
| Host context per prompt | up to 20.5 KB (~5,100 tokens) | max 291 tokens on the real registry, mean 125 |
| Routing time in-process, real registry | — | p50 65 ms, p95 95 ms |
| Hook wall time per prompt (new process) | — | ~600–700 ms, of which routing 12–100 ms |

The milestone-1 failure case, "Write a 3P status update for the leadership team about the billing migration", now
offers `internal-comms` (confidence 0.91, matched on 3p and leadership from its own trigger phrases) and refuses
`customer-billing-ops` because billing is only the topic.

**Decisions taken on evidence, against the fixture.** A rule letting one rare name word justify a selection lifted
fixture recall to 91.8% but added three real-registry false activations for one extra selection; removed. A relative
confidence floor fixed the billing case but dropped legitimate parts of multi-part tasks; replaced by the topic rule.

**BLOCKED.** Fresh-session host proof (explicit and unprompted routing through a new `claude -p` process):
`Failed to authenticate: OAuth session expired and could not be refreshed` (2026-11-12). A bridge with the hook is
initialised in `.tmp/route-proof`; after logging in, the proof is one command (`NEXT_SESSION.md`).

**Known limitations.**
- The fixture benchmark and the router share an author; real-registry precision is not measured (no labels).
- Two real-registry false activations remain (PID tuning matched `continuous-agent-loop`; a contract translation
  matched `visa-doc-translate`), both on two or more matching words.
- Capabilities indexed before this phase have trigger statements searchable only where the description repeats
  them; re-indexing existing rows is Phase 3 S1.
- Hook start-up cost is the TypeScript loader; the Phase 10 build removes it.
- Routing decisions store the full prompt text (privacy review, Phase 11).
- Process note: two scripted edits silently corrupted regular expressions (an escaped `\b` became a backspace
  character). Caught by tests and a scan for control characters; regex code is now edited directly.

## Phase 3 — canonical registry and autonomous discovery

**Implemented.**
- **Registry (S1).** Schema v2: `capability_transitions`, `dependencies`, `source_checks`, `notifications`, source
  backoff/budget/terms columns; trigger statements indexed for existing rows. The capability lifecycle is an
  enforced state machine with reasons and actors; no other code writes the status (D-013, guarded by a test).
  Schema v3: indexes for filters, sorting and installation lookups, and a two-step listing query.
- **Source management (S2).** Health and scan outcomes recorded with latency and request counts; exponential
  backoff (5 min doubling, 24 h cap); daily scan and request budgets and an items-per-scan cap; terms checked before
  any request; one notification per failing spell; `source show|enable|disable|budget`, `notifications` (D-014).
- **Sources (S3).** `official-skills` (seven vendor repositories), `curated-lists` (links from four configurable
  awesome-lists), `npm` (MCP-server packages, metadata only). GitLab and PyPI registered as blocked by their
  robots.txt (D-015). Nine sources, six of which are queried.
- **Scheduler (S4).** `synaptome scheduler status|run [--once]`, foreground, cadence per job from settings, due times
  from recorded history, every scan gated; update notifications for approved or installed capabilities; the OS plan
  is a single hourly `scheduler run --once` task, registered only with the owner's confirmation (D-016).
- **Gaps and duplicates (S5).** A scheduler job searches recurring routing gaps (hit at least twice) on GitHub and npm,
  each at most once a week. The same repository unit reached through several sources is linked to the first.

**Measured (`docs/evidence/phase-3/`).**

| Criterion (master plan) | Target | Result |
|---|---|---|
| Registry query p95 at 10,000 capabilities | ≤ 50 ms | search 15–29 ms; filter+sort 22.5 ms (was 96); deep page 2.7 ms (was 950); overview 32 ms (was 146) |
| Routing p95 at 10,000 capabilities | — | 25 ms |
| Live sources healthy | ≥ 5 | 6 queried sources healthy in live scans (github, mcp-registry, local-claude, official-skills, curated-lists, npm) |
| Seeded duplicates detected | ≥ 95% | 100% (80 of 80 later sightings across three sources), test in `scheduler.test.ts` |
| No source exceeds its budget | 0 overruns | enforced before every scan; tests cover scan, request and item budgets |
| Incremental scans fetch only changes | — | GitHub queries `pushed:>last`, MCP registry `updated_since`, npm walks a cursor; not separately measured |

**Known limitations.**
- The 24-hour foreground scheduler soak was not run; behaviour over time is covered with a fake clock only.
- Licence and publisher changes surface when an update is re-acquired and re-audited, not as separate notifications.
- Sources, notifications and schedule are not yet shown in the Web Command Center or TUI (service API calls exist).
- The official-skills list is fixed in code; several of those repositories have no detected licence, so their units
  are held at acquisition.
- Request counts depend on what each connector reports; the local inventory reports none.

## Phase 4 — security, audit, trust and installation lifecycle (in progress)

**S1 (done).** Malicious corpus (26) and benign corpus (15) in `packages/security/test/corpus.ts`, thresholds enforced
by `corpus.test.ts`. Blocked 10/26 → 26/26; false positives 2/12 → 0/15. Same rules run read-only over the 536 skills
installed on the development machine: 13 with a critical finding, identical to the previous rules (a first draft
wrongly added 3; fixed and kept as benign cases). D-017, `docs/evidence/phase-4/`.

**S2 (done).** SPDX expressions and licence-file variants; dependency records from npm, Python and MCP manifests
(advisories not checked); notifications when an update changes licence, permissions or executables; finding for
skills that declare fewer tools than they use. D-018.

**S3 (done).** Policy rules as data that can only tighten the gate (`synaptome policy show|test|set-rules`), the rule
that decided is recorded; isolation probe (Windows Sandbox, Docker, Podman: none on this machine) and an
"executable content tested in isolation" check that stays BLOCKED without isolation. D-020.

**S4 (done).** Install matrix, 17 cases including two races between separate OS processes
(`docs/evidence/phase-4/s4-install-matrix.md`). It found and fixed 7 defects: no cross-process serialisation, a
rollback ordering bug, edited files silently discarded by rollback/uninstall, partial writes left behind by a failed
install, untracked owned directories replaced without a backup, a rollback with a missing backup restoring nothing,
and no downgrade. Schema v4 (installed-tree fingerprint, one live installation per host directory). New:
`synaptome downgrade <id> --to <hash>`, `rollback|uninstall --force`. D-021.

**S5 (done).** Install targets became shapes behind one set of operations (D-022): Claude Code now installs agents,
commands and project MCP entries as well as skills, each through the same lifecycle; 20 more matrix cases
(`adapter-kinds.test.ts`). A headless Claude Code in a throwaway project loaded what Synaptome wrote: it listed the
agent, ran the command and read the MCP entry as project configuration pending approval
(`docs/evidence/phase-4/s5-adapters.md`). OpenCode's skill folder confirmed against its documentation; stays
staged-only because it also reads `~/.claude/skills`. Publisher change between versions now detected (GitHub owner
compared on every update check) and holds the next version for a person. `docs/SECURITY_MODEL.md`.

**Phase 4 closed (2026-11-12, tag `phase-4-done`).** Acceptance: malicious corpus 26/26 blocked; benign false
positives 0/15; every matrix case byte-identical after rollback or failure (38 cases across skills, agents, commands,
MCP entries); concurrent installs from separate processes never corrupt records. Open and carried forward: dynamic
tests of executable content are BLOCKED (no isolation provider on this machine), dependency advisories not checked,
no signature verification.

**Phase 2 host proof (2026-11-12, after login).** `docs/evidence/phase-2/s6-host-proof.txt`. Explicit invocation in a
fresh headless session verified end to end (decision #53, activation #17, outcome recorded). Unprompted: the hook ran
and offered `internal-comms` within budget in fresh sessions (decisions #49, #50), but the model did not load it in
either run, although the tools and the offer reached it. Findings to fix: host-internal prompts ("Below is a
conversation log…") received offers; words describing the Synaptome tools themselves attracted weak extras.

## Phase 5 — workflow engine (complete, 2026-11-12, tag `phase-5-done`)

New `packages/workflow` (D-023, schema v5): validated JSON definitions; runs and step outputs in SQLite; parallel
execution by dependency; retries with backoff; timeouts; cancellation; resume after the executing process is killed
(tested by SIGKILL of a separate process); approvals for sensitive permissions; permission grants per run; runners for
API calls, models, approvals, joins and allow-listed programs (off by default). Two shipped workflows:
`capability.acquire` (search → audit → approval only if the gate asks → sandbox install → read back → report) and
`capability.forge-gap` (draft → model authoring if available → forge checks → report). Interfaces: CLI `workflow …`,
service API, Web Workflows screen with run inspector, TUI Workflows view. Three real runs on the development registry,
one approval rejected through the API after starting in the CLI (`docs/evidence/phase-5/workflow-engine.md`).

Findings carried forward: the GitHub need search ranked an unrelated skill first for "writing changelog release notes"
(discovery ranking, Phase 7/8); model-authored forge drafts lack activation eval sets (Phase 7); a stale dashboard page
retries the event stream indefinitely (Phase 8). 249 tests in 24 files.

## Phase 6 — model providers and multi-agent orchestration (complete, 2026-11-12, tag `phase-6-done`)

`packages/providers` (D-024, schema v6): headless Claude Code, Anthropic API, OpenAI-compatible (OpenAI, Ollama and
other local servers), Gemini; credentials only from the environment, never stored or echoed; VERIFIED only by a
recorded live call (here: headless Claude Code; the others UNVERIFIED for lack of keys or a local server); privacy-aware
selection. `packages/agents` (schema v7): five specialists as workflow steps, hand-offs, blackboard, budgets in
tokens/USD/time, per-call trace, edits only in git repositories, tests behind approval. Real 5-agent run on a small
task: first attempt failed at the test step (unquoted tool-scope argument, fixed), second succeeded; the produced code
passes 49/49 tests when run independently (`docs/evidence/phase-6/providers-and-agents.md`). Also fixed: automated
notifications no longer attract capability offers. 268 tests in 26 files.

## Phase 7 — Skill Forge maturity (complete, 2026-11-13, tag `phase-7-done`)

Eval sets with train/held-out split and authorship (schema v8, D-025); the run that wrote a skill cannot write its
held-out cases; promotion on held-out lift with n; overfit and regression gates; versions, deprecation and rollback;
`synaptome evalset …`, `forge heldout|deprecate|rollback`. Two real gaps forged end to end (32 and 33 cases, 12 and 13
held-out behaviour cases from a separate author); both rejected on held-out evidence (no lift; gap B also over-broad
activation), while gap B's training cases alone showed +33 points. Real runs found and fixed: Synaptome routing its own
internal prompts, and text-only model calls running with tools in the repository folder (now text-only by default).
`docs/evidence/phase-7/forge-maturity.md`.

## Phase 8 — Web Command Center and identity (complete with limits, 2026-11-13, tag `phase-8-done`)

`packages/ui-tokens` is the single palette for Web and TUI, with a WCAG AA contrast test for both themes (D-026). New
screens: Get started, Sources, Notifications, Integrations, Agents, Evaluation Lab, capability graph (canvas,
clustered by domain, level of detail, viewport culling, keyboard path, table alternative); 17 screens in all. The event
stream backs off and asks for a reload after a stale-token 401. Measured: 0 console messages across all 17 screens;
0 axe violations on 20 rendered screens and inspectors; 0 px sideways overflow at 375 px on every screen; graph draws
1,015 nodes in 2–3 ms; all 62 API commands refuse a missing token, a foreign origin and a foreign Host. The junction
mark is saved in `branding/`. Not done: browser flow tests (need the owner's approval to download Playwright browsers),
a 10k-node draw measurement, splitting the older `views.tsx`. `docs/evidence/phase-8/command-center.md`. 305 tests in
30 files.

## Phase 9 — Terminal Workbench (complete with limits, 2026-11-13, tag `phase-9-done`)

The workbench is split into a screen module, text helpers, theme and one module per view, and follows the shared event
log through `watchEvents` instead of a 1 s poll (D-027). Seven views were added (Sources, Notifications, Integrations,
Agents, Evaluation Lab, Get started, Network): 17 in all, every one drawn at 80, 120 and 200 columns in tests. Network
shows the capability graph as a domain tree with per-capability links and jumps. Help explains each view; `t` saves the
shared theme setting; mouse is opt-in. `scripts/tui-matrix.ps1` ran it in real Windows Terminal, PowerShell and cmd
windows at three widths: every run drew exactly to the width it got, quit cleanly, closed its window and left no
process. The built bundle paints in 225-337 ms and shows data within 1 s; the development launcher takes 1.4-2.2 s
(TypeScript compiled at run time). Fixed: a selection jump across views, a crash found only in real terminals, full
diagnostics running on every event. Not done: mouse clicks in a real Windows Terminal.
`docs/evidence/phase-9/terminal-workbench.md`. 323 tests in 31 files.

## Phase 10 — Distribution, installer, onboarding (complete with limits, 2026-11-13, tag `phase-10-done`)

`npm run build` makes one dependency-free package (launcher with a Node 24 check, one bundled module, prebuilt Web
assets, licence inventory); the built CLI starts in about 0.3 s (target 0.5 s). New commands: `init`, `repair [--fix]`,
`upgrade <spec>` / `upgrade --rollback`, `uninstall --everything` (D-028). Both interfaces open on Get started the
first time. `docs/INSTALL.md` and `docs/QUICKSTART.md`. The clean-room script ran the fifteen quick-start steps from
the package file in a disposable profile without GitHub credentials: 18/18 checks pass, nothing left behind. Found and
fixed on the way: rate-limited scans reported as completed, a temp folder left by every provider listing, a database
handle left open by a refused open, keys arriving faster than redraws losing view switches. Not done: a run in a
separate Windows account (needs approval; Windows 11 Home has no Sandbox), macOS/Linux, publishing.
`docs/evidence/phase-10/build.md`.

## Phase 11 — Release hardening (complete with open items, 2026-11-13, tag `phase-11-done`)

`npm run ci` (same script as the prepared GitHub workflow) passes: typecheck, 357 tests, build with licence check, built
CLI start, `npm audit` 0. Threat model (17 threats), security review, licence inventory (39 bundled packages: 38 MIT,
1 ISC), `LICENSE`/`NOTICE`. Fixed: a high-severity issue in the bundled validation library (zod 3 → 4), the test
runner's critical advisories (vitest 3 → 5), settings values reaching `cmd.exe`, two local-API defects found by
fuzzing, a temp-folder leak, and quadratic registry writes (schema 9: 50k fill 17 min → 110 s). Performance published
at 1k/10k/50k (`docs/PERFORMANCE.md`). Open: the owner's path in git history and four screenshots (owner decision),
browser flow tests (Playwright approval), a separate-account clean room. `docs/evidence/phase-11/hardening.md`.

## Phase 12 — Public product and launch (S1–S4 complete, S5 waits for the owner, 2026-11-13)

S1: public README, security policy, contributing, code of conduct, issue and pull-request templates, 0.2.0 release notes;
a test checks that every command and option shown in the public docs exists. S2: screenshots of the Web Command Center
and the Terminal Workbench from a neutral demo home (no personal path on screen). S3: landing page in `site/`, built
from the product tokens, checked at desktop and phone width in both themes. S4: release audit
(`docs/RELEASE_AUDIT.md`): what the tree and the full history would make public, four options, a recommendation (a
fresh public history from a reviewed tree, full history kept private) and the decisions it needs. Found on the way:
Get started counted existing skills as indexed when the inventory had never run (fixed). Not done, by design: every S5
step (repository, push, npm, release, site) needs the owner's approval, after the history decision.

History decision (owner, 2026-11-13): option C, a fresh public history (D-030). `scripts/public-tree.ts` builds the
public tree from a commit through a temporary index: 217 files; `docs/internal/` and `docs/evidence/` (49 files)
left out; a public provenance note and an evidence note placed from `packaging/public/`; one link into the private
record made plain text; checks for broken links, secret-like strings, identifiers of the machine or the Git author and
stray binaries all pass (and they do catch the owner's path and the old tool index in an early commit). Run inside an
exported copy with no `.git` and no private files, `npm ci` and `npm run ci` exposed two tests that start the CLI
many times in a row and overran the 20 s default under a full parallel run (about 22 s; each CLI run is 0.9 s alone);
those files now set a 90 s limit, and the full CI passes in a fresh export. The owner chose their current Git identity
as the public author; `public/main` holds the one parentless public commit (no ancestry shared with the private
branches, no object from the private record reachable). The owner then confirmed the name (D-031); the repository `GalHillel/synaptome` was created private and empty, with a local remote that can push only `public/main`. The owner approved the push: `public/main` went to `main` (one commit, 217 files, the only private-path files the two public notes). First GitHub CI run: Windows (required) passed; Ubuntu and macOS (reported) failed in the build and upgrade tests, which looked for npm's script only beside `node.exe`. One lookup (`npmCliScript`, also used by `synaptome upgrade`, which before fell back to npm through the shell there) now checks both layouts; the public tree builder gained `--append` so later public commits are fast-forwards. Second GitHub CI run: green on Windows, Ubuntu and macOS. The owner then approved making it public: the repository is public, with private vulnerability reporting on; an anonymous clone has exactly the 2 reviewed commits. npm: the package was built from a credential-free clone of the public repository at `31f384e` and scanned (no personal data, paths, internal docs or secret-like strings); the first publish was refused for two-factor authentication, and the owner published it with their own code. The registry's integrity equals the scanned build. `scripts/clean-room.ps1` gained `-Spec` to install from the registry; in a disposable profile with an empty npm cache all 18 checks pass. Open: GitHub release, site.
