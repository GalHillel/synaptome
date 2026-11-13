# Skill Forge and evaluation

## Lifecycle

```
gap -> draft -> checked -> evaluated -> promoted | rejected | held -> (revise) -> draft …
```

| Step | Command | What happens |
|---|---|---|
| Open | `synaptome forge new "<gap>" --name <name>` | Creates a workspace with `BRIEF.md`: the gap, the tasks that hit it, and existing alternatives found in the registry and among discovered candidates (search before create). |
| Author | write `SKILL.md`, `evals/activation.json`, `evals/cases.json` | By the host agent or a person. `forge author <id>` asks the model provider instead and reports *blocked* when it is unavailable. |
| Check | `synaptome forge check <id>` | Structural lint (not just "parses": description says when to use it, ≥ 800 characters of body, sections, when-not-to-use, licence, no TODO); security audit identical to imported packages; registers the capability as `registered` (not approved); positive and negative activation tests through the router. |
| Evaluate | `synaptome forge eval <id>` | Same cases with and without the skill, graded by regex (`must` / `mustNot`). Runner: headless model, or `--from <dir>` to grade transcripts produced elsewhere. A blocked runner is recorded as blocked. |
| Decide | `synaptome forge decide <id>` | Applies fixed rules to the recorded evidence. |
| Revise | `synaptome forge revise <id> -r "<reason>"` | Reopens a decided candidate. A promoted skill leaves routing until it passes again; the previous snapshot is kept. |

## Decision rules (`FORGE_RULES`)

- Reject: Tier C; fewer than 80% of positive activation prompts route to it; **any** negative prompt routes to it;
  with-skill pass rate below 70%; no improvement over the baseline.
- Hold: lint, screening, activation or baseline missing; baseline blocked.
- Promote: everything above passes. Promotion then goes through the same eleven-check promotion gate as an
  imported capability, with the evaluation as its effectiveness evidence. The forge cannot bypass the gate.

## Runners

- `model:claude-code-headless` — uses the existing Claude Code login; Synaptome stores no credentials.
- `imported:<label>` — grades files at `<dir>/<variant>/<caseId>.md`. `forge export-evals <id> <dir>` writes the
  prompts. The label is stored so imported results are never mistaken for results Synaptome produced itself.

## Worked example on this machine

Gap `webgl three.js interactive` (recorded by routing, 3 hits) → `forge.webgl-product-configurator`.

1. Brief listed five registry alternatives, including the general `3d-web-experience` skill.
2. Authored by the host agent (the Claude Code session doing this work).
3. Check: structure pass; Tier A, 0 findings; activation 4/4 positive, 5/5 negative.
4. Baseline with the headless runner: **blocked** ("OAuth session expired and could not be refreshed"), recorded.
5. Baseline with imported transcripts from two fresh-context Claude Code subagents (Haiku), one per variant:
   without the skill 4/5, with it 5/5. The baseline answer on accessibility omitted the static fallback.
6. Decision: promote; gate auto-promote (score 96.5); staged in the sandbox host.
7. **Defect found afterwards:** the demo task for a generic SaaS application selected this skill for "Frontend".
   Cause: generic tags and no generic-frontend negative test. Revised: tags tightened, two negative prompts added,
   checks re-run (4/4, 7/7), re-evaluated, re-promoted. The SaaS task no longer selects it.

Evidence is in `docs/internal/milestone-1-evidence/forge-webgl-product-configurator/` (skill, brief, cases, both transcript sets).

## Read this before trusting the numbers

- n = 5 cases per variant. That shows direction, not significance.
- The cases were written by the same author as the skill and check for practices the skill teaches. This favours
  the skill. An independent case set is the obvious next improvement.
- The transcripts came from subagents inside a Claude Code session, which carry that session's system context;
  they are not clean API calls.
- After the revision the same transcripts were re-graded; the skill text changed only in its tags line.

## Self-improvement memory

Routing gaps (`gaps`), activation outcomes (`activations.outcome`) and evaluation runs (`eval_runs`) are the
recorded signals. Turning repeated corrections and failed executions into forge candidates automatically is not
built. Conversations are not stored.
