# Decision log

Append-only. Newest last. Earlier architectural decisions are in `ARCHITECTURE.md` ("Decisions").

## D-001 — Product name is Synaptome, not Synapse OS (2026-11-11, owner)
**Context.** "Synapse OS" collides with an active same-category npm package and many repositories and marks.
**Decision.** Use Synaptome; executable `synaptome`. **Evidence.** `docs/NAMING_CLEARANCE.md`.
**Status.** Accepted, with one open risk (D-006).

## D-002 — Licence Apache-2.0 for eligible original code (2026-11-11, owner)
Third-party licence audit must complete before release (Phase 11). No licence is assigned to material the
project does not own.

## D-003 — The repository directory is not renamed (2026-11-12, owner)
The project stays at its existing path so the working session is never interrupted. The folder name is a
legacy filesystem path; no product behaviour or text may depend on it. All other identifiers are rebranded.

## D-004 — One master plan, continuous execution, fixed approval gates (2026-11-12, owner)
`docs/MASTER_PLAN.md` (Phases 0–12) is approved in full. Phases run in sequence without stopping at
boundaries. Approval is still required for: installs into personal AI hosts, global Claude Code
configuration, persistent scheduled tasks or services, domain purchases, npm publish, creating or changing
remotes, pushing, visibility changes, public releases, history rewriting or exclusion.

## D-005 — Plan corrections adopted (2026-11-12, owner)
1. Migration never writes to the source database: SQLite online backup API, no checkpoint or vacuum on the
   source; rollback refuses when post-migration data exists.
2. Planning tasks are not excluded from routing as a category; only trivial, administrative, irrelevant and
   purely meta prompts are.
3. The SSE query-string token is replaced in Phase 2, before the service grows.
4. The Node.js permission model is not a security boundary; dynamic testing of untrusted code needs strong
   isolation or is blocked.
5. The exact Git tree and history are reviewed before any push; no history rewriting without approval.

## D-006 — Open: neighbouring mark SYNAPTOMIX (2026-11-12)
A live USPTO application (serial 99306765, class 42, software and AI services) exists for SYNAPTOMIX.
Recorded as a possible material conflict under the plan's Phase 0 rule; the owner decides whether to
proceed with Synaptome before Phase 1 commits the rebrand. Outcome to be appended here.

**Outcome (owner, 2026-11-12): proceed as Synaptome.** SYNAPTOMIX is an accepted, unresolved risk for legal
review at the release gate.

## D-007 — Legacy data is migrated by copy and never opened in place (2026-11-12)
Synaptome refuses to open a home that still contains the old database name. `synaptome migrate` copies to a
new home. A quiescent source is copied as bytes with no SQLite connection, because a read-only connection to
a WAL-mode database still creates sidecar files beside it (found by the tests). A source with live WAL
content is copied with the online backup API. Rollback refuses when data was created after the migration.

## D-008 — The prompt hook stays uninstalled in this repository until Phase 2 (2026-11-12)
The bridge was re-initialised with `--no-hook`. The hook is re-enabled only when its injection is within
the context budget and passes the false-activation benchmark.

## D-009 — Architecture document lives in docs/ (2026-11-12)
`ARCHITECTURE.md` moved to `docs/ARCHITECTURE.md` so the continuity documents sit together. Provenance and
milestone-1 records live in `docs/internal/` and are excluded from the published package.

## D-010 — Event stream authenticates with the header token on a fetch stream, not a cookie (2026-11-12)
The plan allowed either an HttpOnly cookie or a header-carrying fetch stream. The cookie is the weaker
option on localhost: cookies are scoped by host, not port, so any other local web application shares them,
and a cookie is an ambient credential. A custom header cannot be sent cross-site without a CORS preflight
that this server never grants. One credential, one transport, for commands and events. A `token` parameter
in any URL is now refused outright.

## D-011 — Default router is lexical-graph-v2; one matching word never justifies a selection (2026-11-12)
**Context.** The prompt hook injected 20.5 KB of weakly relevant capabilities into a planning prompt (decision #40),
and v1 selected capabilities for 31% of prompts that should select nothing.
**Decision.** `lexical-graph-v2` (`packages/router/src/v2.ts`) is the default; v1 stays selectable through
`routing.strategy`. It gates on intent (trivial, administrative, meta and lookup prompts select nothing; planning
is *not* excluded), requires the task to name what a capability is about, refuses capabilities built for a
language, vendor or framework the task does not mention, honours `requires:`/`never:` conditions and exclusion
sentences, applies a confidence floor, and adds a second capability only if it covers a different part of the task.
An empty selection is a valid result.
**Evidence.** Fixture benchmark (167 tasks, a fixed quarter held out): precision 75.0% → 95.8%, false activation
31.0% → 0%, forbidden selections 15 → 0. On the real 1,034-capability development registry, prompts that must
select nothing: 19/58 → 2/58.
**Trade-off taken.** A rule letting a single rare word from a capability's name justify a selection raised fixture
recall from 82.8% to 91.8% but raised real-registry false activations from 2/58 to 5/58 for one extra selection.
The fixture gain came from capability names written to match the tasks, so the rule was removed and the test's
recall floor set at 80%.
**Limits.** The fixture and the router share an author. Real-registry *precision* is not measured: there are no
labels for which of the 1,034 real capabilities is right for a task.

## D-012 — Hosts get summaries, not capability bodies (2026-11-12)
The hook and `route_task` send name, one-sentence summary, the words that matched and how to load the capability,
capped at 800 tokens per prompt and 300 per capability, and nothing at all when nothing qualifies. The full text is
loaded on demand through `get_capability` or `synaptome activate`, and only that load is recorded as an activation.
What each decision sent is stored with the decision (`metrics.injectedTokens`, `offered`, `hookMs`).

## D-013 — Capability status is an enforced state machine (2026-11-12)
Six places wrote `capabilities.status` directly, each with its own idea of what was allowed. All status changes now
go through `transitionCapability` (`packages/core/src/lifecycle.ts`): allowed transitions only, a reason is
required, the actor is recorded in `capability_transitions`, one event per change, atomic with the update.
Rejected, blocked and deprecated capabilities can only return to `registered`, so they pass the audit and the gate
again before approval. A test fails if any other file writes the status column.

## D-014 — Sources are gated before any request: terms, backoff, budgets (2026-11-12)
A scan checks, in order: enabled; declared terms (a source whose terms or robots.txt disallow automated access is
never contacted, not even for a health check, and `--force` does not override it); failure backoff (5 minutes,
doubling per consecutive failure, capped at 24 hours; `--force` overrides only this); daily scan and request budgets.
Every health check and scan is recorded in `source_checks` with latency and the request count the connector reports
(GitHub counts conditional requests answered from its ETag cache, since they are still requests). Three consecutive
failures raise one notification per failing spell, not one per scan.

## D-015 — New discovery sources, and two registered as blocked (2026-11-12)
Added: `official-skills` (seven vendor repositories whose owners are on the official-publisher list),
`curated-lists` (repositories linked from configurable awesome-lists; only the links are read), and `npm`
(packages that declare themselves MCP servers; metadata only, no tarball). The two list sources reuse the GitHub
connector for expansion, fetching and update checks. GitLab and PyPI answer API requests, but their robots.txt files
disallow those paths for all user agents (`/api/v*`; `/pypi/*/json` and `/search*`), so both are registered as
blocked with that basis and never contacted. Several official repositories have no detected licence; their units
are held at acquisition until a licence is established, as for any other source.

## D-016 — One visible scheduler; the operating system only wakes it (2026-11-12)
`synaptome scheduler run` is a foreground loop; `--once` runs one pass. Due times are computed from the recorded scan
history and job events (no separate scheduler state), per cadence in `discovery.schedule` (hourly, daily, weekly,
off). Every scan goes through the gated `scan()`. The optional OS task, shown by `synaptome schedule` and registered
only with `--install --yes` (owner approval, D-004), is a single hourly `scheduler run --once`, replacing the two
fixed scan tasks that ignored cadence and gates. Updates found for approved or installed capabilities raise one
"action" notification each; nothing is applied automatically.

## D-017 — Audit rules are judged on two corpora and on real installed skills (2026-11-12)
A malicious corpus (26 packages: overrides, concealment, hidden Unicode, download-and-exec in shell/PowerShell/
Python/Node, reverse shells, credential and `.env` exfiltration, hook abuse, MCP tool-description poisoning,
self-granted permissions, markdown-image exfiltration, packed code, jailbreak personas) must be 100% blocked; a
benign corpus of security documentation that quotes attacks must stay at or below 10% blocked. Measured: 10/26 →
26/26 blocked; false positives 2/12 → 0/15. Because the corpus shares an author with the rules, every rule change is
also run over the skills installed on the development machine (read-only): the final rules flag exactly the same 13 of
536 as before. Defensive context now has two strengths: strong words ("attacker", "malicious", "example of an
attack", "detect") may come from the three lines above; weak words ("never", "do not") count only on the same line
and never for rules whose own wording is a negation. Combination rules raise "reads a secret" plus "sends it out" on
one line to critical. Known trade-off: a malicious author can prefix an attack with "Example of an attack"; that only
lowers it from critical to high, which still prevents automatic promotion and is shown to the reviewer.

## D-018 — Licence expressions, recorded dependencies, update-risk notifications (2026-11-12)
Licences may be SPDX expressions: with OR one fully allowed alternative is enough; with AND every part must be
allowed. Licence files with suffixes (`LICENSE-MIT`, `COPYING.LESSER`) count as licence evidence. What a package
declares it needs (npm dependencies, peer dependencies and engines; Python requirements and pyproject; MCP packages and
remotes; front-matter `requires`) is stored in `dependencies` at registration and replaced on each new version;
nothing is resolved and vulnerability advisories are marked "not checked" (no advisory feed is consulted yet). An
update that changes the licence, widens permissions, adds executables or has critical findings raises a notification
before anything moves. A skill whose `allowed-tools` omit the shell its content uses gets a medium finding.
Not done: publisher-change detection between versions (the GitHub API follows repository transfers transparently;
detecting them needs the repository id, recorded from Phase 4 S4 on).

## D-019 — Routing and consumption are verified separately (2026-11-12)
Since the hook offers summaries instead of injecting capability text (D-012), "the hook served a capability" and "the
model used it" are different facts. `bridge verify` reports `verified` only when both happen, `routed-not-loaded` when
the hook offered something the model did not load. The headless proof loads the project MCP config and allows exactly
`get_capability` and `record_outcome`, standing in for the one-time approval a person gives interactively. Measured:
explicit invocation works end to end; unprompted consumption did not happen in 2 runs. Not pursued: re-injecting full
capability text to force consumption, which would undo the context budget.

## D-020 — Policy rules can only tighten the gate; executable content is never auto-promoted without isolated testing (2026-11-12)
`policy.rules` (ordered, first match wins) match on kind, tier, trust, licence, requested permission, publisher,
source, origin or a name pattern, with effect deny, require-approval or allow-auto. An allow-auto rule still needs
every built-in check to pass, so rules can block or demand review but never let a failing package through. A field a
rule does not know never matches, so a typo cannot widen a rule; rules are validated before they are saved. The gate
records which rule decided. A new check, "Executable content tested in isolation", passes only for packages without
executable content. Otherwise it stays unknown: BLOCKED when no Windows Sandbox, Docker or Podman is available (the
case on the development machine), and "not run" when isolation exists, because dynamic testing is not implemented.
The Node.js permission model and child processes are not treated as isolation (D-005 item 4).

## D-021 — Host changes are serialised, fingerprinted and never discard edits silently (2026-11-12)
Every install, rollback and uninstall of a host directory takes a per-directory lock file under `<home>/locks`
(a lock whose process has exited is taken over), and schema v4 allows at most one live installation per host
directory, so concurrent CLI, dashboard, TUI, MCP and scheduler processes cannot both install. Each installation
records a fingerprint of the installed tree. Rollback and uninstall refuse, changing nothing, when the files were
edited after install; `--force` proceeds only after copying the edited files to the backups folder. Whatever an
install replaces is copied first, tracked or not, and a failed install removes anything it wrote and copies that
back. Rollback restores from that copy, or from the stored snapshot of the previous version when the copy is gone,
and otherwise refuses before touching anything. Downgrade installs an earlier version only if Synaptome installed
and verified that exact version before. Rejected: comparing only the payload against the snapshot (would miss
added files and the marker), and holding a database write transaction across the file operations (it would stall
every other writer in the home, including discovery and routing records, for the length of an install).

## D-022 — Install targets are shapes behind one set of operations; MCP entries only into a named project (2026-11-12)
The lifecycle (lock, backup, fingerprint, verify, revert, rollback) is written against `TargetOps` (exists, owner,
fingerprint, backup, restore, discard), which each adapter supplies per target shape: a directory with a marker inside
(skills), one Markdown file with a sidecar record beside it (agents, commands: hosts read only `*.md` there), or one
key in a shared JSON file with a sidecar ledger (MCP servers in `.mcp.json`). For MCP the ledger keeps the file's
earlier bytes, so removal restores the file byte for byte when nobody changed it meanwhile, and otherwise removes only
Synaptome's key and keeps everyone else's changes. MCP entries are written only into a project named by
`hosts.claudeProject` or `--project`; there is no fallback to user-scope `~/.claude.json`, which counts as global host
configuration. Entries prefer a remote https endpoint (nothing runs locally), else a pinned npm/PyPI package; secrets
are `${VARIABLE}` references. Agents are refused when another agent file uses the same front-matter name (the host
would load only one); commands are refused when a skill of the same name would shadow them. A change of upstream
owner holds the next version for a person once (`publisher` gate check). OpenCode stays staged-only: its documented
skill folder is confirmed, but it also reads `~/.claude/skills`, so a second copy would be listed twice. Rejected:
marking files by adding front-matter fields (changes content the host and the user read) and editing MCP entries in
user scope.

## D-023 — Workflows are data, runs live in the database, and sensitive steps wait for a person (2026-11-12)
A workflow definition is validated JSON: typed steps, `needs` forming a DAG, `${inputs.*}` and
`${steps.<id>.output.*}` references (only to steps upstream of the referring step), comparison-only conditions, output
contracts, retries, timeouts and declared permissions. Nothing in a definition is evaluated as code. A run freezes its
definition and inputs into `workflow_runs` (schema v5) and stores each step's output as it finishes; that stored output
is the checkpoint, so a run killed at any point resumes from its last completed step, and steps left running by a dead
process are retried or failed according to `onInterrupt`. One process executes a run at a time (owner pid plus
heartbeat). A run is granted at most the permissions its workflow declares; a step asking for `installation`,
`configuration`, `publishing`, `delete`, `credentials` or `shell` waits for a person's approval (setting
`workflow.approvalRequiredFor`), and API steps must declare what each command needs (a sandbox install is `write`, a
real one `installation`, an unknown action `write`). Shell steps are off until the owner enables them, then only for
allow-listed programs, without a shell and with a minimal environment. Runners are injected, so the engine does not
depend on the service; API steps call the same API the CLI and dashboard use. Rejected: a general expression language
in definitions (an injection surface), and per-step checkpoint blobs separate from outputs (two sources of truth).

## D-024 — Providers are verified by recorded live calls; agents are workflow steps with budgets and traces (2026-11-12)
Model providers (headless Claude Code with the owner's login, Anthropic API, any OpenAI-compatible server including
local ones such as Ollama, Gemini) share one interface. Credentials are read from the environment at call time and are
never stored, logged or returned in errors (scrubbed even when a server echoes them). A provider is VERIFIED only by
the latest recorded successful live call (`provider_checks`, schema v6); otherwise UNVERIFIED or FAILED. Selection
follows the owner's preference order, skips switched-off providers, and under privacy "local-only" never falls back to
a provider that sends text off the machine; it explains every skip. Specialist agents (researcher, architect,
implementer, reviewer, tester) are steps in the workflow engine, so ordering, parallel branches, retries, timeouts,
cancellation, approvals and resume come from one place. Each model call is a trace row (`agent_calls`, schema v7) that
also serves as the budget ledger: tokens, USD (only when prices are configured; an unknown cost never counts as within
a USD budget) and wall time are checked before every call. Agents share a per-run blackboard. Agents that read or edit
files work only through the Claude Code provider with role-scoped tools, and agents that edit work only inside a git
repository so every change is reviewable and reversible; running tests needs the "shell" permission and therefore a
person's approval by default. Rejected: a separate agent runtime beside the workflow engine (two schedulers, two
resume paths), and estimating cost from guessed prices.

## D-025 — A forged skill is promoted only on held-out evidence from an independent author (2026-11-12)
Evaluation cases live in the database (`eval_sets`, `eval_cases`, schema v8) with a split (train or held-out), a kind
(positive and negative activation prompts, graded behaviour cases) and an author. The run that wrote a skill is
recorded (`generatedBy`) and may write only training cases; held-out cases come from a person or from a separate model
run that sees the gap and brief but never the skill text, and an attempt by the generating run to add held-out cases is
refused. Promotion requires at least 5 held-out behaviour cases, at least 70% passing with the skill, and a positive
lift over the baseline on those held-out cases, stated with n. A skill that passes its own training cases much better
than held-out ones (gap above 25 points) is rejected as overfit; a revision that scores more than 5 points below the
promoted version on held-out cases is rejected as a regression. Every promotion is recorded as a version with its
held-out evidence, so a promoted skill can be deprecated or rolled back to the previous version (files, registry and
sandbox install). Synaptome's own model calls carry a flag its prompt hook honours, so internal prompts never become
routing decisions or gaps. Rejected: deciding on all cases together (training cases may have shaped the skill), and
letting the generating model also write the held-out set.

## D-026 — One token source for both interfaces; a canvas graph with a fixed layout; accessibility checked on real data (2026-11-13)
Colours, spacing and type live only in `packages/ui-tokens`; the web console receives them as CSS variables at build
time and the terminal workbench as a palette, and a test holds every text colour to WCAG AA on every background in both
themes, so a palette change that breaks contrast fails the build. The capability graph is drawn on a canvas with a
deterministic clustered layout (one circle per domain, nodes placed by a phyllotaxis spiral) instead of a
force-directed simulation: the same registry always draws the same picture, layout of 10k nodes takes under 500 ms, and
drawing is bounded by what is on screen (level of detail plus viewport culling). Every graph view has a table
alternative. Accessibility is checked by rendering every screen from a real seeded registry through the service API and
running axe-core on the markup in jsdom, plus the token contrast test; injecting a remote script into the live page was
refused by this session's safety rules and is not needed. Browser flow tests (Playwright) wait for the owner's approval
of the browser download (Phase 11). Rejected: a graph library with physics (non-deterministic, slow at 10k, no
keyboard path), per-interface palettes (they drift), and skipping accessibility checks until a browser runner exists.

## D-027 — The terminal workbench follows the shared event log, its mouse is opt-in, and startup is judged on the built bundle (2026-11-13)
The workbench learns about changes from `watchEvents` (core), the same watcher the dashboard's stream uses: same-process
events on the next tick, other processes through SQLite's `data_version` every 250 ms, so an idle workbench costs one
pragma read per check and never shows a rolled-back write. Mouse support is off by default and turned on with
`synaptome tui --mouse` or `ui.mouse`: mouse tracking takes over the terminal's own text selection, Ink has no mouse
support of its own, and real Windows Terminal clicks have not been verified; with it off, mouse reports are still never
typed into a field. Screens that reload on every event use quick diagnostics (no whole-database scan, no `gh` process);
the full run stays on `doctor`, the Web and an explicit action. The ≤ 1.5 s startup target applies to what is shipped:
the esbuild bundle starts in 225-337 ms to first paint in all nine real-terminal runs, while the development launcher,
which compiles TypeScript at run time, takes 1.4-2.2 s. Rejected: a polling loop per view (wasted reads and stale
seconds), mouse on by default (breaks copy in every terminal for a convenience the keyboard already covers), and
lowering the startup target to fit the development launcher.

## D-028 — One dependency-free package; the program and the data have separate lifecycles; nothing is undone silently (2026-11-13)
Synaptome ships as one npm package built by esbuild: a launcher that checks the Node version before loading anything,
one bundled ES module with every workspace package and dependency, and the prebuilt Web assets. No dependencies are
installed with it, no TypeScript or tsx runs at run time, esbuild is not shipped, and the bundle holds no repository or
user path (a build test checks this). The data folder is separate from the program: `init` creates and verifies it,
`repair` reports drift and fixes only what can be fixed without overwriting anything a person changed, `upgrade` keeps
the running version and a database copy and puts both back if the new version does not pass `doctor`, and `uninstall
--everything` undoes what Synaptome created elsewhere (installs rolled back newest first, projects disconnected) and
deletes the data folder only when asked by name. A rollback keeps the current database when the schema is unchanged and
refuses to replace a database that was changed after a schema-changing upgrade unless told to; an older version never
opens a newer database. Both interfaces open on Get started the first time either is opened. Rejected: a native
installer (a second toolchain for a Node program), postinstall scripts (code running at npm install time), shipping
TypeScript with tsx (1.4–2.2 s startup against 0.2–0.3 s), and an uninstall that removes the data folder by default.

## D-029 — Release hardening: fix what was found, upgrade what ships, measure at 50k, keep history decisions for the owner (2026-11-13)
Every finding of the Phase 11 review was fixed rather than accepted where a fix existed: the bundled validation
library (zod 3, high-severity memory exhaustion) was upgraded to zod 4 and the schema adapted; the test runner (vitest
3, critical in tinypool) to vitest 5; values from settings can no longer reach `cmd.exe` with shell syntax; refusals
of the local API drain the request body so clients see the 4xx; full-text rows are keyed by the capability rowid
(schema 9), which made registry writes constant-time instead of growing with the registry (50k: 17 min → about 2 min).
Robustness is tested with seeded fuzzing of every parser of untrusted text and of the HTTP API, and with a
six-process concurrency test. CI is one script (`scripts/ci.mjs`) that the GitHub workflow runs unchanged; Windows is
required, macOS and Linux reported. The owner's user-folder path remains in git history and in four Phase 9
screenshots: removing it from history means rewriting history, which is the owner's decision at the Phase 12
publication review, so it is recorded as open, not worked around. Rejected: accepting the zod advisory as "local
only" (the validation runs on discovered, hostile data), adding a secret scanner download without approval (patterns
applied with a script instead), and publishing performance targets for 50k before measuring.

## D-030 — Publish from a fresh public history built from a reviewed tree; the full history stays private (2026-11-13)
The owner chose option C of `docs/RELEASE_AUDIT.md`. The public repository will start with one parentless commit whose
tree is built by `scripts/public-tree.ts` from a committed revision of this repository, and this repository keeps its
whole history unchanged and private. The tree leaves out `docs/internal/` and `docs/evidence/` (raw evidence that
describes the development machine, the four Phase 9 screenshots, milestone notes and the upstream tracker that names
individuals and records their project's audit result) and takes two public files from `packaging/public/` instead: a
provenance note and a note on where the evidence is. Links into the private record become plain text; every other
relative link must resolve. The script refuses on a secret-like string, an identifier of the machine or of the Git
author (computed at run time, so the identifiers are never written into the tree), or a binary outside the asset
folders; it works in a temporary index and never changes this repository's history, index or working tree. The
public author identity is not assumed: `--commit` requires `--author`. Pushing only `public/main` (no tags) carries
none of the private objects. Rejected: rewriting this repository's history (option D; error-prone, and the plan forbids
altering the local history), and publishing with the record removed only going forward (option B; the history would
still publish it).

## D-031 — Name confirmed; repository created private and empty; only `public/main` can be pushed to it (2026-11-13)
The owner confirmed "Synaptome" after their legal check, which closes D-006 (SYNAPTOMIX) as the owner's accepted
decision. Public lookups on 2026-11-13: the npm name `synaptome` is unregistered (404) and no repository of that name
existed on the owner's GitHub account. The repository `GalHillel/synaptome` was created **private and empty** (no
README, licence or initial commit, so the first push is the reviewed commit itself). The local remote `public` has
the push refspec `refs/heads/public/main:refs/heads/main` and `--no-tags`, so a plain `git push public` can send only
the public commit; a dry run showed exactly that. The package manifest now carries `repository`, `homepage` and
`bugs` from the root `package.json`. Not yet done, each needing its own approval: the push, CI on GitHub, making the
repository public, `npm publish --tag next`, the release and the site.
