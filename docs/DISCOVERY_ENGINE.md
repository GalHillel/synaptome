# Discovery engine

Covers architecture, sources and scheduling (the three documents the plan listed are combined here).

## Contract

A source implements `DiscoveryConnector` (`packages/core/src/schema.ts`):

| Method | Purpose |
|---|---|
| `health()` | reachability, authentication state, rate-limit state |
| `search({ mode, query, limit, cursor })` | returns normalized `CandidateDraft`s, a cursor for the next scan, rate state and notes |
| `fetchPackage(candidate)` | returns the files of one unit, what was skipped and why, licence evidence, provenance |
| `checkUpdate(candidate)` | optional; whether the unit changed upstream |

The scan engine (`packages/discovery`) knows only this contract. `discovery.test.ts` proves it by defining a
connector inside the test and scanning with it.

## Scan modes

- **Broad**: walks a source's own strategy. The GitHub connector rotates through a query list three entries per
  scan (cursor `broadIndex`), so the whole list is covered across runs within the 30-searches-per-minute budget.
  The MCP registry connector walks the registry page by page with its stored cursor.
- **Incremental**: only what changed since the last scan (`pushed:>` on GitHub, `updated_since` on the registry).
- **Need-driven**: a query from the user or from a routing gap (`synaptome route … --discover`).
- **Repository**: `synaptome scan --repo owner/name` expands one repository.

## What a candidate is

Not a URL. A row in `candidates` with: source and external id, kind, name, description, location, pinned commit,
per-unit content version (git tree sha), publisher, licence and its evidence, popularity signals, topics, rank with
reasons, recommended next action, duplicate and overlap flags, first and last seen, the scan that found it.

The GitHub connector turns one repository into several candidates by reading its tree:
`**/SKILL.md` (skill), `agents/*.md` (agent), `.claude-plugin/plugin.json` (plugin), `commands/*.md` (prompt),
`workflows/*.{md,yml}` (workflow), `hooks/hooks.json` (hook), root `server.json` (MCP server).

## Ranking

`rankDraft` produces a 0–100 triage order with its reasons stored on the candidate: official publisher, licence on
the allow list, popularity (log-scaled and labelled weak evidence), freshness, description substance, query match,
user category preferences, deny list. It is explicitly not a quality score; quality is assigned only after audit.
Rank ≥ 50 with no duplicate or licence concern queues the candidate for evaluation.

## Duplicates and overlap

- Same repository and path reported by two sources: `duplicate_of`, rank reduced, action `skip-duplicate`.
- Same content hash after download: not registered twice.
- Same text after whitespace/case normalisation, or similar name and description (Jaccard ≥ 0.5): listed under
  `overlap`. Nothing is ever merged automatically.

## Updates

A rescan that sees a different tree sha for an already audited candidate sets `update_available` and stores the
new ref beside the pinned one. The audited data is not overwritten. See `INSTALLATION_POLICIES.md`.

## Sources

| Source | Status | Notes |
|---|---|---|
| GitHub | VERIFIED live | Token read from `gh auth token` or `GITHUB_TOKEN` at call time, never stored. ETag cache under `<home>/cache/github`. Stops at the search floor and keeps partial results. |
| Official MCP registry | VERIFIED live | `registry.modelcontextprotocol.io/v0/servers`. Metadata only: the implementation is not fetched, which every candidate records. Always Tier B. |
| Local Claude Code inventory | VERIFIED live | Read-only. Personal skills and skills of installed plugins. Indexed, never queued for acquisition. |
| skills.sh | BLOCKED by policy | `robots.txt` (read 2026-11-11) disallows `/api/` and `/search`. Registered so the status is visible; no requests are made. Two exploratory requests were made before the policy was read; none since. |
| GitLab, npm, PyPI, Cargo, Docker Hub, vendor marketplaces, curated lists | NOT STARTED | Roadmap. Package registries need a filter that separates agent capabilities from ordinary dependencies. |

## Scheduling

`synaptome schedule` prints the two Windows Task Scheduler entries Synaptome would create (daily incremental scan,
weekly broad scan) and their cron equivalents. `--install --yes` registers them; `--remove --yes` deletes them.
Nothing is registered by default and no background service exists. Scheduled scans call only deterministic APIs;
they use no model tokens. Registration itself has not been exercised.

## Configuration

`synaptome config get discovery` · `config set discovery.disabledSources '["mcp-registry"]'` ·
`discovery.preferredCategories`, `discovery.excludedCategories`, `policy.denyPublishers`,
`policy.officialPublishers`.

## Limits

- GitHub code search is not used yet (10 requests per minute); discovery relies on repository search plus tree
  inspection.
- At most 4 repositories per query and 10 units per repository per scan; each scan's notes say what was left.
- No release-feed or security-advisory monitoring yet.
