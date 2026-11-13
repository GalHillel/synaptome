# Synaptome

A local-first capability layer for AI coding hosts. Synaptome discovers skills, agents and MCP servers from public
sources, audits them before anything can run, keeps one registry on your machine, installs only what you approve (with
rollback), and routes each task to the few capabilities that fit it, so a host loads summaries instead of everything.

Everything runs on your machine. Nothing is installed into an AI host until you ask, and installs go to a sandbox copy
of the host directory first.

## Requirements

- Node.js 24 or later (Synaptome uses the built-in `node:sqlite`).
- Windows is the tested platform. macOS and Linux are expected to work and are not yet verified.

## Start

```
synaptome            # Terminal Workbench
synaptome dashboard  # Web Command Center on 127.0.0.1 (its access token is placed in the page, never in the URL)
synaptome status     # what is in the registry, what is installed, what needs a decision
synaptome doctor     # checks (exit 1 when a check fails)
```

Data lives in one folder: `%LOCALAPPDATA%\synaptome` on Windows, `~/.synaptome` elsewhere, or wherever
`SYNAPTOME_HOME` / `--home` points.

## Typical use

```
synaptome inventory                      # index and audit the skills already installed for Claude Code (read only)
synaptome scan                           # discover candidates from the enabled sources
synaptome evaluate --next 1              # quarantine, audit, score and gate the next queued candidate
synaptome approve <capability>           # approve (does not install)
synaptome install <capability>           # install into a sandbox copy of the host
synaptome install <capability> --real --yes   # then into the real host directory
synaptome rollback <installation>        # put back exactly what the install replaced
synaptome route "describe a task"        # which capabilities fit, and why
synaptome bridge init <project folder>   # connect one project's Claude Code to Synaptome (project files only)
```

`synaptome --help` lists every command; `--json` gives machine-readable output.

## Safety

- Downloaded content is quarantined, never executed and never read as instructions.
- A capability that fails the security audit is blocked from routing and installation.
- Hosts get summaries; full instructions are loaded only when the host asks for one capability.
- Global Claude Code configuration is never changed; `bridge init` writes only into the project you name.
