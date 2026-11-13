# Working from source

This page is for working on Synaptome in a checkout of this repository. To install and use the product, see
[`docs/INSTALL.md`](docs/INSTALL.md) and [`docs/QUICKSTART.md`](docs/QUICKSTART.md). A package is built with
`npm run build` (output in `dist/`; `npm pack` there makes the package file).

## Requirements

- Node.js 24 or newer (uses the built-in `node:sqlite` with FTS5).
- Optional: GitHub CLI `gh`, logged in. Without it GitHub discovery runs unauthenticated with lower limits, or
  uses `GITHUB_TOKEN` if set.
- Windows is the tested platform (PowerShell, Git Bash). macOS and Linux are untested.

## Install

```bash
git clone <this repository> synaptome
cd synaptome
npm install
npm test
node apps/cli/bin/synaptome.mjs doctor
```

To get the `synaptome` command on PATH:

```bash
npm link
```

`npm link` creates a global symlink to this checkout. Remove it with `npm unlink -g synaptome`.

## What the first run does

- Creates the home directory (`%LOCALAPPDATA%\synaptome`, or `SYNAPTOME_HOME`, or `--home <dir>`), the database and
  the store folders. Nothing else on the machine is touched.
- `synaptome doctor` reports what was detected: runtime, database, GitHub authentication, which hosts are present.
- Nothing is scanned, installed or scheduled until you ask.

Typical first session:

```bash
synaptome inventory          # read-only index of skills already installed for Claude Code
synaptome scan --mode broad  # discover
synaptome evaluate --next 5  # quarantine, audit, score, gate
synaptome installs           # what is waiting, what is staged
```

## Connecting a Claude Code project (optional, project-scoped)

```bash
synaptome bridge init <project-dir>     # writes .mcp.json and .claude/skills/synaptome/ in that project only
synaptome bridge remove <project-dir>   # removes exactly those files
```

Global Claude Code configuration is never edited.

## Upgrade

```bash
git pull
npm install
synaptome doctor
```

Schema migrations run on the next start. The database is copied to `<home>/backups/` first.

## Rollback

| To undo | Do |
|---|---|
| An installation | `synaptome rollback <installation-id>` (ids from `synaptome installs`). Restores the previous version if there was one, otherwise removes it. |
| A project bridge | `synaptome bridge remove <project-dir>` |
| A schema migration | Stop Synaptome, replace `<home>/synaptome.db` with the copy in `<home>/backups/`, check out the matching commit. |
| Scheduled tasks (if you registered them) | `synaptome schedule --remove --yes` |
| Everything | `synaptome uninstall --everything --yes` (rolls back every install, disconnects every project; add `--delete-data` to delete the home directory), then `npm unlink -g synaptome`. |

## Backup

Copy the home directory while no Synaptome process is writing. `synaptome.db`, `store/` and `forge/` are the parts
that matter; `cache/` and `quarantine/` can be rebuilt.

## Installed copies

An installed package has its own lifecycle commands: `synaptome init`, `repair`, `upgrade` / `upgrade --rollback` and
`uninstall --everything` (see [`docs/INSTALL.md`](docs/INSTALL.md)). `upgrade` refuses to run from a checkout; here,
use git.
