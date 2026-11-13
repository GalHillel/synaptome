# Security model

How Synaptome keeps third-party capability content from running, spreading or gaining permissions without a
person's decision. Privacy and the risk register are in `PRIVACY_AND_RISKS.md`; threats, findings and their status
are in `THREAT_MODEL.md`. Every control below names its test.

## Assumptions

- Everything fetched from a source is hostile until shown otherwise: skill text, scripts, manifests, MCP registry
  records, licence files and update notes.
- Synaptome never executes acquired content. The only code it runs is its own.
- The person using Synaptome is trusted; content that addresses an AI reader ("ignore previous instructions") is not.
- The hosts (Claude Code, OpenCode) are trusted to do what their documentation says, nothing more.

## Controls, in pipeline order

| Stage | Control | Where | Test |
|---|---|---|---|
| Discovery | robots.txt and terms per source; blocked sources are never queried; backoff and request budgets | `packages/discovery/src/sources.ts` | `sources.test.ts` |
| Download | pinned commit or version; size and file-type limits; files written only under `<home>/quarantine/<candidate>` with path normalisation | `packages/connectors`, `writeTree` | `connectors.test.ts`, `core.test.ts` |
| Audit | static rules for prompt injection, concealment, tool poisoning, exfiltration (incl. markdown images), pipe-to-shell, reverse shells, remote code, self-granted permissions, hidden Unicode and direction marks, packed JS, credential reads combined with outbound sends; defensive-context handling to avoid flagging security documentation | `packages/security/src/index.ts` | `corpus.test.ts`: 26/26 malicious blocked, 0/15 benign blocked |
| Licence and supply chain | SPDX expressions; licence evidence; declared dependencies recorded; update inspection flags licence, permission, executable and publisher changes | `packages/security`, `inspectUpdate` | `supply.test.ts`, `dependencies.test.ts`, `install-matrix.test.ts` (publisher) |
| Tiering | A declarative / B executable or networked / C critical. C never leaves quarantine | `auditPackage` | `acquisition.test.ts` |
| Gate | 15 checks, every one needs evidence; unknown counts as failing; policy rules as data that can only tighten; executable content needs an isolated dynamic test that does not exist yet, so it always needs a person | `promotionPolicy`, `packages/acquisition/src/policy.ts` | `policy.test.ts` |
| Isolation | Windows Sandbox, Docker or Podman are probed; none is present on the development machine, so dynamic tests are BLOCKED. Node's permission model and child processes are not treated as isolation | `probeIsolation`, `dynamicTestCheck` | `policy.test.ts` |
| Install | sandbox host first; real host only with explicit confirmation, a verified staged install of the same content, and a budget (default 1); never overwrites content Synaptome did not create; per-location lock; one live installation per location; fingerprint; exact revert on failure | `install` | `install-matrix.test.ts` (18), `adapter-kinds.test.ts` (20) |
| Hosts | only documented locations; MCP servers only into a named project's `.mcp.json`, never `~/.claude.json`; secrets as `${VARIABLE}` references; no unpinned packages, no plain-http endpoints; global host configuration is never edited | `packages/adapters` | `adapter-kinds.test.ts` |
| Removal | rollback and uninstall refuse when installed files were edited afterwards; `--force` keeps a copy; rollback restores from a verified backup or the stored snapshot, or refuses before changing anything | `removeInstall` | `install-matrix.test.ts` |
| Routing | hosts receive short summaries labelled as reference material beneath the user's instructions; blocked or unapproved capabilities are never offered; budgets cannot be raised by capability content | `packages/router` | `v2.test.ts`, routing benchmark |
| Local service | loopback bind, per-start token sent in a header (also for the event stream, which is a fetch stream; no token in URLs, D-010), Host and Origin allow-lists, `sec-fetch-site` check, CSP with `frame-ancestors 'none'` | `packages/service` | `service.test.ts` (every command refuses a missing token, a foreign origin, a foreign Host) |

## What is not covered yet

- Dynamic testing of executable content (needs an isolation provider on the machine; the gate stays BLOCKED).
- Dependency advisories (dependencies are recorded, not checked against advisory databases).
- Signature verification of upstream releases (provenance is a pinned ref over HTTPS, not a signature).
- A written threat model with every finding fixed or accepted (Phase 11).

## Reporting a vulnerability

Until the project has a public home, report privately to the maintainer. The public `SECURITY.md` with a contact and
response policy is a Phase 12 deliverable.
