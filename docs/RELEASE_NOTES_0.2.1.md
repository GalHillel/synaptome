# Synaptome 0.2.1 — release notes (security and data-safety hotfix, pre-release)

**If you use 0.2.0, upgrade.** In 0.2.0, `synaptome bridge remove`, `synaptome repair --fix` and
`synaptome uninstall --everything` can delete a project's whole `.mcp.json`, including MCP servers you added after
connecting, and the whole bridge skill folder, including files you added or edited there. 0.2.1 removes only what
Synaptome wrote and can still prove unchanged, and reports everything it kept. Until you upgrade, do not run those
three commands on a connected project where you changed `.mcp.json` or `.claude/skills/`, or back those up first.

0.2.1 contains fixes only. It switches nothing new on and keeps your settings and data. Full list:
[`CHANGELOG.md`](../CHANGELOG.md).

## Fixed

- **Disconnecting never deletes your data.** Every file and entry Synaptome writes into a project is recorded with a
  hash; removal touches only what still matches; a file is deleted only when nothing but Synaptome's own unchanged
  content remains. Connecting and disconnecting are transactions: a failure restores every file. New:
  `synaptome bridge status`, `bridge update` and `bridge adopt` (0.2.0 records are recognised).
- **No borrowed trust.** Official trust follows the account that holds a capability's code, so a listing that names an
  official publisher for someone else's code no longer earns it.
- **Stronger checks of skill text.** A skill that tells the model to read a secret and send it to a web address is
  blocked, and a trailing "never …" no longer softens an injection finding.
- **Upgrades that fail are fully undone.** The previous version is checked to start again, also after npm stops half
  way through writing a package, and an upgrade that installs a different version than the one asked for is undone.
- **A damaged database is named**, with a safe next step, and nothing is written to it.
- **The prompt hook cannot block Claude Code.** It always exits 0, never migrates or creates a home, and passes the
  prompt through when the home is locked or from another version.
- **Cancel means stopped.** Cancelling or timing out a model or agent step stops its whole process tree; retries never
  overlap; late results are discarded.
- **Budgets hold under parallel steps.** Each billable call reserves its worst case first; a call that does not fit is
  refused before it starts.
- **Concurrent installs are serialised safely**, also after a crashed installer left its lock behind.
- **Truthful source status.** Sources that were never scanned say so; `synaptome scan` covers every enabled permitted
  source and reads several pages.

## Known

- Routing defect R1: for a task like "build a TypeScript REST API", a client-SDK generator can be offered and a
  JavaScript testing skill missed. The fix is part of the larger routing work in the 0.3.0 line.
- Automatic capability use (Claude Code loading an offered capability without being asked) is beta: in measured real
  sessions it did not happen. Routing on request (`synaptome route "…"`) and explicit installs are unaffected.
- Windows with the Claude desktop app: Claude Code in the app, its hooks and its MCP servers see their own copy of
  the data folder under `AppData`, so they and a terminal can see different databases (which can look like a damaged
  database). Use a data folder outside `AppData` for both, for example `--home "%USERPROFILE%\.synaptome"`.
  0.3.0 adds a `doctor` warning for it.

## Upgrading

```
synaptome upgrade synaptome@0.2.1
synaptome doctor
synaptome bridge update <project>
```

`synaptome upgrade` keeps the previous version and a database copy; `synaptome upgrade --rollback` returns to 0.2.0
(a database changed after the upgrade is kept unless you ask otherwise). `npm install -g synaptome@0.2.1` also works.
`synaptome bridge update` adopts a 0.2.0 bridge into the new ownership record without removing anything. Restart
running Claude Code sessions afterwards. The database gains two tables (migrations 12 and 13), with a backup first.
