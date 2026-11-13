# Next session — exact resume point

Read in this order: this file, `docs/MASTER_PLAN.md` (approved plan, Phases 0–12), `docs/DECISIONS.md`,
`docs/ACCEPTANCE_MATRIX.md`, `docs/PROGRESS.md`.

## State (2026-11-13, Phase 11 closed)

- Branch `rebrand/synaptome`. Tags: `drelqavo-0.1.0`, `phase-N-start`/`phase-N-done` for N = 1–11, `phase-12-start`.
  No remote; nothing pushed or published.
- The repository folder keeps its old name on disk (D-003). Do not rename or move it.
- **Phases 0–11 complete** (with recorded limits); Phase 12 S1–S4 complete. Phase 12 S5 (launch) is gated: every external step
  needs the owner's separate approval.
- `npm test` and `npm run ci` pass (see `docs/PROGRESS.md` for counts). Schema version 9 (search rows keyed by rowid,
  D-029). The development data `.synaptome-dev/` moves to schema 9 the next time anything opens it (a copy goes to its
  `backups/` first).
- Build: `npm run build` → `dist/` (package with `LICENSE`, `NOTICE`, `THIRD_PARTY_LICENSES.md`); `npm pack` in `dist/`.
- Checks that open windows or use the network: `scripts/tui-matrix.ps1` (terminal windows, about a minute),
  `scripts/clean-room.ps1 -Package <tgz>` (one console window; GitHub without credentials: about 10 of the 60 anonymous
  requests an hour), `scripts/perf.ts` (several minutes at 50k).

## Next action: Phase 12 S5, each step approved separately

Update: the owner chose their current Git identity as the public author; `public/main` holds the one parentless
public commit (step 2 below is done). If `rebrand/synaptome` moves on before the push, rebuild it with
`npx tsx scripts/public-tree.ts --commit --replace --author "$(git config user.name) <$(git config user.email)>"`.
Name confirmed by the owner (D-031). The repository `GalHillel/synaptome` exists, **private and empty**; the local remote `public` can push only `public/main` → `main` (no tags). Next: the push (step 3, needs approval), then CI green on GitHub.

S1–S4 are done. The owner chose **option C, a fresh public history** (D-030). `scripts/public-tree.ts` builds the
public tree from a commit (private record left out, overlay from `packaging/public/`, all checks pass); `npm ci` and
`npm run ci` pass inside an exported copy. Nothing external has happened and no public commit exists yet.

1. The owner gives the public author identity (for example a GitHub no-reply address) and confirms the name after a
   legal check.
2. `npx tsx scripts/public-tree.ts --commit --author "Name <email>"` creates one parentless commit on `public/main`
   from HEAD (commit everything first; the working tree is not included).
3. Then each S5 step with its own approval: create the repository (private first) → `git push <remote>
   public/main:main` (that branch only, no tags) → CI green → `npm publish --tag next` → GitHub release → install from
   public sources → site.

### Phase 12 plan (for reference)

Phase 12 per `docs/MASTER_PLAN.md`:
- S1 docs set: public README (what it is, install, quick start, CLI examples), `CONTRIBUTING.md`, `SECURITY.md`
  (private reporting until there is a public contact), `CODE_OF_CONDUCT.md`, issue and pull-request templates under
  `.github/`, release notes for 0.2.0. Every command in the docs is executed by a test (the quick start already is).
- S2 screenshots and demo from a neutral demo home outside the user folder, so no personal path appears (the Phase 9
  screenshots show the owner's user folder; see below).
- S3 landing page in `site/`, built from `packages/ui-tokens`; no invented metrics, testimonials or platform claims.
- S4 release audit: list every sensitive item in the tree and the full history, and propose options (publish as is,
  exclude paths going forward, fresh public history with the full history kept privately, filtered history). Apply
  nothing without the owner's approval.
- S5 gated, each separately approved: create the GitHub repository → push → CI green → npm publish (prerelease tag
  first; re-check the name on npm first) → GitHub release → install from public sources on a clean environment →
  publish the site if hosting is approved.

## Open items the owner decides

- **Git history:** decided (D-030): this history stays private and unchanged; the public repository starts from
  `public/main`. Never push any other branch or tag of this repository to a public remote.
- **Public author identity:** decided (the owner's current Git identity).
- **Clean-room in a separate Windows account:** this machine runs Windows 11 Home (no Windows Sandbox); creating a local
  account changes the machine. The disposable-profile run passed 18/18.
- **Playwright browsers download** (browser flow tests, 10k-node canvas draw measurement).
- **Name clearance:** confirmed by the owner (D-031).
- `claude` login for headless host proofs; retiring `.drelqavo-dev/`; mouse click-test in Windows Terminal
  (`synaptome tui --mouse`).

## Standing constraints

- Installs, upgrades and rollbacks are tested only in sandbox hosts and disposable homes. The one real-install
  permission is spent. Do not change global Claude Code configuration.
- Not without the owner's approval (D-004): npm publish, creating remotes, pushing, public releases, persistent
  scheduled tasks, installs into personal hosts, history rewriting, creating local accounts.
- The write gate (`GateGuard`) rejects the first write to every new file or directory; exempting this repository with
  `GATEGUARD_EXEMPT_GLOBS` would remove a large per-file overhead.
