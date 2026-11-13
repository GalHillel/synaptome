# Installing Synaptome

## Requirements

- **Node.js 24 or later.** Synaptome uses the SQLite engine built into Node (`node:sqlite`). Check with `node --version`.
  An older Node is refused with a message before anything runs.
- **Windows 10 or 11** is the tested platform (Windows Terminal, PowerShell and cmd). macOS and Linux are expected to
  work and are not yet verified.
- **GitHub access (recommended).** Discovery and evaluation read GitHub's API. Without credentials GitHub allows 60
  requests an hour, which one scan and an evaluation or two can use up; a scan stopped that way is reported as
  partial with the reset time. With the GitHub CLI signed in (`gh auth login`) or `GITHUB_TOKEN` set, the limit is
  5,000. The token is read when a request is made and never stored.
- About 2 MB for the program. The data folder grows with what you index (about 35 MB for 1,000 capabilities).

## Install

Synaptome is one npm package with no dependencies.

```
npm install -g synaptome
```

Version 0.2.0 is on npm (a pre-release; the `next` tag). To install a build of your own instead, make a package file
from this repository (`npm run build`, then `npm pack` inside `dist/`):

```
npm install -g ./synaptome-0.2.0.tgz
```

Then set it up:

```
synaptome init
```

`init` checks the system, creates the data folder, lists the AI hosts it can see (it changes none of them), explains
what Synaptome will and will not do, runs the diagnostics and prints the next steps. Options:

- `--project <folder>`: connect that project's Claude Code to Synaptome (an MCP server entry in the project's
  `.mcp.json`, a small bridge skill, and a prompt hook in the project's `.claude/settings.local.json`). Nothing outside
  that folder is written; global Claude Code settings are never changed. `--no-hook` leaves the hook out.
- `--inventory`: index and audit the skills already installed for Claude Code, read only.

Running `init` again is safe: it reports and verifies, and resets nothing.

## Where things are

| What | Where |
|---|---|
| Data (registry, history, snapshots, backups) | `%LOCALAPPDATA%\synaptome` on Windows, `~/.synaptome` elsewhere; or `SYNAPTOME_HOME` / `--home <dir>` |
| Program | the npm global folder (`npm prefix -g`) |
| Project connection | only in projects you connected: `.mcp.json`, `.claude/skills/synaptome/`, `.claude/settings.local.json`, `.synaptome-bridge.json` |
| Installed capabilities | sandbox copies inside the data folder; real host folders only after `install --real --yes` |

## Check and repair

```
synaptome doctor          # all checks; exit 1 when one fails
synaptome repair          # finds drift: missing records, deleted installs, damaged snapshots, broken project links
synaptome repair --fix    # applies the safe fixes; edited files and damaged data are reported, never overwritten
```

If program files were deleted, reinstall the package (`npm install -g synaptome`); the data folder is separate.

## Upgrade

```
synaptome upgrade synaptome@<version>     # or a package file
synaptome upgrade --rollback              # back to the version before the last upgrade
synaptome upgrade --status                # history
```

Before upgrading, Synaptome keeps the running version as a package file in `<data>/versions/` and a copy of the
database in `<data>/backups/`. The new version must start and pass `doctor` on your data, or the previous version (and
database) is put back. A rollback keeps your current data when the database format did not change; when it did, the
earlier copy replaces it only if nothing was recorded after the upgrade, or when you ask with `--discard-newer-data`
(the current database is copied to backups first). An older version never opens a database written by a newer one.

## Uninstall

```
synaptome uninstall --everything               # lists what would be undone; changes nothing
synaptome uninstall --everything --yes         # rolls back every install it made, disconnects every project
synaptome uninstall --everything --yes --delete-data    # and deletes the data folder
npm uninstall -g synaptome
```

Installs you edited after Synaptome installed them are kept (add `--force` to remove them; the edited files are copied
to the backups first). The data folder is deleted only with `--delete-data`, and only when everything else was undone.
