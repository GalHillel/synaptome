# Registry, acquisition and installation policies

## Capability registry

One canonical record per capability (`capabilities` table, JSON `record` validated by the versioned
`CapabilityRecord` schema): identity, kind, domain, tags, activation and exclusion conditions, platforms,
dependencies, permissions, executables, publisher, repository, pinned commit, licence with evidence, provenance,
verification, security tier and trust, quality dimensions with evidence, context cost, benchmarks, weaknesses,
alternatives, install locations, update status, last audit.

Kinds: skill, agent, subagent, mcp-server, tool, hook, workflow, plugin, extension, prompt, template, knowledge,
model, memory-provider, eval-suite, connector. Discovery currently produces skill, agent, plugin, prompt, workflow,
hook, mcp-server and tool. Installable into Claude Code: **skill** (`skills/<name>/`), **agent/subagent**
(`agents/<name>.md`), **prompt** as a command (`commands/<name>.md`) and **mcp-server** (one entry in a project's
`.mcp.json`; never user-scope `~/.claude.json`). OpenCode: skills, staged only. Hooks, plugins and workflows are not
installed into hosts.

Install lifecycle (D-021, D-022): every change to a host location is serialised by a lock, fingerprinted, preceded by
a copy of what it replaces, and reverted exactly on failure. Rollback and uninstall refuse when the installed files
were edited afterwards (`--force` keeps a copy first). Downgrade only to versions Synaptome installed and verified
before. Evidence: `docs/evidence/phase-4/s4-install-matrix.md`, `s5-adapters.md`.

Versions: every evaluated content hash is kept in `capability_versions` with its snapshot path, so a previous
version can be restored.

## Pipeline

`DISCOVER → DOWNLOAD → QUARANTINE → AUDIT → REGISTER → TEST → SCORE → GATE → (APPROVE) → INSTALL → MONITOR`

`synaptome evaluate <candidate>` or `--next <n>` runs it up to the gate.

## Tiers

| Tier | Meaning | Policy |
|---|---|---|
| A | Declarative only: no executable files, hooks, MCP, network or install steps, no high findings | May be auto-promoted when every gate check passes |
| B | Executables, hooks, MCP servers, network or install steps, browser automation, or high findings | Always needs a human approval |
| C | Any critical finding, or a deny rule | Blocked. Stays in quarantine; never registered |

## Scorecard

Nine weighted dimensions (`policy.weights`): usefulness 15, technical 15, security 20, effectiveness 15,
compatibility 10, maintenance 10, documentation 5, context efficiency 5, provenance 5. Each stores its evidence.
A dimension with no evidence is `null`, contributes zero and is listed as unknown. Effectiveness is capped at 80
without a task benchmark.

## Promotion gate

All eleven must be `pass` for automatic promotion. `unknown` is not a pass.

1. No explicit deny rule matches
2. Quality score ≥ `policy.autoInstallThreshold` (default 88)
3. Verified provenance
4. Compatible licence (established from licence text)
5. No unresolved critical or high security findings
6. Tier A
7. All package content reviewed
8. No permission escalation (versus the installed version, or any permission at all on first install)
9. Compatible target platform
10. No conflicting installed capability (same name on the host, or an existing unmanaged directory)
11. Functional tests passed and a known rollback path (verified snapshot)

Outcomes: `auto-promote` → approved, and staged in the sandbox host when `policy.autoInstall` is `sandbox`;
`needs-approval` → waits in the queue; `blocked` → cannot be approved (deny rule, critical finding, Tier C, or a
non-allow-listed licence until it is explicitly accepted with a reason).

## Human decisions

- `synaptome approve <id> [--accept-licence "<reason>"]` — records who approved and which checks were unresolved.
- `synaptome reject <id> -r "<reason>"`.

## Installation

- `synaptome install <id>` — staged sandbox host (`<home>/sandbox-hosts/<host>/…`).
- `synaptome install <id> --real --yes` — real host directory. Requires: approved status, the same content hash
  already verified in the sandbox, host detected, target path free, and budget
  (`hosts.realInstallBudget`, default 1).
- `--dry-run` shows the plan without writing.
- Every installed directory carries `.synaptome.json` (capability, hash, source, commit, licence). Synaptome removes
  only directories with that marker and never overwrites existing content.
- A failed install is reverted and recorded as `failed`.

## Updates

`synaptome update check` asks sources; nothing is applied. `update inspect <candidate>` stages and audits the new
version and reports file changes, new permissions, new executables, tier and licence changes with a verdict.
`update apply <candidate>` re-runs the whole pipeline at the new ref; the capability returns to `registered`
unless the gate auto-promotes it, and the previous installation is backed up for `rollback`.

## Rollback

`synaptome rollback <installation-id>` removes the installed directory and restores the previous version when one
existed. `uninstall` removes without restoring.

## Evidence from this machine (2026-11-11)

- 20 GitHub candidates evaluated: 7 auto-promoted and staged; the rest held for a stated reason (name already
  present on the host, licence unknown, executables, score below threshold); 1 plugin blocked for a script that
  runs the host with `bypassPermissions`.
- `anthropics.internal-comms` installed for real, listed by the running Claude Code session, then rolled back; the
  host returned to 538 skills. A second real install was refused: "Real-install budget reached (1/1)".
