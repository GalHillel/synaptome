# Privacy and risk register

## Privacy

**What leaves the machine**

| Destination | When | What is sent |
|---|---|---|
| `api.github.com` | scans, evaluations, update checks | search queries from the strategy list or typed by you; repository paths; your GitHub token as the Authorization header (read from `gh`, never stored) |
| `registry.modelcontextprotocol.io` | scans, update checks | a search term or cursor; no identity |
| Claude Code headless (`claude -p`) | only `forge author` and `forge eval` without `--from` | the forge brief or the evaluation prompts, plus the skill text being evaluated |

Nothing else. No telemetry, no analytics, no remote storage. A routing gap can become a search query
(`--discover`); those terms come from the taxonomy keywords matched in your task, not the task text itself.

**What stays local**

The database, snapshots, quarantine, forge workspaces and settings, all under the home directory. Task text you
route is stored in `route_decisions` (first 300 characters also in `gaps.sample_task`) so decisions can be
reviewed. Conversations are never stored. The local web server binds to 127.0.0.1 only.

**Reading your existing skills.** `synaptome inventory` reads `~/.claude/skills` and installed plugin skill
folders to index and audit them. It writes nothing there.

**Not built:** encryption at rest, a privacy classification on stored records, a command to purge routing history
(delete rows from `route_decisions`, `activations`, `gaps` for now).

## Risk register

| # | Risk | Likelihood | Impact | Mitigation now | Residual |
|---|---|---|---|---|---|
| 1 | Unprompted routing does not happen in real sessions, so the registry adds little | High (observed once for the skill path) | High | MCP path verified when invoked; deterministic hook installed by `bridge init` and tested through the CLI | Hook not yet observed in a live session (`bridge verify` is blocked by the expired login). Top priority. |
| 2 | Lexical routing recommends a poor capability | Medium | Medium | Rarity weighting, weak-signal rules, exclusions shown, outcomes recorded | No learning from outcomes yet |
| 3 | Static audit misses a malicious skill | Medium | High | Tier B always needs approval; real installs need explicit confirmation and budget; snapshots pinned | No sandboxed execution, no dependency data |
| 4 | Static audit blocks legitimate skills | Medium | Low | Findings shown with file and line; cautionary prose lowered a level | Rules need tuning against more samples |
| 5 | Forge evaluation overstates usefulness | High | Medium | Sample size and method recorded with every run; gate still applies | Cases authored with the skill; n = 5 |
| 6 | Licence misjudged | Low | High | Licence from text only; unknown never passes; acceptance recorded with a reason | Pattern-based detection of a fixed set of licences |
| 7 | Third-party proprietary material redistributed without written permission | Low | High | No third-party proprietary code or text in the repository; ingested copies stay in the local quarantine and are never redistributed; see `docs/internal/PROVENANCE.md` | Third-party licence audit of dependencies and bundled content is a release gate (Phase 11) |
| 8 | Name collision or trademark conflict for "Synaptome" | Medium | Medium | Preliminary clearance in `docs/NAMING_CLEARANCE.md`: package registries free, no USPTO record for the name | A live US application for the neighbouring mark SYNAPTOMIX (class 42) is an accepted, unresolved risk; EUIPO, WIPO and the Israeli register are unchecked; legal review is a release gate |
| 9 | Host update changes skill or MCP conventions | Medium | Medium | Adapter per host; status tied to evidence | Only Claude Code exercised |
| 10 | `node:sqlite` is still marked experimental in Node 24 | Low | Medium | Warning suppressed only in the launcher; migrations back up the file | Swap to `better-sqlite3` is isolated to `packages/core/src/db.ts` |
| 11 | Two processes write at once | Low | Low | WAL, busy timeout, short transactions | Long scans hold no transaction |
| 12 | Windows-only validation | Certain | Medium | Paths and process spawning written portably | macOS and Linux untested |
