# Release audit (Phase 12 S4) — for the owner's decision

Date: 2026-11-13. Scope: the tree at the commit that adds this file and the full history (76 commits, one author).
Nothing here has been applied: per the plan, no history rewriting or exclusion strategy is used without the owner's
approval, and the local repository's history is never altered.

Publishing a Git repository publishes **every commit**, not just the current files. So each item below is listed
twice: what is in the current tree, and what is in the history.

## What would become public

| # | Item | Current tree | History | Sensitivity |
|---|---|---|---|---|
| 1 | Owner's user-folder path (Windows user name) | none in text files; visible in 4 screenshots `docs/evidence/phase-9/tui-*.png` | 15 occurrences: 14 in an old `docs/evidence/demo-trace.txt`, 1 in an earlier `docs/MASTER_PLAN.md`; the 4 screenshots | personal (reveals the account name) |
| 2 | Owner's name and e-mail address | none in file contents | author and committer of all 76 commits | personal; a public push shows them |
| 3 | Credentials, tokens, keys | none (scanned: GitHub, Anthropic, OpenAI, AWS, Slack, Google, private keys) | none | — |
| 4 | Third-party people and audit results | `docs/internal/UPSTREAM_TRACKER.md` names two individual GitHub accounts and records the audit result and licence terms of their project; `docs/internal/MILESTONE_1_PROGRESS.md` and (until 2026-11-13) `docs/MASTER_PLAN.md` mention the project by name | the same, plus earlier wording | reputational for a third party; not code |
| 5 | Third-party code | none (no upstream code, text or assets; decision recorded 2026-11-11) | none | — |
| 6 | Details of the owner's machine | evidence files describe audits and installs against the owner's Claude Code setup (`docs/evidence/phase-1`, `-2`, `-4`, `-6`, `docs/internal/milestone-1-evidence/`): counts and some names of locally installed skills, the existence of local research folders | same | low to moderate: reveals what tools the owner uses |
| 7 | Development history and internal notes | `docs/internal/` (milestone notes, provenance, forge evidence); `docs/PROGRESS.md`, `docs/NEXT_SESSION.md` describe the working process | all of it | low; truthful history the plan wants kept |
| 8 | Name | "Synaptome" passed a preliminary check only; a neighbouring mark (SYNAPTOMIX) was noted (D-006) | — | legal; needs a decision before anything public |

The built npm package is separate and already clean: it contains only the program, its licences and a README (tested
for secrets, dev data, `docs/internal` and personal paths in every build).

## Options for the repository

| Option | What happens | Keeps | Costs |
|---|---|---|---|
| A. Publish as is | push the existing history | everything, exactly | items 1, 2, 4, 6 become public, permanently (forks and caches keep them even if removed later) |
| B. Exclude paths from now on | remove items 1 (screenshots), 4 and 6 from the tree, then push | the honest history | the history still contains items 1, 2, 4, 6, so this protects nothing in practice |
| C. Fresh public history (recommended) | create a new repository whose first commit is a reviewed copy of the current tree (sanitised as below); keep this repository, with its full history, private | full history privately; a clean public start | the public history starts at 0.2.0; provenance is stated in docs instead of shown in commits |
| D. Filtered history | rewrite all 76 commits to drop or edit the sensitive paths, then push | most of the history | rewriting is error-prone; commit identities still need changing; produces a second, different history to maintain |

Recommendation: **C**, with these decisions by the owner:
1. **Author identity** for public commits: a GitHub "noreply" address, or the owner's choice.
2. **`docs/internal/`:** publish `PROVENANCE.md` (states that the code is original and how it came about); keep
   `UPSTREAM_TRACKER.md` and milestone notes private, or rewrite them without naming individuals or publishing
   another project's audit results.
3. **Evidence:** publish evidence files after replacing descriptions of the owner's machine with neutral wording, or
   keep `docs/evidence/` private and publish the summaries (`docs/PROGRESS.md`, `docs/ACCEPTANCE_MATRIX.md`).
4. **Screenshots:** use only `site/assets/screens/` (taken from a neutral demo home); drop the four Phase 9 screenshots.
5. **Name:** confirm "Synaptome" after a legal check, or choose another name before the first public commit.

## Owner's decision (2026-11-13): option C

The owner chose **C, a fresh public history**. Applied locally only, with the recommended defaults where the owner
has not decided otherwise (decision D-030):

- `scripts/public-tree.ts` builds the public tree from a committed revision through a temporary index; this
  repository's history, index and working tree are not changed. It leaves out `docs/internal/` and `docs/evidence/`
  (so the four Phase 9 screenshots and every description of the development machine stay private), places the
  overlay `packaging/public/` (a public `docs/internal/PROVENANCE.md` without the upstream record, and
  `docs/evidence/README.md` saying where the evidence is), turns links into the private record into plain text, and
  refuses on a broken relative link, a secret-like string, an identifier of this machine or of the Git author
  (computed at run time), or a binary outside `site/assets/` and `branding/`.
- The tree passes those checks, and `npm ci` plus `npm run ci` pass inside a copy of it with no `.git` and none of
  the private files (`docs/PROGRESS.md`, Phase 12).
- **Author identity (owner, 2026-11-13):** the owner's current Git identity. `public/main` holds one parentless
  commit under it, built from the latest commit of `rebrand/synaptome` (`--commit --replace --author …`; rebuilt the
  same way whenever the private branch moves on before the push).
- **Name (owner, 2026-11-13):** confirmed after the owner's legal check (D-031). Repository `GalHillel/synaptome`
  created private and empty; the local remote `public` pushes only `public/main` → `main`, no tags.
- **Pushed (owner-approved, 2026-11-13).** Later public commits go on top with `--append` and are pushed as fast-forwards.
- **Next, each separately approved:** making the repository public, npm, release, site. Every push sends `public/main` alone (`git push public`, no tags) and so
  carries none of the private history.

## Gated steps after the decision (each needs the owner's approval)

1. Re-check the npm name `synaptome` and the GitHub owner/repository name are free (public lookups).
2. Create the GitHub repository (private first, then public when ready).
3. Push the chosen tree; watch CI (`.github/workflows/ci.yml`) go green on Windows.
4. `npm publish --tag next` (prerelease), install from npm on a clean environment following `docs/QUICKSTART.md`.
5. GitHub release with `docs/RELEASE_NOTES_0.2.0.md`.
6. Publish the site (`npx tsx scripts/site.ts`, then `site/dist/` to a host the owner chooses), with
   `SYNAPTOME_REPO_URL` set to the repository address.

Rollback for each (documented before acting): npm `deprecate` (unpublish only within npm's window), retract the
GitHub release, make the repository private again, take the site down. Forks, caches and package mirrors are outside
anyone's control once something is public; that is why the history decision comes first.
