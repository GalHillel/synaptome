# Black-box acceptance tests

`npm run test:blackbox` builds the package once (or uses `SYNAPTOME_DIST`, for example an unpacked published tarball)
and runs these tests against it.

Rules:

- Drive only the built program: its command line, its HTTP API and the files it writes. Never import product source.
- Write expectations from the documented behaviour (`docs/`, `docs/MASTER_PLAN_NG.md`), not from the implementation.
- Every home, project and Claude root is a disposable folder (`harness.ts`). The developer's real ones are never used.
- A confirmed defect is reproduced with `it.fails('KNOWN DEFECT <id>: …')`: the test asserts the correct behaviour and
  currently fails. When the fix lands it passes, `it.fails` reports that, and the test is changed to `it`.
- Fault injection (for example writing a newer schema version into a database file) is allowed; it uses Node's own
  `node:sqlite`, not product code.

Defect IDs refer to the audit in `docs/MASTER_PLAN_NG.md` (B = bridge, H = hook, W = workflows, S = source status,
R = routing).
