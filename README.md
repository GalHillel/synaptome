# Synaptome

**One intelligence layer. Every capability. Always evolving.**

Synaptome is a local-first capability layer for AI coding hosts such as Claude Code. It finds skills, agents and MCP
servers in public sources, audits each one as untrusted input before anything can run, keeps one registry on your
machine, installs only what you approve (into a sandbox copy of the host first, always with rollback), and routes each
task to the few capabilities that fit it, so a host reads short summaries instead of everything you have installed.

Everything runs on your machine: one SQLite database, one snapshot store, and three interfaces over the same state.

| Interface | Start it with | For |
|---|---|---|
| Terminal Workbench | `synaptome` | working next to an AI coding tool in a terminal |
| Web Command Center | `synaptome dashboard` | reviewing, inspecting and approving in a browser (loopback only) |
| CLI | `synaptome <command> [--json]` | scripts and agents; stable exit codes |

## Status

**Pre-release (0.2.0, not yet published).** Windows is the tested platform; macOS and Linux are expected to work and
are not verified. What works and what does not, per subsystem and with evidence:
[`docs/ACCEPTANCE_MATRIX.md`](docs/ACCEPTANCE_MATRIX.md). Known limits include: executable capability content always
needs a person's approval (no isolation provider for dynamic tests), most model providers other than headless Claude
Code are not yet verified by a live call, and a host may or may not load a capability it was offered.

## Install

Requires Node.js 24 or later.

```
npm install -g synaptome
synaptome init
```

Until it is published, install from a package file built from this repository (`npm run build`, then `npm pack` in
`dist/`). Details, data locations, upgrade, repair and uninstall: [`docs/INSTALL.md`](docs/INSTALL.md). Fifteen steps
from nothing to a working setup and back: [`docs/QUICKSTART.md`](docs/QUICKSTART.md).

## What a session looks like

```
synaptome inventory                       # index and audit the skills already installed for Claude Code (read only)
synaptome scan                            # discover candidates from public sources
synaptome evaluate --next 3               # quarantine, audit, score and gate the next three
synaptome approve <capability>            # approve (does not install)
synaptome install <capability>            # into a sandbox copy of the host; --real --yes for the real one
synaptome route "write release notes from the merged changes" --explain
synaptome init --project <folder>         # let that project's Claude Code ask Synaptome for capabilities
```

## The lifecycle

```
DISCOVERY     discovered -> ranked -> queued
ACQUISITION   quarantined -> audited -> scored -> tested -> registered -> approved | rejected | blocked
INSTALLATION  installed for one host (sandbox first; a real host only with explicit confirmation)
ACTIVATION    served for one task, recorded with its outcome
```

Approved is not installed. Installed is not activated. Each stage has its own records and commands.

## Safety

- Downloaded content is quarantined, never executed by Synaptome and never read as instructions.
- A capability that fails the audit is blocked from routing and installation; executable content needs a person.
- Installs never overwrite content Synaptome did not create; edits made after an install are never discarded silently.
- Global Claude Code configuration is never changed; connecting a project writes only into that project.
- The local dashboard listens on loopback, needs a per-start token sent in a header, and refuses foreign origins and
  Host names.

Threats and their controls: [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md). Reporting a vulnerability:
[`SECURITY.md`](SECURITY.md).

## Working on Synaptome

```
npm install
npm run ci          # typecheck, all tests, build, licence check, npm audit
```

[`INSTALLATION.md`](INSTALLATION.md) (working from source) · [`CONTRIBUTING.md`](CONTRIBUTING.md) ·
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/DECISIONS.md`](docs/DECISIONS.md) ·
[`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) · [`CHANGELOG.md`](CHANGELOG.md).

```
packages/core          identity, schema, SQLite and migrations, events, registry, snapshot store, home migration
packages/discovery     connector contract, scan engine, ranking, overlap, scheduler, update monitor
packages/connectors    GitHub, MCP registry, npm, PyPI, GitLab, curated lists, local Claude Code inventory
packages/security      static audit, licences, supply chain, tiers, scorecard
packages/acquisition   quarantine pipeline, promotion gate, installer, rollback, update inspection, repair checks
packages/adapters      host adapters (Claude Code; OpenCode experimental)
packages/router        task analysis, retrieval, selection, budgets, gaps, activation records
packages/mcp-server    stdio MCP server for hosts
packages/evaluation    graders, runners, headless model provider
packages/forge         Skill Forge: gaps to tested, evaluated skills
packages/workflow      workflow engine (runs in SQLite, approvals, resume)
packages/providers     model providers with recorded verification
packages/agents        specialist agents as workflow steps
packages/ui-tokens     the one palette and type scale for Web and terminal
packages/service       one command surface for every interface, loopback HTTP server
apps/cli               the synaptome command (init, repair, upgrade, uninstall and everything else)
apps/terminal-workbench  Ink terminal interface
apps/command-center    React web interface
```

## Licence

Apache-2.0 ([`LICENSE`](LICENSE), [`NOTICE`](NOTICE)). The package bundles third-party code under its own licences,
listed with their texts in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md). Capabilities Synaptome discovers are
downloaded to your machine and keep their own licences; none are bundled. The name "Synaptome" has had a preliminary
clearance check only ([`docs/NAMING_CLEARANCE.md`](docs/NAMING_CLEARANCE.md)).
