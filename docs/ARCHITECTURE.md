# Architecture

## Shape

```
        Terminal Workbench (Ink)      Web Command Center (React)       CLI            AI host (Claude Code)
              in-process                   HTTP + SSE (loopback)     in-process        MCP stdio / hook / skill
                    \                            |                      |                    /
                     +---------------- packages/service: createApi(sys).call(name, args) ---+
                                                 |
   discovery -> acquisition (security, adapters) -> router -> forge/evaluation        (domain packages)
                                                 |
                              packages/core: SQLite (WAL, FTS5) + snapshot store + events
```

One process model: every interface opens the same home directory and calls the same library. There is no daemon
that must be running. SQLite in WAL mode with a busy timeout lets the CLI, the workbench and the dashboard run at
the same time.

**State sharing.** Every mutation appends a row to `events`. `watchEvents` (core) delivers new rows as they are
committed: rows written by the same process on the next turn of the event loop, rows written by another process
when SQLite's `data_version` changes (checked every 250 ms; the events table is read only when it changed; a rolled-back
write is never announced). The dashboard streams them over SSE (resumable with `Last-Event-ID`); the workbench
updates its status line and reloads its view (at most once per 150 ms); the CLI prints them (`synaptome events`). An action taken in
one interface therefore appears in the others without any interface-specific state. Verified: a rejection made in
the browser appeared in the CLI event log with origin `web`, and the workbench's status line showed a CLI routing
decision as it happened.

## Interfaces

- **Web Command Center** (`apps/command-center`): React, bundled by esbuild when `synaptome dashboard` starts and
  served on loopback with a per-start token sent as a header (never in a URL). `main.tsx` holds the shell (navigation,
  palette, shortcuts, theme, event stream); screens live in `views.tsx`, `screens.tsx` and `graph.tsx`; `lib.tsx`
  holds the API client, the live-event stream (exponential backoff, stops with a reload banner after a stale-token
  401) and shared components. 17 screens.
- **Design tokens** (`packages/ui-tokens`): the only definition of colours, spacing and type; emitted as CSS variables
  for the web and as a palette for the terminal workbench (D-026).
- **Terminal Workbench** (`apps/terminal-workbench`): Ink, in-process with the core. `workbench.tsx` draws the whole
  screen as a grid of exactly width x height cells (three panes when wide, two when medium, one when narrow); each of the
  17 views is a module in `views/` with `load`, `inspect` and `actions` over `api.call`; `kit.ts` holds shared marks and
  actions; `theme.ts` takes its palette from `packages/ui-tokens`. Live updates come from `watchEvents`. Mouse is
  opt-in (SGR reports, presses and wheel only). `SYNAPTOME_TUI_REPORT` makes it write a startup report, used by
  `scripts/tui-matrix.ps1` to run it in real terminals (D-027).

## Distribution and lifecycle

`npm run build` (`scripts/build.ts`, esbuild) writes `dist/`: `synaptome.mjs` (launcher: Node ≥ 24 check, warning
filter, records its own path as `SYNAPTOME_LAUNCHER`), `cli.mjs` (every workspace package and dependency in one ES
module), `web/` (prebuilt Command Center, served by the dashboard when present; in the repository the dashboard
bundles in memory instead), `package.json` (no dependencies) and `build-info.json` (bundled npm packages and sizes). The
development launcher (`apps/cli/bin/synaptome.mjs`, TypeScript through tsx) stays for work in the repository.

The program and the data folder have separate lifecycles (D-028): `init` (set up and verify; `install.json`),
`repair [--fix]` (`checkInstallations`, `restoreMissingInstall`, project bridge checks), `upgrade <spec>` and
`upgrade --rollback` (`<home>/versions/`, `<home>/backups/`, `<home>/upgrades.json`; an older version refuses a newer
database), `uninstall --everything` (rollbacks newest first, `bridgeRemove` for every project recorded by
`bridge.initialised` events, data kept unless `--delete-data`). Commands live in `apps/cli/src/commands/setup.ts` and
`upgrade.ts`.

## Identity

`packages/core/src/identity.ts` is the only place the product's names are defined: display name, executable,
environment prefix, data directory, database file, token header, MCP server name, install marker, snapshot
manifest and bridge record. Everything else reads `PRODUCT`. `LEGACY` holds the names used before the product
was called Synaptome and is read only by the migration, the legacy-home guard, the install-marker lookup and
`bridge remove`. `env(name)` reads `SYNAPTOME_<name>` and falls back to the old variable with a notice on
stderr. Nothing derives identity from the repository folder name.

## Storage

- `synaptome.db` — one SQLite file. Versioned migrations (`MIGRATIONS` in `packages/core/src/db.ts`); the file is
  copied to `backups/` before a pending migration is applied to an existing database.
- Full-text search: FTS5 with BM25 over name, description, tags and body. No vector store: lexical retrieval has
  not yet been shown to be the limiting factor (see `docs/INTELLIGENCE_KERNEL.md` for its known weaknesses).
- Graph: `relations(src, rel, dst, weight, evidence)`. No graph database.
- `store/<capability>/<hash16>/` — immutable snapshots with a manifest of per-file hashes. Reads re-hash and refuse
  on mismatch.
- `quarantine/<candidate>/<hash16>/` — untrusted downloads. Never executed, never read as instructions.
- `sandbox-hosts/<host>/…` — staged host directories used before any real install.

Default home: `%LOCALAPPDATA%\synaptome` (or `~/.synaptome`); override with `SYNAPTOME_HOME` or `--home`.

A home written under the previous product name is never opened in place. `openSystem` refuses it and
`synaptome migrate` copies it to a new home as one verified, staged operation with a guarded rollback
(`docs/MIGRATION.md`, `packages/core/src/migrate.ts`).

## Extension interfaces

Defined in `packages/core/src/schema.ts`. Each has a real implementation and tests; nothing here is speculative.

| Interface | Implementations | Proof it is pluggable |
|---|---|---|
| `DiscoveryConnector` | GitHub, MCP registry, local Claude inventory, skills.sh (policy-blocked) | `discovery.test.ts` defines a connector inside the test file and scans with it |
| `CapabilityProvider` | snapshot store | integrity test in `core.test.ts` |
| `HostAdapter` (+ `TargetOps`) | Claude Code (skills as directories; agents and commands as one file with a sidecar record; MCP servers as one entry in a project `.mcp.json` with a sidecar ledger), OpenCode (experimental, skills) | `acquisition.test.ts` installs through both; `install-matrix.test.ts` and `adapter-kinds.test.ts` run the lifecycle through every target shape; a test swaps in a broken adapter |
| `RoutingStrategy` | `lexical-graph-v1` | `routeTask` accepts any strategy; the forge passes a configured one |
| `PermissionPolicy` | tiered promotion gate | used by acquisition and by the forge |
| `EvaluationRunner` | model runner, imported-transcript runner | `forge.test.ts` |
| `ModelProvider` | `packages/providers`: headless Claude Code (VERIFIED by live call), Anthropic API, OpenAI-compatible (OpenAI, Ollama, other local servers), Gemini (contract-tested; UNVERIFIED until a live call with credentials) | `providers.test.ts` drives each protocol through a fake transport |
| `WorkflowExecutor` | plan-only executor (router), and the workflow engine in `packages/workflow` (runs in SQLite, step runners: api-call, model, approval, noop, shell) | `engine.test.ts` injects its own runners; a test kills the executing process and resumes elsewhere |
| Agents | `packages/agents`: five specialists as `agent` steps of the workflow engine, with hand-offs, blackboard, budgets and per-call trace | `agents.test.ts` runs the shipped team with a deterministic fake provider |

Adding a source is one `register()` call in `packages/connectors/src/index.ts`. Adding a host is one adapter in
`packages/adapters`.

## Selective activation

The registry can hold thousands of capabilities because it is never copied into a host's skill listing. A host
reaches it through:

1. **MCP server** (`synaptome mcp`): `route_task`, `get_capability`, `search_capabilities`, `record_outcome`.
2. **Hook** (`synaptome hook user-prompt`): deterministic injection of the routed capability for a prompt.
3. **Bridge skill**: one small skill that tells the model to call the above.

Native installation of a skill into a host directory is a separate, explicit, per-host step. Limits and what was
observed are in `docs/INTELLIGENCE_KERNEL.md`.

## Decisions

| Decision | Why | Revisit when |
|---|---|---|
| TypeScript on Node 24 everywhere | one language across core, TUI and web; `node:sqlite` built in; no Go/Rust toolchain on the target machine | a hot path needs native speed |
| Run TypeScript through `tsx`, no build step | faster iteration; one launcher | packaging for distribution |
| Ink for the TUI | shares the core in-process; see `docs/INTERFACES.md` for the comparison | mouse support becomes a requirement |
| Web bundle built in memory by esbuild at `dashboard` start | no artefacts to keep in sync | start-up time matters |
| Deterministic router first | explainable, testable, free; model assistance is optional | recorded outcomes show lexical retrieval is the bottleneck |
| Events table instead of a message bus | one writer model, trivially resumable | multiple machines |

Deviation from the approved plan: the web app is bundled at start-up by esbuild rather than built with Vite. Same
React code, one fewer toolchain.
