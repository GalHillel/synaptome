# Synaptome Next Generation — revised master plan, 0.2.0 → 1.0 (revision 2)

(Replaces revision 1. The 0.2.0 launch plan that used to be in this file is complete.)

## Context

Synaptome 0.2.0 is public. In real use it showed four things: discovery looks healthy while most sources have never
been scanned; Claude Code received a routed offer and loaded nothing; other tools' hooks broke or blocked the same
session; and three data-safety defects exist in the project bridge. The goal of this plan is a product that finds
useful capabilities on its own (including new *sources*), adopts the safe ones under a standing policy without asking
each time, makes them reach Claude Code without being mentioned, shows what really happened, keeps itself current,
and proves its effect with evidence. Order of work, as required: (1) reliability and data safety, (2) automatic
integration and observability, (3) productive broad discovery, (4) autonomous policy and bootstrap, (5) learning and
operations, (6) hardening and 1.0.

Unchanged constraints: the repository stays in its existing folder (D-003); private history stays private and
only `public/main` is pushed; statuses are VERIFIED / PARTIAL / BLOCKED / NOT STARTED with evidence. Explicit approval
is required for: personal or global host configuration, OS services or scheduled tasks, remote hosting, pushes, npm
releases and dist-tags, public releases, external account permissions. Coding, tests, docs and local commits continue
across milestones without stopping.

---

## 0. Five binding amendments (owner, final review)

1. **Automatic Claude Code integration is a core promise.** It is built, measured and gated like any other core
   feature. Loading, application and task improvement are measured against a no-Synaptome baseline. A result below
   target may ship in a beta with the number stated; 1.0 may call it "stable automatic capability usage" only if the
   targets in §8 are met on independent tasks. Where the host cannot guarantee a behaviour, the best supported
   fallback is implemented and that guarantee is listed as unsupported.
2. **Continuous discovery arrives early.** A usable foreground continuous mode with real health reporting,
   checkpoints and recovery ships with source recovery (M4), not at the service milestone. OS registration still
   needs approval.
3. **Stricter trust boundaries.** Six separate permissions: metadata indexing, static-skill approval, native skill
   materialisation, executable staging, live MCP installation, invocation. Instruction-only skills are untrusted
   model-facing content. Nothing is approved automatically except inside standing permissions the owner has
   explicitly configured, with provenance, rollback and audit log. An isolation environment is trusted for hostile
   code only after it passes a verification suite; its presence proves nothing.
4. **Independent validation and real benefit are mandatory.** The 24-task experiment only selects the strategy.
   Stability is judged on independent, previously unseen tasks, repeated sessions and objective outcomes, compared
   with the same tasks without Synaptome. Self-written tests and a model's own claims are never sufficient.
5. **Safe continuous execution.** Code, tests, migrations, UI, docs and local commits proceed through all milestones
   without pausing at boundaries. Migrations and rollbacks preserve data; an old database is never restored over
   newer records without explicit approval. Development and production installations stay separate. Never, without
   being asked: change personal Claude settings, disable third-party security hooks, install OS services, use paid
   external services, push, or publish. Real-model benchmark runs are proposed with exact scope and budget before
   any charge; Playwright browser binaries are requested when first needed. The real REST API experiment is a
   permanent regression case.

## 1. Findings from this revision's investigation (code read and live requests, 2026-11-13)

**Q1. Why three "healthy" sources show 0 and "never".** `synaptome scan` with no `-s` scans only `github` and
`mcp-registry` (`apps/cli/src/commands/discovery.ts:157`, `opts.source ?? ['github','mcp-registry']`). Official skill
repositories, curated lists and npm are scanned only by `scan -s <id>` or by the scheduler, which is not running.
"healthy" is the result of a reachability probe, shown in the same column as if it meant "working". They are
**unscanned, not broken**. Defect: misleading state.

**Q2. Why GitHub and the MCP Registry show 15.** The default is `discovery.maxPerQuery: 15`
(`packages/core/src/db.ts:608`) and a scan makes **one page request** (`packages/connectors/src/mcp-registry.ts:62–74`:
`limit=min(100, 15)`, one `get`, cursor saved for "the next broad scan"). Live proof: the registry returns 100 per
page with a `nextCursor` at `limit=100`; the same call with the product's default returns 15. Pagination exists but
only advances one small page per manual scan, and there is no "full sync" job. It is a design limit, not a parser
bug.

**Blocked sources re-examined.** PyPI `robots.txt` disallows `/pypi/*/json` and `/search*` but not `/rss/`; the feeds
`rss/packages.xml` (new projects) and `rss/updates.xml` (100 items) return 200 with ETags and are the method PyPI
documents for this. GitLab `robots.txt` disallows `/api/v*` for crawlers; the Projects API is a documented client API
with token authentication. skills.sh disallows `/api` and search in robots, and its API needs a Vercel OIDC token;
its sitemap is allowed.

**Collective Brain, verified live:** `https://collectivebrain.de/skills.json` → 200, JSON array of 95 entries with
`slug, title, category, source, sourceLink, author, version, lastUpdated, triggers[], installCommand, skillMd, …`,
with ETag and Last-Modified; `/en/skills/feed.xml` → 200 RSS; `llms.txt` states CC BY-SA 4.0; robots allows.

**The real integration test (Claude Code 2.1.323, "Create a small TypeScript REST API…").** Routed in 93 ms, 254
tokens offered, two selected, activations none. Causes found in code:
- `javascript-testing-patterns` was excluded by the "specific technology" rule in `packages/router/src/v2.ts:71–84,261`:
  `typescript` and `javascript` are separate tags (aliases only `ts/tsx` and `js/node/nodejs`), so a JavaScript
  capability is rejected for a TypeScript task, and `vitest`/`jest` do not imply either.
- `api-sdk-generator` (client SDK generation) matched a *server* API task lexically on "api"; `clean-code` matched as
  a generic. Selection is lexical; there is no check that the capability's *purpose* fits the task's *deliverable*.
- Consumption requires Claude to call an MCP tool it has no habit of calling. Whether the MCP server was connected in
  that project is not recorded anywhere (no session data), which is itself a defect: it must be provable.
- The same session showed third-party problems (a SessionStart hook with a Node module error, a write gate blocking
  Bash/Write, a Ruflo session-end failure, a command that saved global settings). They come from user-level
  integrations, apply to every project, and are invisible to Synaptome today.

**Claude Code facts used below** (official docs): project skills are watched live and their descriptions are always
in context; `PreToolUse` on `Skill` and on `mcp__synaptome__.*` observes real loads; hooks carry `session_id`; async
and http hooks exist; one `statusLine` command, no documented composition; tool definitions are deferred by default;
`claude -p --output-format stream-json --include-hook-events` exposes tool calls; `--setting-sources` selects which
settings load (used to isolate tests); Claude.ai cannot reach a local server. `SessionStart` output `reloadSkills`
is named in the request but was not found in the pages read: it is **UNCONFIRMED** and will be tested on the
installed version in M2 before anything depends on it. Claude keeps the final decision to load a skill.

**Confirmed code defects** (file:line in the audit, kept in `docs/` at M0): bridge B1–B7 (whole-file `.mcp.json`
deletion at `apps/cli/src/commands/routing.ts:97`, recursive skill-folder removal `:104`, non-transactional init and
remove, `repair --fix` re-laundering ownership, projects invisible without events); hook H1–H4 (lost outcomes,
unchecked activation, no session identity, exits non-zero on a locked database); workflow W1–W7 (cancel does not stop
the `claude` process tree, overlapping retries, late results recorded, non-idempotent resume); dev and npm copies
share `%LOCALAPPDATA%\synaptome` when run without `--home`.

---

## 2. Target architecture

```
Claude Code session ─hooks─▶ synaptome-hook  (tiny bundled entry; read-only; always exits 0)
   │                           ├ SessionStart / UserPromptSubmit (sync, budgeted)
   │                           └ everything else (async) → spool/<session>.jsonl
   ├ Skill tool ─▶ .claude/skills/syn-*/   (materialised, owned, fingerprinted, capped)
   ├ MCP stdio ──▶ synaptome mcp
   └ statusLine ─▶ synaptome-status (reads one small state file)

synaptome service  (opt-in; one per home; lock + heartbeat; durable job queue)
   ├ collector      spool → sessions, host_events, offers
   ├ discovery      Loop A: capabilities from sources   ·   Loop B: new sources from references
   ├ policy engine  staged decisions → standing-policy auto-approval → decision ledger
   ├ maintenance    re-audit, updates, backups, pruning, self-update check
   └ loopback API + event stream  → Web Command Center, Terminal Workbench
SQLite (WAL) remains the single state.
```

New packages: `ownership` (ledger of every file or entry written outside the home), `host-events` (sessions, events,
status), `host-doctor` (read-only map of hooks, MCP, skills, plugins, status line by scope), `source-graph` (sources,
references, identities), `connector-dsl` (declarative connectors), `policy` (trust levels, standing permissions,
ledger; extends `packages/acquisition/src/policy.ts`), `project-intel`, `bootstrap`, `service`. Reused: `watchEvents`
and SSE, `routeTask`/`renderHostContext`, adapters' `writeMcpEntry` and its byte-exact ledger pattern, scheduler jobs,
`notify`, the 15-check gate, `scripts/clean-room.ps1`, `scripts/public-tree.ts`, `upgrade` with rollback.

**Design choices worth stating**
- *Connectors as data.* Four built-in fetch strategies (JSON API with cursor, RSS/Atom, sitemap, GitHub file or
  manifest) plus a mapping written in a small declarative language: field paths, pagination rule, rate, role. A
  connector for a newly found source is a JSON document validated against a schema; it can only make GET requests to
  its own registered host, cannot read files or credentials, and cannot run code. "Generated connectors" are
  generated *documents*, reviewed by policy, never generated programs.
- *Staged decisions, not one boolean.* Fifteen recorded facts per capability version (below, §5); "approved" becomes a
  derived view for compatibility.
- *Native skills as the delivery path.* The body of a selected capability is placed where Claude Code already looks,
  so loading needs no special tool; the hook and MCP tool remain as fallback.
- *Evidence classes.* Every event and signal carries OBSERVED / INFERRED / UNKNOWN and an evidence class (test
  result, user verdict, host event, model claim). Ranking may learn only from the first three.
- *Capability lockfile.* `synaptome.lock.json` in the project: ids, publishers, pinned versions or commits, hashes,
  permissions, host compatibility, dependencies, alternatives considered, policy rule that authorised each, state.
  No credentials. `bootstrap --from-lock` reproduces it on another machine.

**Schema additions** (one additive migration per milestone, pre-migration backup as today): `ownership`;
`sessions`, `host_events`, `offers`; `host_findings`; source columns (`role`, `trust_tier`, `access_status`,
`connectivity_status`, `poll_interval`, `first_complete_at`, `last_complete_at`, `last_attempt_at`, `next_due_at`,
`update_rate`) and `source_stats` (per scan: pages, found, new, deduplicated, audited, approved, rejected, installed),
`source_candidates`, `source_refs` (edges source→source, source→publisher, source→capability), `publishers`,
`capability_aliases`, candidate `published_at`/`first_seen_at`/`upstream_status`; `stage_results` (the fifteen stages
per capability version), `policies`, `standing_grants`, `decision_ledger`; `service_state`, `jobs`, `job_runs`;
`project_profiles`, `bundles`, `bundle_items`; `signals`, `feedback`, `comparisons`; `versions_seen`
(component, version, path). Retention: `host_events` window (default 30 days) and disk budget, pruned by the service.

---

## 3. Source Recovery Matrix (the current nine)

| Source | Real state today | Cause | Recovery | Target |
|---|---|---|---|---|
| GitHub | 15 items | one small page per manual scan (`maxPerQuery` 15) | full-sync job: paginate every search to exhaustion within the rate budget; add manifest/code search (`.claude-plugin/marketplace.json`, `SKILL.md`) and topic searches; incremental by `pushed:>cursor` (exists) | thousands, bounded by budget; complete-sync timestamp shown |
| Official MCP Registry | 15 items | same; `/v0`, one page | move to `/v0.1`; walk all cursors (100 per page); incremental `updated_since`; `version=latest`; group versions under one server; record `status` (active, deprecated, deleted) and `publishedAt`/`updatedAt`; weekly reconciliation walk | whole registry; versions not counted as servers |
| Local Claude Code inventory | 1,015 of 1,017 | works; 2 unexplained | report the two skipped items and why | exact count with reasons |
| Official skill repositories | never scanned | not in the default scan; no scheduler | included in default and scheduled scans; replaced by the marketplace-manifest connector (Anthropic's three repositories) | productive |
| Curated lists | never scanned | same | included; lists become *reference sources* feeding Loop B (links only where there is no licence) | productive |
| npm | never scanned | same | included; paginate `keywords:mcp-server` and related keywords; record `trustedPublisher`, downloads | productive |
| skills.sh | blocked | robots disallows `/api`, search; API needs Vercel identity | sitemap (allowed) → `owner/repo` links → metadata from GitHub; API stays blocked with that reason | productive via link-follow, labelled as such |
| GitLab | blocked | robots disallows `/api/v*` for crawlers | stays off by default; enabled only when the owner supplies a personal token and accepts a recorded decision that Synaptome acts as an API client under GitLab's API terms, at a conservative rate (decision G-6) | off, or productive with token |
| PyPI | blocked | whole source blocked because JSON/search are disallowed | unblock **RSS only** (`rss/packages.xml`, `rss/updates.xml`, per-project release feeds; ETag); filter by name and summary; resolve to the repository link and read metadata there; the JSON endpoints stay unused | productive via feeds |

**Source status model** (replaces the single "health" word everywhere): connectivity; access/compliance; last health
check; last attempt; last *complete* scan; pages or feed entries processed; found / new / deduplicated / audited /
approved / rejected / installed; cursor; rate remaining; observed update rate; measured freshness; next due; last
meaningful error; whether a full and an incremental sync ever completed. A never-scanned source displays **"never
scanned"**, not "healthy". A scan that returns nothing is classified (empty upstream, parse yielded nothing from a
non-empty response, rate limited, authentication missing, pagination stalled) and a parse-empty result is a failure.
Self-repair: on "healthy but zero" the service runs the classifier, retries with the fallback strategy if one is
declared, and raises one notification with the diagnosis.

## 4. New Source Expansion Matrix

| Candidate | Role | Mechanism (permitted) | Trust tier | Notes |
|---|---|---|---|---|
| anthropics/claude-plugins-official (verified 200, 191 KB manifest) | publisher marketplace | GitHub raw manifest | official | 168+ plugins, pinned sha |
| anthropics/skills, anthropics/claude-code marketplaces | publisher | manifest | official | |
| Any `marketplace.json` found by code search | marketplace | manifest connector | unknown until promoted | origin of most third-party catalogs |
| docker/mcp-registry | curated publisher | GitHub tree of `server.yaml` | curated | 327 entries |
| Collective Brain | aggregator | `skills.json` + RSS, ETag | aggregator (metadata) | CC BY-SA attribution; each entry resolved to `sourceLink` |
| ruvnet/ruflo marketplace | ecosystem | manifest | third-party | 49 plugins as individual pinned candidates |
| PyPI feeds | package index | RSS | package signal | |
| crates.io | package index | API at 1 req/s, identified client | package signal | |
| GitHub topics (`mcp-server`, `claude-skills`, `agent-skills`, `claude-code-plugin`…) | code host | search API | unknown | |
| GitHub releases of tracked repositories | update feed | Atom `releases.atom` | inherits | cheap update detection |
| awesome-mcp-servers (MIT) | list | README links | reference only | |
| awesome-claude-code, awesome-claude-skills (no licence) | list | links only | reference only | no text copied |
| mcp.so, claudemarketplaces.com | aggregator | sitemap → repository links | reference only | |
| Smithery | marketplace | API with the owner's key | third-party | optional (G-6) |
| Glama | aggregator | API with key + attribution | enrichment | optional (G-6) |
| PulseMCP sub-registry | registry | partner keys | — | blocked until keys exist |
| Vendor organisations' official repositories (Vercel, Supabase, Cloudflare, HashiCorp, AWS Labs, Azure, Google, Microsoft Playwright, Stripe, Sentry, GitHub, Docker…) found through registry `repository` fields and marketplace owners | original publisher | GitHub | verified publisher after identity check | discovered by Loop B, not hand-listed |
| Codeberg / Gitea-compatible public forges | code host | documented API where robots permits | unknown | evaluated, added only if productive |
| mcpservers.org (403), cursor.directory (429), claude-plugins.dev (402) | — | refused | blocked | reason recorded, re-checked monthly |

Targets: evaluate ≥ 25 candidates, reach ≥ 15 independently productive permitted sources. A source counts as
productive only with real relevant items and two successive successful incremental syncs. If fewer qualify, the
report says which failed and why.

**Loop B — how new sources are found without being hardcoded.** Every scan records outbound references (repository,
homepage, manifest `source`, publisher, "listed on" links) in `source_refs`. A reference whose host or repository is
not a known source becomes a `source_candidate`. The classifier fetches only `robots.txt`, the landing document and
well-known descriptors (`llms.txt`, feed links, sitemap, `.claude-plugin/marketplace.json`, registry-API shape) and
decides: publisher, registry, marketplace, aggregator, list, feed, tutorial, mirror, unrelated. It scores relevance,
permitted interface, authentication, structured-data quality, freshness, coverage novelty (how many entries are not
already known), duplication, publisher identity, abuse potential, cost. If a built-in strategy fits, a connector
document is drafted and dry-run (read-only, capped requests). **Promotion:** metadata-only sources of an allow-listed
shape (a `marketplace.json` in a repository of a verified publisher; a registry implementing the official registry
API; a feed on an already-approved host) are admitted automatically under the standing source policy; everything else
waits in quarantine for a decision. A source never changes its own tier; tiers only affect *metadata trust*, never
execution. Sources can be paused, retired, rechecked, and their connector documents are versioned with rollback.
**Acceptance test (first-class):** a fixture catalog that Synaptome already scans gains a link to a marketplace
repository that appears nowhere in Synaptome's code or settings; the test passes only when that repository becomes a
source through Loop B and its capabilities arrive, with the full trail shown.

Identity resolution: canonical id = original publisher + repository + path + manifest name; catalog listings attach
as aliases with their own `first_seen`. One capability listed in three catalogs is one capability with three
references.

---

## 5. Autonomous approval and promotion

**Stages recorded per capability version** (`stage_results`, each with evidence and time): 1 discovered · 2 source
validated · 3 publisher verified · 4 metadata indexed · 5 content quarantined · 6 static audit passed · 7 dependency
review passed · 8 host compatible · 9 functional evaluation passed · 10 safe to recommend · 11 auto-approved for a
scope · 12 staged in sandbox · 13 authorised for live project install · 14 authorised for invocation · 15 authorised
for automatic upgrade. Stages 1–10 are facts; 11–15 are permissions granted by a policy rule or a person.

**Six separate permissions** (never implied by one another): (a) index metadata · (b) approve a static skill for
recommendation and routing · (c) materialise it as a native skill in a named project (this is the step that puts
third-party text in front of the model) · (d) stage an executable in isolation · (e) install an MCP server live in a
named project · (f) allow invocation. Each is granted separately, per scope.

**Autonomous Approval Policy Matrix.** Nothing beyond metadata and quarantine is automatic until the owner has
explicitly configured a standing grant: a preset is a *template*, and choosing one shows every rule and requires
confirmation of publishers, projects, risk classes, daily budgets and expiry. Every automatic action writes the
decision ledger: what, why it qualified, which rule, evidence, exact changes, undo command.

| Action | No grant configured (default) | Conservative | Balanced | Advanced autonomous |
|---|---|---|---|---|
| (a) discover, index, classify, update metadata from permitted sources | auto | auto | auto | auto |
| Download content to quarantine and audit it statically | auto | auto | auto | auto |
| Admit a new metadata-only source of an allow-listed shape | ask | ask | auto | auto |
| (b) approve an instruction-only skill (no scripts or executables, no `allowed-tools`, no hooks frontmatter, no MCP reference, no instruction to fetch or run remote content, injection scan clean, licence allowed, audit tier A, publisher on the owner's approved list) for recommendation and routing | ask | ask | auto | auto |
| (c) materialise such a skill into a project named in the grant | ask | ask | auto, only for publishers on the approved list | auto |
| (d) stage an executable in a **verified** isolation provider and test it | not available on this machine today | same | same | auto where a provider has passed verification |
| (e) install into a named project an MCP server that meets all of: publisher on the approved list, pinned version with hash, no credentials, no install scripts, declared read-only, passed (d) | ask | ask | ask | auto |
| (f) invocation of an installed MCP server's tools | governed by Claude Code's own permission prompts; Synaptome never pre-approves tools | same | same | same |
| Automatic upgrade of something already auto-approved, when publisher, licence, permissions and dependency set are unchanged and the audit passes again | ask | ask | auto for (b)/(c) | auto for (b)/(c)/(e) |
| Anything with credentials, shell, broad filesystem, external accounts, remote OAuth, global or user-level configuration, persistence, unpinned execution, or an unlisted publisher | ask, always | ask, always | ask, always | ask, always |
| Suspend or quarantine on a worse audit, publisher change, licence change, deprecation or deletion upstream | auto | auto | auto | auto |

**Skills are untrusted model-facing text.** Before (b): the existing injection, hidden-character and exfiltration
rules, plus checks for instructions that widen permissions, tell the model to ignore the user, change settings,
install things, or contact hosts. At (c): the frontmatter is rewritten by Synaptome (name, description and `paths`
only; `allowed-tools`, `hooks`, `model`, `context` and similar keys are stripped, so a skill cannot grant itself
tools); a fixed header states the origin and that the user's instructions take precedence; the body is byte-identical
to the audited snapshot and re-hashed on every routing use; any change upstream returns it to quarantine and removes
the materialised copy.

**Isolation must be proven.** An isolation provider (Windows Sandbox, a container runtime, a VM) is trusted for
hostile code only after a verification suite passes *on that machine*: a probe program inside must fail to read a
canary file in the user profile, to see host environment variables and credentials, to reach the network when the
policy says none, to write outside its scratch area, to see or signal host processes, and to survive the time limit.
Results are recorded with the provider version and re-run when it changes. Docker Desktop being installed is not
evidence; containers that share the host kernel are recorded as a weaker class and are not accepted for (d) unless
the owner explicitly accepts that class in the grant.

Notes that bound the matrix honestly: on this machine (d) is unavailable, so under every preset an MCP server that
has not been isolation-tested still asks; a static audit and popularity never substitute for that. A new version that
differs materially (permissions, dependencies, publisher, licence, executables added) drops back to stage 5. A
rejected or blocked capability cannot be promoted by feedback or scores; only a person can lift a block. Standing
grants state scope (which projects), publishers, risk classes, budgets (items per day, disk, network) and expiry, and
are listed and revocable in CLI, Web and TUI (`synaptome policy grants`, `policy revoke`).

---

## 6. Milestones

Each ends with typecheck, all tests, the black-box suite, evidence in `docs/evidence/ng-<n>/`, local commits and the
status documents. Tag `ng-<n>-start`; rollback = revert to the last green commit and restore the pre-migration
database backup. Independent slices may run in parallel when they touch different packages.

### Priority 1 — reliability and data safety

**M0 Baseline and independent harness.** Dev launcher defaults to `.synaptome-dev` (the two copies never share a
home; `status` prints which copy and home are active). `tests/blackbox/` uses only the built package, CLI, HTTP API
and disk, written from the specification. `tests/host/` runs real `claude -p` sessions in disposable projects with a
spend cap, in two profiles: **clean** (`--setting-sources project,local`, an isolated plugin and skill set, so user
integrations cannot pollute results) and **realistic** (the user's settings as they are, read-only, to test
coexistence). Failing reproductions for every confirmed defect, including the two discovery misreports and the
TypeScript routing case. Baselines: hook latency, load rate on 24 tasks, context added.
*Done when:* every defect has a failing black-box test and baseline numbers are recorded.

**M1 Safety fixes → 0.2.1.**
- *Bridge / ownership:* per-entry ledger with hashes; remove only what still matches; changed skill kept and
  reported; whole file removed only if byte-identical to what was written; ledger written first, rollback on failed
  init; tolerant removal; `repair` updates in place; legacy markers adopted; `bridge status`. Same path for
  `uninstall --everything`.
- *Hook:* never non-zero, never migrates, short busy timeout, silent on error.
- *Cancellation:* abort signal through `ModelProvider.complete`; process-tree kill (Windows `taskkill /T /F`,
  process group elsewhere); retries wait for the previous attempt; late results discarded; edit steps do not auto-retry
  after a crash; SIGINT handling; budget reserved before parallel calls.
- *Truthful state:* the source status model of §3 in CLI, Web and TUI ("never scanned"); default `scan` covers every
  enabled source; scan result classification; routing records fixed (H1, H2).
- *Host Integration Doctor v1* (`synaptome doctor host [dir]`, read-only): every hook with event, command, scope
  (user, project, local, plugin; managed where readable) and origin file; MCP registrations by scope; skill
  directories and counts; plugins; status-line owner; broken executables and missing modules (each hook command's
  program resolved, not run); duplicates and collisions on the same event; stale Synaptome launcher paths; other
  orchestrators (Ruflo / Claude Flow) and which events they own; permission-gate hooks identified as such. Output: a
  map and findings with the exact file and a suggested, reversible fix. It never edits; applying a fix to user-level
  files is a separate, explicit approval, and unrelated security or permission hooks are never disabled.
*Done when:* the destructive-case matrix leaves every user byte intact; no surviving child process after cancel;
doctor reproduces the three third-party failures seen in the real test as findings (in a fixture that imitates them);
sources never display healthy without a completed scan. **0.2.1 release on approval.**

### Priority 2 — automatic integration and observability

**M2 Invisible integration → 0.3.0.**
- *Fast hook entry* in the bundle; bridge points at the bundle. Budgets: UserPromptSubmit p95 ≤ 150 ms warm, ≤ 400 ms
  cold; observer hooks async, ≤ 60 ms, never blocking.
- *Session events:* SessionStart, UserPromptSubmit, `PreToolUse` on `Skill|mcp__synaptome__.*`, async PostToolUse,
  PostToolUseFailure, PermissionRequest, Notification, SubagentStart/Stop, Stop, SessionEnd → spool → collector.
  Tool *names and kinds* only by default; optional scoped diagnostic capture with redaction and retention. The MCP
  server records its own connection per session, so "was it connected" is answerable.
- *Routing quality:* technology relations become a graph (typescript ⊂ javascript ecosystem; vitest, jest, mocha →
  js testing; fastapi → python; next.js → react → javascript…), built from data and extendable; a deliverable check
  (task asks to build a server ≠ capability that generates client SDKs) using each capability's stated purpose and
  exclusion conditions; generic capabilities (clean-code style) offered only as a second slot; a 150-task labelled
  set from the real registry including the reported task; long planning prompts and host-internal prompts excluded.
- *Consumption experiment, then build.* Arms on 24 tasks (6 need nothing), fresh sessions, clean profile, plus a
  Synaptome-off control: A today's hint + MCP; B small pre-materialised native skill set at connect/SessionStart with
  trigger-style descriptions and `paths`; C task-scoped materialisation on the prompt hook + one-line pointer;
  D top capability's core inline within 1,500 tokens at very high confidence. Also verify on the installed version:
  live skill watching, `/reload-skills`, and whether SessionStart output can request a reload. Measure routed,
  offered, available, loaded (stream-json tool call + hook event), applied, verified outcome, context, latency.
  Ship what the data supports; materialised skills are owned, fingerprinted, capped (default 12), expired when unused.
- *Proof of use:* loaded = OBSERVED hook event. Applied = INFERRED from tool activity after the load within the same
  prompt, or OBSERVED when the capability declares a check that ran. Verified = a test command's exit status or a
  user verdict. The model's statement is never evidence.
- *Status line:* `synaptome-status`, opt-in, project-scoped; wrapper around any existing status line with exact
  restore; e.g. `Synaptome ● Connected │ offered 2 · loaded 1 │ +310 tok`, `○ Idle`, `! Approval waiting`,
  `× Disconnected`.
- *Validation beyond the experiment.* The 24 tasks only choose the strategy. A separate validation set is then
  written before the chosen strategy is tuned and kept sealed: at least 60 previously unseen tasks with objective
  checks (tests that must pass, required behaviours, lint), authored independently of the implementation (task
  authoring by a separate session that never sees the router or the skills; the owner may add tasks), each run in 3
  fresh sessions with and without Synaptome. Reported: load rate, application rate, task success with and without,
  wrong activations, context, time, with confidence intervals. The owner's REST API task and its three findings
  (JavaScript-testing skill excluded for a TypeScript task, a client-SDK skill chosen for a server task, nothing
  loaded) are permanent regression cases in the router tests and the host suite. Each real-model run is proposed
  first with its exact session count and budget.
*Done when (beta, 0.3.0):* latency budgets met; per-arm numbers published; false activation ≤ 5%; zero tokens when
nothing matches; a real load changes the status line and creates one OBSERVED event; the regression cases pass; the
realistic profile works alongside the user's existing hooks or reports precisely which third-party hook failed. The
load rate is published whatever it is; below 60% on capability-relevant tasks the feature is labelled **beta** and
work on it continues (description tuning, materialisation timing, the supported fallbacks) through later milestones.
The 1.0 targets are in §8.

**M3 Live Mission Control (functional first, polish last).** Activity Center, Session Inspector, source status with
all §3 fields, pending approvals, decision ledger, version panel (§9), host findings; then Discovery Radar and
Capability Network v2 (typed edges, comparison). Web and TUI use the same queries; reconnect with `Last-Event-ID`,
bounded history, coalescing. UNKNOWN where unobservable. Playwright flows if the browser download is approved (G-4).
*Done when:* a real session action appears in both within 2 s with provenance; stale and disconnected states are
correct; no control without an action.

### Priority 3 — productive broad discovery

**M4 Source recovery and expansion.** §3 recoveries; connectors as data (`connector-dsl`) with the four strategies;
the first twelve additions of §4; publisher identities; identity resolution and aliases; lifecycle labels (newly
published, newly discovered, updated, trending, established, deprecated, risky); capability-vs-library classifier
(a package is a capability only with a manifest, an MCP entry point, or a `SKILL.md`; otherwise it is a signal).
**Foreground continuous discovery ships here** (`synaptome discover watch`, replacing the bare `scheduler run`
loop): one process that keeps every enabled source in sync on its own schedule, with a single-instance lock,
heartbeat, per-source checkpoints written after every page, resume after a kill, backoff and budgets, a live status
table (the §3 fields, next due, last error) in the terminal and the same data in the Web and TUI, and a clear
"stopped since …" state when it is not running. It runs as long as its terminal is open; nothing is registered with
the operating system.
*Done when:* ≥ 10 productive sources with completed full and incremental syncs; `discover watch` survives a kill
mid-scan and resumes from the checkpoint with no duplicate or lost entries; registry fully walked with versions
grouped and deprecated/deleted reflected; cross-catalog duplicate test passes; Ruflo marketplace ingested as pinned
candidates with a recorded conflict assessment.

**M5 Source discovery engine (Loop B).** `source_refs`, candidates, classifier, dry-run, promotion policy,
quarantine, retirement, versioned connector documents. *Done when:* the "source that was never hardcoded" test
passes end to end; ≥ 25 candidates evaluated and ≥ 15 productive sources, or a written account of each shortfall.

### Priority 4 — autonomous policy and bootstrap

**M6 Policy engine.** Stages, presets, standing grants, decision ledger with human-readable explanations, continuous
re-audit on any change, automatic suspension, grants UI. *Done when:* under Balanced, a newly published eligible
static skill from an approved publisher goes from discovery to approved and routable with no prompt and a complete
ledger entry (acceptance test 3); a tampered new version drops back and is not auto-approved; poisoned feedback cannot
lift a block.

**M7 Bootstrap and lockfile.** `synaptome bootstrap [dir]` (`init --smart` alias), `--dry-run`, `--preset`,
`--update`, `--rollback`, `--from-lock`. Flow: read-only project analysis with evidence per fact → inventory of
existing servers, skills, hooks, plugins, status line, orchestrators (uses the doctor) → registry search per needed
category → targeted fresh discovery for gaps → ranking (verified utility, compatibility, provenance, maintenance,
security, context and process cost) → bundle with one choice per category and conflicts removed → policy auto-approves
what the standing grant covers → **one** approval for the rest (L4 items individually) → pinned installs through
adapters and the ownership ledger → validation (server starts, `tools/list`, skill metadata, permissions) → lockfile
→ routing integration → result and exact rollback. Lazy by default: Claude Code's deferred tool loading, `paths` on
skills, small always-on baseline; optional Docker MCP Gateway recipe where Docker exists. **Ruflo / Claude Flow:**
detected; Synaptome never runs `ruflo init`; if Ruflo owns UserPromptSubmit or the status line, bootstrap offers
coexistence (Synaptome observer hooks only, no second router, status segment via wrapper) or a scoped import of
selected Ruflo plugins; never two routers or two hook managers. Ongoing: the service watches each locked project for
a better version, deprecation, publisher change, redundancy, or a stack change, and updates within the grant or
recommends with evidence.
*Done when:* 13 fixture projects (Next.js, Node, Python, Terraform, monorepo, empty, existing MCP, conflicts, existing
Ruflo, interrupted, edited after install, repeat, rollback) pass; rollback is byte-exact; always-loaded context added
≤ 1,500 tokens for `standard`; `--from-lock` reproduces the environment in a second disposable profile.

### Priority 5 — learning and operations

**M8 Operations service** (builds on the foreground mode delivered in M4; adds the collector, maintenance jobs and
optional OS persistence). One instance per home (lock file with PID and start time; stale-lock recovery);
heartbeat; durable job queue with checkpoints; adaptive schedules from observed update rates; global and per-source
network budgets; bounded workers; pause/resume; offline catch-up; graceful shutdown; retention and disk limits; audit,
update and backup jobs; `service run|status|logs|pause|resume`; `service install|uninstall` (Task Scheduler entry at
logon with restart-on-failure, registered only on approval, removal touches only that entry). Freshness SLO per
source: detect within 24 h of upstream visibility while running; measured delay distribution published; UI shows
"stopped since …" and catches up after start. *Done when:* a sustained run (24 h) shows no missed job, a killed
service resumes from its checkpoint, a second instance refuses to start, and delays are reported. Without approval to
install, the result is PARTIAL (foreground).

**M9 Update Center.** `versions_seen` and a version panel: public repository revision, npm `latest`/`next`, installed
package, development checkout, running service, each project's bridge launcher path and version, the connected
session's version, schema version. `synaptome update check|stage|apply|rollback|history`; channels stable/beta;
integrity checked against the registry's published hash (and npm provenance when the package has it); compatibility
check of schema and bridges; backup; service quiesced; transactional install (existing `upgrade`); migration
verified; stale launchers detected and repaired through the ownership ledger; policy: notify (default), stage, or
auto-apply compatible patch releases; major versions, migrations that cannot be reversed, host changes or permission
increases always ask; a rollback never discards newer data (existing rule). The development checkout is never a
target of self-update. *Done when:* 0.2.0 → next release upgrades on copies of real databases, a deliberately failed
upgrade rolls back cleanly, and a session started before the upgrade is shown as running the old version until
restarted.

**M10 Learning, comparison, Forge.** `signals` only from OBSERVED events and verified outcomes; exposure-aware
(a capability that was never offered is not penalised; a small exploration share avoids lock-in); bounded
adjustments, each explainable; security and policy always outrank learned scores. Comparison records for overlapping
capabilities (tasks, evaluations, loads, verified outcomes, security, context, maintenance) and supersede
suggestions. Gap loop: recurring gap → approved → newly discovered → upstream search → comparison → genuine gap →
Forge candidate → unchanged baseline → held-out tasks from an independent author → promotion only on improvement and
audit. Benchmark "with vs without Synaptome": 40 representative tasks with objective checks (tests, lint, a rubric
scored by a different model family where available), reporting success, wrong activations, context, time, including
negative results. *Done when:* the benchmark is published; replay shows precision up without more false activations;
manufactured signals are provably excluded.

**M11 Workflows, agents, multi-host.** Idempotency keys, approval persistence across restarts, provider failure
classes; more providers verified when keys are supplied. Claude Desktop: `.mcpb` bundle and guided config (user-level,
so on approval). Claude.ai: design document for an opt-in remote connector (routing and capability text only, OAuth,
isolation, TLS); nothing deployable without approval. *Done when:* kill-and-resume has no duplicate side effect;
Desktop is observed calling a tool or is marked unsupported.

### Priority 6 — hardening and 1.0

**M12 Security, privacy, scale.** Adversarial suite (malicious skills and MCP metadata, tool-description poisoning,
install-command injection, permission widening on update, source self-promotion, connector-document abuse, feedback
poisoning, lockfile tampering, uninstall safety); threat model additions; privacy review of stored events; indexes and
measurements at 1k/10k/50k with CI thresholds (search p95 ≤ 50 ms at 10k is missed today at 58.6 ms).

**M13 Release 1.0.** Twelve acceptance tests (§8) from the published package; clean Windows profile; other platforms
only if declared supported and tested; docs; site. Each external step approved.

---

## 7. Day-0-to-Stable journey

| When | What you can use | Restart or reconnect needed |
|---|---|---|
| Today (0.2.0) | Commands below; routing offers; dashboard; TUI | none |
| 0.2.1 (M1) | Safe connect/disconnect, truthful source status, `scan` covers all sources, `doctor host`, cancel that stops processes | `npm install -g synaptome@…`; run `synaptome repair` once per connected project to adopt the ownership ledger; restart running Claude Code sessions |
| 0.3.0 (M2–M3) | Automatic skill availability, status line, live activity and session inspector | upgrade; `synaptome bridge update <project>` (adds hooks; Claude Code picks up hook changes live, a restart is the safe path); status line is opt-in |
| 0.4 (M4–M5) | Thousands of indexed capabilities, new sources found automatically, Discovery Radar | upgrade only |
| 0.5 (M6–M7) | Standing policy presets, automatic approval of eligible skills, `synaptome bootstrap`, lockfile | choose a preset once; new sessions in bootstrapped projects |
| 0.6 (M8–M9) | Always-on service (if you approve the OS task), update center | approval for the task; service restarts itself on upgrade |
| 0.7–0.9 (M10–M12) | Learned ranking, comparisons, forge from gaps, benchmark report, hardening | upgrade only |
| 1.0 (M13) | Stable, independently accepted | — |

**Day-0 commands (PowerShell, npm install; data in `%LOCALAPPDATA%\synaptome`).**

| Purpose | Command | Changes |
|---|---|---|
| Version | `synaptome --version` | nothing |
| Diagnostics incl. database integrity (run first) | `synaptome doctor` | nothing |
| Backup | `Copy-Item "$env:LOCALAPPDATA\synaptome" "$env:LOCALAPPDATA\synaptome-backup-$(Get-Date -f yyyyMMdd)" -Recurse` | a copy |
| Web / terminal | `synaptome dashboard` · `synaptome` | nothing until you act |
| Registry | `synaptome status` · `synaptome skills list` · `synaptome skills search "testing"` | nothing |
| **Scan the three never-scanned sources now** | `synaptome scan -s official-skills curated-lists npm` | registry; network |
| **Get more than 15 per scan** | `synaptome scan -n 100` (repeat: each run continues from the stored cursor) | registry; network |
| Keep scanning while a terminal is open | `synaptome scheduler run` | registry; network |
| Queue and evaluate | `synaptome candidates --queue` · `synaptome evaluate --next 5` | registry (quarantine + audit; installs nothing) |
| Approve / reject | `synaptome approve <id>` · `synaptome reject <id>` | registry |
| Routing | `synaptome route "…" --explain` · `synaptome decisions` · `synaptome activations` | records a decision |
| Is a project connected | `Get-Content <project>\.synaptome-bridge.json` · `synaptome bridge verify <project>` | nothing |
| This repository (development copy) | `node apps/cli/bin/synaptome.mjs --home .synaptome-dev decisions` | nothing |
| Throwaway project | `synaptome bridge init $env:TEMP\syn-demo` … `synaptome bridge remove $env:TEMP\syn-demo` | that folder |

Until 0.2.1: do not run `bridge remove`, `repair --fix` or `uninstall --everything` on a project where you added MCP
servers after connecting; do not run `bridge init` in this repository. Nothing here merges the two data folders.

---

## 8. Conditions for 1.0

**Release blockers (all must hold):** no known data-loss path (ownership matrix green); no execution or permission
outside the policy (adversarial suite green); rollback works for bridge, bootstrap, upgrade, and no migration or
rollback overwrites newer user records; **automatic integration, measured on the sealed independent task set with
repeated sessions:** capabilities are loaded in ≥ 60% of capability-relevant sessions, wrong activations ≤ 5%, and
task success with Synaptome is higher than without by a margin whose confidence interval excludes zero, with no
increase in failures on tasks that need no capability. If these are not met, 1.0 is not declared with that claim:
either the release stays a beta, or 1.0 ships with automatic usage explicitly labelled beta and listed under
unsupported guarantees, by the owner's decision at that point; no silent discovery failure (status model and
scan classification verified); no misleading state (every UI field traced to an event or shown UNKNOWN); service and
agents bounded (budgets, single instance, cancel); versions consistent and visible; install and uninstall on a clean
Windows profile; no open high or critical finding.

**Scope-dependent (shipped only if verified, otherwise labelled unsupported):** Claude Desktop, Claude.ai remote,
extra providers, key-gated catalogs, isolation providers and therefore automatic MCP installation, automatic
self-update, Advanced autonomous preset, macOS and Linux as supported platforms.

**Acceptance tests, each with reproducible evidence:** 1 new project bootstrap and rollback · 2 automatic capability
use in a fresh session · 3 new capability discovered and auto-approved under policy · 4 new source discovered
without being hardcoded · 5 new MCP server detected, inspected, staged where isolation exists, activated only under
an authorised policy, handshake and rollback verified · 6 coexistence with Ruflo, other hooks, an existing status
line and several MCP servers · 7 sustained service run with recovery · 8 self-update and failed-upgrade rollback ·
9 malicious skill and MCP candidates gain nothing · 10 with-versus-without benchmark including negative results ·
11 live Mission Control correlation with provenance · 12 clean public install on each declared platform.

## 9. Answers to the sixteen questions (where each is solved)

1 unscanned by default, not broken (§1) → M1. 2 default 15 and one page per scan (§1) → M1 default, M4 full sync.
3 Loop B from recorded references (§4) → M5. 4 only documented APIs, feeds, sitemaps and link-following; robots and
terms checked per source; blocked sources stay blocked with reasons (§3, §4). 5 staged decisions + presets + ledger +
re-audit (§5) → M6. 6 the policy matrix (§5): instruction-only skills from approved or verified publishers
automatically under Balanced; MCP servers automatically only under Advanced and only after isolation testing, which
this machine cannot do today. 7 evidence-based project analysis, per-category ranking, one bundle, lockfile → M7.
8 detection by the doctor, never running `ruflo init`, coexistence or scoped import, one router → M1, M7. 9 native
skill materialisation chosen by a four-arm experiment, better selection → M2. 10 observed loads, inferred or checked
application, verified outcomes, with-vs-without benchmark → M2, M10. 11 fail-open Synaptome hook; doctor maps and
explains third-party failures and offers reversible fixes on approval; clean test profile isolates them → M0, M1.
12 single-instance service with heartbeat, durable jobs, restart policy, OS task on approval → M8. 13 learning only
from observed and verified evidence, exposure-aware, bounded, security outranks → M10. 14 one event model with
provenance for Web, TUI and status line → M2, M3. 15 update center targeting only the npm install; separate homes and
a version panel → M0, M9. 16 §8.

## 10. Decisions for the owner (defaults apply until answered)

G-1 Releases: each push, npm publish and release asked when reached (0.2.1 first).
G-2 OS task for the service: asked at M8; default foreground only.
G-3 Model spend for real-session tests: no standing budget. Before each benchmark run the exact scope (tasks,
    sessions, model, per-session cap, total cap) is proposed and run only on approval; disposable projects only. No
    other paid external service is used.
G-4 Playwright browser download: requested when the first browser test is ready to run; until then that row is PARTIAL.
G-5 Remote connector for Claude.ai: design only.
G-6 Keys and client access: GitHub code search uses the existing login; GitLab, Smithery, Glama only with keys the
    owner supplies and, for GitLab, the recorded decision described in §3. Default off.
G-7 Standing permissions: none until the owner configures a grant (publishers, projects, risk classes, budgets,
    expiry). Balanced is the suggested template once M6 passes its tests.
G-9 Migrations: always additive with a pre-migration backup; a failed migration is fixed forward or the *unchanged*
    backup is restored only when no newer records exist; otherwise the owner is asked.
G-8 Status line and any fix to user-level hooks in the personal environment: only when asked, each separately.

## 11. Execution order after approval

M0 → M1 (0.2.1 ready) → M2 → M3 (0.3.0 ready) → M4 → M5 → M6 → M7 → M8 → M9 → M10 → M11 → M12 → M13. M3's
visual polish, M11 and parts of M12 run alongside later milestones when they do not touch the same packages. Work
does not pause between milestones; it pauses only for the approvals in §10 and for release steps. Every open issue
and limit stays listed in `docs/ACCEPTANCE_MATRIX.md` and `docs/NEXT_SESSION.md`.

## Verification summary

`npm run ci` per slice · `tests/blackbox` against the built package · `tests/host` real sessions in clean and
realistic profiles at M0, M2, M7, M13 · disposable homes and projects for everything that writes outside Synaptome's
data · live source checks recorded with request counts · evidence in `docs/evidence/ng-*` (private), summaries in the
public status documents.
