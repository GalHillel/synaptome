# Quick start

Fifteen steps from nothing to a working setup and back. Each one is a command you can run; `--json` on any command
gives machine-readable output. These are also the steps of the clean-room check (`scripts/clean-room.ps1`).

| # | Step | Command | You should see |
|---|---|---|---|
| 1 | Node.js 24 or later | `node --version` | `v24.` or later |
| 2 | Install | `npm install -g synaptome` | one package added |
| 3 | It runs | `synaptome --version` | `0.2.0` |
| 4 | Set up | `synaptome init` | storage created, hosts listed (none changed), checks pass, next steps |
| 5 | Checks | `synaptome doctor` | every check `ok` or a notice; exit 0 |
| 6 | Existing skills | `synaptome inventory` | the skills already installed for Claude Code indexed and audited (none on a new machine) |
| 7 | Discover | `synaptome scan --repo anthropics/skills` | candidates found in one public repository |
| 8 | Evaluate | `synaptome evaluate --next 1` | one candidate quarantined, audited, scored and gated |
| 9 | Decide | `synaptome approve <capability>` | approved; nothing installed yet |
| 10 | Install (sandbox) | `synaptome install <capability>` | staged into a sandbox copy of the host, verified |
| 11 | Undo | `synaptome rollback <installation>` | the sandbox is back to what it was |
| 12 | Route a task | `synaptome route "write release notes from the merged changes"` | the capabilities that fit, or none, with reasons |
| 13 | Connect a project | `synaptome init --project <folder>` | MCP entry, bridge skill and hook in that folder only |
| 14 | Interfaces | `synaptome` and `synaptome dashboard` | the Terminal Workbench and the Web Command Center, both opening on Get started the first time |
| 15 | Remove | `synaptome uninstall --everything --yes --delete-data`, then `npm uninstall -g synaptome` | the project folder back to what it was, no data folder, no program |

What to read next: `docs/INSTALL.md` (where things are, upgrade, repair), `docs/ARCHITECTURE.md` (how it works),
`docs/SECURITY_MODEL.md` (what is checked before anything runs), `synaptome --help` (every command).
