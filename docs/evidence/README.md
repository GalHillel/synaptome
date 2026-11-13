# Evidence

The raw evidence for Phases 0 to 11 (command transcripts, benchmark and measurement output, install matrices, the
clean-room report and terminal screenshots) was recorded in the private development repository and is kept there,
because much of it describes the development machine. Paths under `docs/evidence/` named in `docs/PROGRESS.md`,
`docs/ACCEPTANCE_MATRIX.md` and the other documents refer to that record.

What can be checked here instead:

- the results, summarised per phase in `docs/PROGRESS.md` and per subsystem in `docs/ACCEPTANCE_MATRIX.md`;
- the tests behind each claim (`npm test`; the matrix names them);
- the scripts that produced the measurements: `scripts/perf.ts`, `scripts/clean-room.ps1`, `scripts/tui-matrix.ps1`;
- `npm run ci`, which runs the same release checks as the workflow.

Evidence for releases from 0.2.0 on is recorded here. See `docs/internal/PROVENANCE.md` and decision D-030.
