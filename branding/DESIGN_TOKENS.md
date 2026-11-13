# Design tokens

Source of truth: `apps/command-center/src/styles.css` (web) and `THEMES` in
`apps/terminal-workbench/src/index.tsx` (terminal). This file documents them; change the code, then this file.

## Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#f6f3ec` | `#171614` | page ground |
| `--surface` | `#fbf9f4` | `#1d1c19` | bars, navigation, inspector |
| `--sunken` | `#efebe1` | `#121110` | inputs, hover rows, code |
| `--raised` | `#ffffff` | `#262420` | overlays only |
| `--ink` | `#1f1d1a` | `#e9e4d8` | primary text |
| `--ink-2` | `#55514a` | `#b6af9f` | secondary text |
| `--ink-3` | `#857f73` | `#837d70` | labels, hints |
| `--rule` | `#dcd6c8` | `#33302a` | hairlines |
| `--rule-strong` | `#b9b2a1` | `#4c483f` | pane borders, control borders |
| `--accent` | `#8a5a2b` | `#c9925a` | current view, selection, focus |
| `--accent-ink` | `#6e4520` | `#dba873` | links, accent text |
| `--ok` | `#55682f` | `#9fae72` | approved, installed, pass |
| `--warn` | `#8f6210` | `#d2a24c` | needs approval, held, notice |
| `--danger` | `#8c2f2a` | `#d57f74` | blocked, failed |
| `--info` | `#3f5566` | `#93abbc` | registered, in progress |
| `--select` | `#e9e1cf` | `#2d2a23` | selected row |

Each status colour has a `-wash` background for notes. The terminal palettes reuse the same hex values; the
terminal `auto` theme uses the terminal's named colours instead.

## Type

| Token | Value |
|---|---|
| `--font-display` | Iowan Old Style, Palatino Linotype, Palatino, Book Antiqua, Georgia, serif |
| `--font-ui` | Segoe UI Variable Text, Segoe UI, system-ui, sans-serif |
| `--font-mono` | Cascadia Code, Cascadia Mono, Consolas, ui-monospace, monospace |
| Scale | 11 · 12 · 13 (base) · 14 · 16 · 20 · 28 px |
| Labels | 11px, uppercase, 0.08–0.1em tracking, weight 600 |
| Figures | tabular numerals everywhere numbers align |

## Space and shape

Spacing 4 · 8 · 12 · 16 · 24 · 32 · 48 px. Table row height 30px. Radius 2px (3px on overlays). One shadow, for
overlays. Top bar 46px, status bar 26px, navigation 196px, inspector 34% of the workspace (minimum 360px).

## Breakpoints

Workspace narrower than 860px (container query): secondary table columns hide. Window narrower than 1180px: the
inspector becomes an overlay. Narrower than 760px: navigation collapses behind a Menu button.

## Motion

`cubic-bezier(.2,.7,.2,1)`; 120ms for control hover, 140ms for overlays. Disabled under `prefers-reduced-motion`.
