# Provenance, licensing and naming history

## The code

Synaptome's source code was written for this project. It contains no code, text, assets or structure copied from
any other project. Third-party packages it depends on are listed, with their licences, in `THIRD_PARTY_LICENSES.md`.

## How it came about

The project began as research into how AI coding hosts load skills, agents and MCP servers, and how much context
that costs. Part of that research was auditing existing public skill collections with the same pipeline Synaptome
now ships. Nothing from those collections is included here; they are discovery sources like any other, and anything
discovered at runtime stays on the user's machine (see below).

## Naming history

| Period | Name | Notes |
|---|---|---|
| first milestone | DRELQAVO | Coined working name. Legacy names remain only in the migration code, the deprecated `drelqavo` launcher, tests of the migration and `CHANGELOG.md`. |
| considered | Synapse OS | Rejected: collides with an active package of the same category and with existing marks. |
| from 0.2.0 | Synaptome | Preliminary clearance in `docs/NAMING_CLEARANCE.md`; decisions D-001 and D-006 in `docs/DECISIONS.md`. |

## Third-party content handled at runtime

Capabilities discovered from GitHub, the MCP registry, package registries and the local host are downloaded to the
user's own machine, audited, and stored in the user's data directory. None of them is bundled with the product. Each
keeps its own licence, and the acquisition gate refuses unknown or incompatible licences.

## Licence

Apache License 2.0 (`LICENSE`, `NOTICE`), decision D-002.

## Where the history is

This repository's public history starts at version 0.2.0 (decision D-030). Development before that — the first
milestone and Phases 0 to 11 of `docs/MASTER_PLAN.md` — took place in a private repository that is kept unchanged.
Its raw evidence files (command transcripts, measurement output, terminal screenshots taken on the development
machine) and internal milestone notes stay there; their results are summarised in `docs/PROGRESS.md` and
`docs/ACCEPTANCE_MATRIX.md`, and the scripts and tests that produced them are in this repository. Paths under
`docs/evidence/` and `docs/internal/` named in those documents refer to that private record.
