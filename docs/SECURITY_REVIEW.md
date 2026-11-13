# Security review (Phase 11)

Date: 2026-11-13. Scope: the repository at the commit that adds this file, its full git history (72 commits), its npm
dependency tree (277 packages), and the built package (`npm run build`). Threats and their status:
`docs/THREAT_MODEL.md`. Controls: `docs/SECURITY_MODEL.md`.

## Dependency vulnerabilities (`npm audit`)

| Package | Severity | Shipped? | Advisory | Resolution |
|---|---|---|---|---|
| zod 3.25.76 | high | **yes** (bundled into `cli.mjs`, used to validate capability records and workflow definitions) | GHSA-mrhx-c7xc-m3w5: memory exhaustion while validating oversized constrained collections | Upgraded to zod 4.6.7 (major); schema adapted (`.prefault({})` for nested object defaults, two-argument `z.record`); all tests pass |
| vitest 3.2.7 | critical (via tinypool) | no (test runner) | GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr (tinypool prototype pollution to code execution); GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8 (@vitest/mocker) | Upgraded to vitest 5.1.0 (major); suite unchanged and green |

After: `npm audit` reports **0 vulnerabilities** (277 dependencies).

## Secrets and personal data

No secret scanner is installed on the machine (gitleaks absent), so the same patterns were applied with a script to
every tracked file and to the full patch history (`git log -p --all`, 2.96 MB): GitHub tokens (classic and fine-grained),
Anthropic and OpenAI keys, AWS access keys, private-key blocks, Slack tokens, Google API keys, and quoted
`password`/`secret`/`api_key` assignments; plus the owner's user folder, user name and e-mail address.

| Finding | Where | Resolution |
|---|---|---|
| No credential of any kind | tracked files and all history | — |
| A key-shaped string | `packages/providers/test/providers.test.ts` (`sk-test-0123456789abcdef`) | A fake value, used to prove keys are never logged. Kept |
| The owner's e-mail address | nowhere | — |
| The owner's user-folder path | `docs/MASTER_PLAN.md` (1, tracked) | Removed from the tracked file |
| The owner's user-folder path | history: `docs/evidence/demo-trace.txt` (14, a file no longer in the tree) and the earlier `docs/MASTER_PLAN.md` (1) | **Open, for the Phase 12 publication review:** history can only be cleaned by rewriting it, which needs the owner's approval |
| Paths under the owner's user folder visible in images | `docs/evidence/phase-9/tui-*.png` (4 screenshots of the development data) | **Open, Phase 12:** retake public screenshots from a neutral demo home; the existing ones are in history |
| The built package | `build.test.ts` scans every packed file for token shapes, dev-data folder names, `docs/internal`, the repository path and the user's home path | 0 in each build |

## Licences of shipped code

`scripts/licenses.ts` reads what the build actually bundled (`dist/build-info.json`) and writes
`THIRD_PARTY_LICENSES.md` with each package's licence and full licence text; it fails on a licence outside the
allow-list (MIT, ISC, Apache-2.0, BSD-2/3-Clause, 0BSD, BlueOak-1.0.0, CC0-1.0, Unlicense); the build runs it and stops
on a violation. Result: **39 bundled packages, 38 MIT and 1 ISC**, all allowed. Two of them ship no licence file in
their npm package (`@alcalzone/ansi-tokenize`, `yoga-layout`); their `package.json` declares MIT, which the inventory
records with the author and repository. Synaptome's own code is Apache-2.0 (D-002): `LICENSE` (the canonical Apache
2.0 text) and `NOTICE` are in the repository root and in the package.

## Code review findings

| Finding | Severity | Resolution |
|---|---|---|
| Model name and program path of the headless Claude Code provider reached `cmd.exe` without quoting (settings → shell) | medium (local: needs write access to settings) | Fixed: refused unless they match strict patterns; test |
| `upgrade` npm fallback passed the user's spec through a shell | low (the person typing the command is the source) | Fixed: refused when it contains shell syntax |
| The local API returned 500 for an unknown source id | low | Fixed: 404 (found by fuzzing) |
| Refusals were sent before the request body was read; a client could see a reset instead of the 4xx | low (robustness; the dashboard relies on seeing 401 for a stale token) | Fixed: the body is drained (1 MB cap) before any refusal (found by fuzzing) |
| A scan stopped by a rate limit was reported as completed | low (misleading) | Fixed in Phase 10: `partial` with the reason |
| A refused database open kept the file locked | low | Fixed in Phase 10 |
| `SECURITY_MODEL.md` described the event stream as cookie-authenticated | documentation | Fixed: header-authenticated fetch stream (D-010) |

## Robustness testing

- Parser fuzzing (`packages/security/test/fuzz.test.ts`): 7,100 random and hostile inputs plus pathological shapes to
  the front-matter parser, licence detection, SPDX expressions, dependency extraction and the audit; no exception, each
  within its time bound (no catastrophic backtracking).
- HTTP API fuzzing (`packages/service/test/fuzz.test.ts`): 600 random requests without valid credentials (methods,
  paths, Host and Origin values, token variants, malformed bodies, `?token=` URLs) — none succeeded, no server error;
  random arguments to every local command with valid credentials — no 500; the server kept answering.
- Concurrency (`apps/cli/test/stress.test.ts`): 6 processes as different interfaces writing at once (settings, events,
  racing installs and rollbacks of the same capability into one sandbox host): no unexpected error, no lost event,
  database integrity ok, at most one live installation, and a live watcher saw every committed event once, in order.

## Open, with release impact

- History and screenshots containing the owner's user-folder path: Phase 12 publication review (approval needed).
- No signature verification of upstream capability releases; no advisory database for capability dependencies
  (documented limitations, `THREAT_MODEL.md` T-04).
- The package is not yet signed or provenance-attested (needs publishing, Phase 12).
- Dynamic testing of executable capability content stays BLOCKED without an isolation provider (D-020).
