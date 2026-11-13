# Synaptome 0.2.0 — release notes (pre-release)

The first release under the name Synaptome. It is a pre-release: Windows is the tested platform, and the items under
"Known limits" are real. Full list of changes: [`CHANGELOG.md`](../CHANGELOG.md).

## Highlights

- **Install and manage it like a product.** One npm package with no dependencies; `synaptome init` sets up and
  verifies; `repair`, `upgrade` (with `--rollback`) and `uninstall --everything` manage it afterwards without ever
  discarding your edits or deleting data you did not ask to delete.
- **Discover and vet capabilities.** Nine sources (GitHub, the official MCP registry, npm, PyPI, GitLab, official skill
  repositories, curated lists, your installed Claude Code skills; skills.sh registered as blocked by its terms), each
  within its terms, backoff and daily budget. Everything downloaded is quarantined and audited; executable content
  needs a person.
- **Install with a way back.** Skills, agents, commands and MCP entries for Claude Code, into a sandbox copy first; a
  real install needs explicit confirmation; every install can be rolled back exactly.
- **Route tasks without flooding the host.** A project's Claude Code asks Synaptome which capabilities fit a task and
  gets short summaries, within a token budget, and nothing at all for trivial prompts.
- **Build and test new skills.** The Skill Forge turns a routing gap into a skill and promotes it only on held-out
  evidence from an independent author.
- **Run workflows and agent teams.** Workflows run from the database with approvals, retries and resume; specialist
  agents run as workflow steps with budgets and traces.
- **Three interfaces on one state.** A terminal workbench, a web command center on loopback, and a CLI with JSON output;
  a change made in one appears in the others.

## Upgrading from DRELQAVO

A home written under the previous name is never opened in place. `synaptome migrate` copies it to a new home and
verifies it; the original is untouched ([`docs/MIGRATION.md`](MIGRATION.md)).

## Known limits

- Tested on Windows only; macOS and Linux are expected to work and are unverified.
- Executable capability content is never tested dynamically (no isolation provider); it always needs approval.
- Of the model providers, only headless Claude Code is verified by a live call; the others are implemented and
  contract-tested.
- Whether a host model loads a capability it was offered without being asked is not yet observed.
- At 50,000 capabilities, overview, search and routing take a few hundred milliseconds ([`PERFORMANCE.md`](PERFORMANCE.md)).

## Security

Threat model, review and reporting: [`THREAT_MODEL.md`](THREAT_MODEL.md), [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md),
[`../SECURITY.md`](../SECURITY.md).
