# Interfaces: Terminal Workbench, Web Command Center, CLI

All three call `createApi(sys).call(name, args)` in `packages/service`. There is one definition of each query and
action; no interface has private state.

## Terminal Workbench

Start: `synaptome` or `synaptome tui [--theme dark|light|auto]`.

### Framework choice

| | Ink (chosen) | Textual | Bubble Tea | Ratatui |
|---|---|---|---|---|
| Language | TypeScript/React | Python | Go | Rust |
| Fit with the core | in-process, shared types, no IPC | needs a process and API boundary | same | same |
| Toolchain on the target machine | present (Node 24) | Python present | Go absent | Rust absent |
| Windows Terminal / PowerShell | works | works | works | works |
| Widgets | few; built here | richest | good via Bubbles | good |
| Mouse | none | yes | yes | yes |
| Packaging | needs Node | needs Python | single binary | single binary |

Ink was chosen because it shares the core in-process and adds no toolchain. Its costs are accepted and stated:
no mouse support, and rendering is done by this project (a fixed grid of cells) rather than by a widget library.
If a single-binary distribution or mouse interaction becomes a requirement, Bubble Tea or Ratatui over the
service's HTTP API is the route; the API boundary already exists.

### Layout

| Width | Layout |
|---|---|
| ≥ 132 columns | navigation · list · inspector |
| 78–131 | navigation · list; Enter or `i` opens the inspector in the list pane |
| < 78 | one pane; the view name sits in the title line |

Every line is fitted to the terminal width using display width (wide and combining characters included).
Optional columns give way first. The screen is redrawn on resize.

### Views

Overview · Discover · Skills · Queue · Security · Routing · Forge · Logs · Settings.

### Keys

`↑ ↓ j k` move · `PgUp PgDn g G` · `← → h l Tab 1-9` switch view · `Enter` actions (wide) or inspector ·
`i` inspector · `[ ]` scroll inspector · `a` actions · `Space` mark several · `/` filter · `:` or `Ctrl+K`
palette · `r` refresh · `t` theme · `?` help · `q` or `Ctrl+C` quit.

Actions that change something show their consequences and ask `y`/`n`. Actions that need a value (a reason, a
query, a repository) prompt for it.

### Robustness

- Runs in the alternate screen; the scrollback is untouched. On exit or on an uncaught error the alternate screen
  is left, the cursor restored, and a plain message printed.
- Without a TTY it prints a hint and exits with code 2; non-interactive commands keep working.
- `NO_COLOR` is honoured. Status is always glyph plus word. Outside Windows Terminal on Windows, ASCII glyphs are
  used.
- `auto` theme keeps the terminal's background; `dark` and `light` paint their own.
- Keys arriving faster than a render (paste, key repeat) are handled from synchronously readable state.

### Verified

Tests (`apps/terminal-workbench/test`): width never exceeded at 140, 96 and 60 columns; keyboard navigation,
filter, inspector, real install action, confirmation and cancel, palette, help, theme, load-failure message.
Live in a PowerShell terminal panel: launches with real data, shows a CLI event in the status line as it happens,
picks up a theme changed in the web UI, exits to a clean prompt on Ctrl+C.

Not verified: Windows Terminal itself (the live run used the desktop app's terminal panel), Command Prompt, macOS
and Linux terminals. Mouse is unsupported.

## Web Command Center

Start: `synaptome dashboard [--port 4319] [--no-open]`. Loopback only, per-session token, origin and host checks,
strict Content-Security-Policy.

Views: Overview · Capability Library · Discovery · Installation Queue · Security · Routing Explorer · Skill Forge ·
Activity · Settings. Inspectors for capabilities (summary, score evidence, findings, gate checks, history,
content), candidates, routing decisions and forge candidates.

Interaction: global search (`/`), command palette (`Ctrl+K`) that also searches capabilities, `1–9` views, `j k`
and Enter in tables, `Esc`, `t` theme, `?` help. Confirm dialogs list consequences and require a reason where the
policy does. Live updates through a resumable event stream; an offline banner when the service stops.

Responsive: secondary columns hide when the workspace is narrow (container query), the inspector becomes an
overlay below 1180 px, navigation collapses below 760 px. `prefers-reduced-motion` disables the few transitions.

All figures are read from the database. Real installs are deliberately not offered here; they need the CLI.

### Verified

In the browser pane: Overview, Library and Queue render with live data in dark and light themes with no console
errors; the palette found a capability and opened its inspector; a rejection made in the queue appeared in the CLI
event log with origin `web`. Server tests cover the token, foreign-origin refusal and event-stream resume.

Not verified: Discovery, Security, Routing, Forge, Activity and Settings pages were not each exercised by hand in
this pass; a screen-reader pass and a contrast audit were not done.

## CLI

Global: `--json`, `--home <dir>`. Exit codes: 0 ok · 1 error · 2 usage · 3 blocked by policy · 4 not found ·
5 unavailable.

```
status  doctor  events  config get|set
sources [--check]  scan [-m broad|incremental|need] [-q text] [--repo o/n] [-s source…]  candidates  candidate <id>  scans  schedule
evaluate <id>|--next n  skills list|search|facets  inspect <id> [--content]  approve  reject
install <id> [--host h] [--real --yes] [--dry-run]  installs  installation <id>  rollback <id>  uninstall <id>
inventory  audit  update check|inspect|apply
route "<task>" [--explain] [--discover]  activate <id>  outcome <decision> <result>  decisions [id]  activations  gaps
mcp  bridge init|remove <dir>  hook user-prompt
forge list|new|show|author|check|export-evals|eval|decide|revise  eval [subject]
dashboard  tui
```
