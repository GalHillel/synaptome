# Project charter

## Purpose

Give AI agents one trustworthy capability layer: know what exists, know what is safe, install only what is
justified, use the right thing for each task, and learn from recorded results.

## Principles (in order when they conflict)

1. Security before autonomy. Nothing imported is trusted until audited; autonomy acts only inside explicit policy.
2. Evidence over claims. Stars, downloads and descriptions are not quality. Unknown is never a pass.
3. Quality over quantity. A small tested set beats a large untested one.
4. Local first. State, configuration and project knowledge stay on the machine.
5. Progressive loading. A large registry must not become a large prompt.
6. Deterministic where possible. Models are used where judgement adds value, not for bookkeeping.
7. No unnecessary infrastructure. One database file, one process model.
8. Honest reporting. Designed, implemented and verified are three different words.

## Scope of milestone 1

A working vertical slice of each core subsystem on Windows with Claude Code: discovery from two independent
sources, acquisition with a promotion gate, controlled installation with rollback, deterministic routing with host
integration surfaces, a Skill Forge loop with a measured baseline, and two interfaces on shared state.

## Out of scope for milestone 1

Multi-model routing, multi-agent execution, real workflow execution, adapters for hosts not present on the
development machine, macOS/Linux validation, packaging, legal name clearance. They remain on the roadmap.

## Standing constraints from the owner

- The Git repository is the source of truth for progress, decisions, architecture and evaluations.
- No global host configuration changes. One real skill install was authorised for verification and has been rolled
  back; the real-install budget stays at 1 until raised deliberately.
- No third-party proprietary code is copied into this codebase. Upstream projects are tracked as discovery sources
  and ingested through the same audit pipeline as anything else (`docs/internal/PROVENANCE.md`).
- Nothing is pushed to any remote without an explicit instruction.

## Decision log

Architecture decisions and their reasons are recorded in `docs/ARCHITECTURE.md` ("Decisions"). Deviations from the plan
are recorded in `docs/PROGRESS.md`.
