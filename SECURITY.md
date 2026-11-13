# Security policy

Synaptome treats everything it imports as untrusted: skills, repositories, registry records, scripts, tool metadata
and the instructions inside them. How that is enforced, threat by threat, with the test for each control:
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) and [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md). The most
recent review and its findings: [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md).

## Supported versions

Synaptome is pre-release. Only the latest 0.x release receives security fixes.

## Reporting a vulnerability

Please report privately; do not open a public issue for a vulnerability.

- Use GitHub's private vulnerability reporting on this repository ("Security" tab, "Report a vulnerability").
- Include the version (`synaptome --version`), the operating system, what you did, what happened, and whether the issue
  needs a malicious capability, a malicious web page, or local access.

You will receive an acknowledgement, an assessment, and a fix or a written explanation. Credit is given in the
release notes unless you ask otherwise.

## In scope

- Content from a discovery source causing code execution, a host change, a permission change or a credential leak
  without a person's decision.
- Capability text served to a host causing actions beyond what the person asked for (prompt injection through
  Synaptome).
- The local dashboard or API being reachable or usable from another site, another origin or another Host name.
- Synaptome changing files it did not create, discarding a person's edits, or losing data during upgrade, rollback,
  repair or uninstall.
- Secrets or personal data written to logs, URLs or the published package.

## Known limits (not vulnerabilities)

- The audit is static pattern matching. It can miss obfuscation it has no rule for and flags some security writing
  that quotes attacks; cautionary prose lowers a finding but never hides it.
- Executable capability content is never tested dynamically, because no strong isolation provider is available; it
  always needs a person's approval.
- Upstream releases are pinned and hashed, not signature-verified; capability dependencies are recorded, not checked
  against advisory databases.
- MCP registry entries are metadata; the server code is not fetched or reviewed, and every such candidate says so.
