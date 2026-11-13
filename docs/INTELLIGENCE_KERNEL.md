# Intelligence kernel and host integration

## Routing

**Default since Phase 2: `lexical-graph-v2`** (`packages/router/src/v2.ts`, decision D-011). The v1 description
further down is kept because v1 stays selectable (`synaptome config set routing.strategy lexical-graph-v1`).

### lexical-graph-v2

1. **Intent gate.** Trivial, administrative (rename, commit, open, run…), meta (about the assistant or the session)
   and short lookup questions select nothing. Planning, architecture and design requests are tasks.
2. **Retrieval.** FTS5/BM25 over the task's terms; for prompts over 120 words, the 24 most salient (frequency in the
   prompt × rarity in the registry).
3. **Anchoring.** A capability is considered only if the task names what it is about: a word of its name or tags,
   or two words of one of its own trigger phrases.
4. **Refusals, each with a stated reason.** Built for a language, vendor or framework the task does not name (unless
   the task asks outright for that capability's domain, such as "a database"); `never:` matched; `requires:` not
   met; the capability's own exclusion sentence matches the task.
5. **Confidence** from rarity-weighted evidence; below the floor (0.55) nothing is selected. One matching word is
   never enough. Capabilities that repeatedly failed when served lose confidence.
6. **Selection.** At most four; each further capability must cover a different part of the *work*, not words that
   only occur in an "about …" clause.
7. **Host context.** Summaries only, at most 800 tokens per prompt and 300 per capability, empty when nothing qualifies.

Measured results and their limits: `docs/PROGRESS.md`, Phase 2. Reproduce: `synaptome bench routing --registry`.

### lexical-graph-v1 (milestone 1)

`routeTask(sys, task)` (`packages/router`) is deterministic and uses no model.

1. **Task analysis.** Tokenise; score the task against a domain taxonomy (`packages/core/src/taxonomy.ts`);
   classify complexity (trivial, small, medium, large) from scope words, domain count and length; flag elevated
   sensitivity.
2. **Direct-match pass.** A capability whose own name, description and tags cover at least three distinctive task
   terms and 40% of them is selected regardless of domain. This is how
   "Write a 3P status update for leadership" finds `internal-comms`.
3. **Domain passes.** For each recognised domain: full-text search on that domain's matched keywords, then a
   relevance rule: rarity-weighted coverage of the keywords ≥ 0.34 and at least one non-weak keyword hit. Rarity is
   inverse document frequency across the registry, so matching `webgl` counts for more than matching
   `interactive`. Domains matched only by weak words (`fix`, `product`, `service`, …) select nothing.
4. **Eligibility.** Only approved capabilities, and skills already installed on the host, can be selected.
   Unapproved, blocked and rejected matches are listed under *excluded* with the reason.
5. **Conflicts.** Capabilities with the same name or an `overlaps` relation are not selected together.
6. **Budget.** Complexity caps the count (1, 2, 4, 7); an estimated 15,000-token context budget drops the weakest.
7. **Gaps.** A strong domain with no eligible capability is recorded in `gaps` and counted on repeats.
8. **Plan.** Selections grouped by stage (research, design, build, verify, ship, document) with a verification line.

`synaptome route "<task>" --explain` prints the decision. `--discover` runs need-driven scans for the gaps.
Every decision is stored (`synaptome decisions`, `decisions <id>`).

### Known weaknesses

It is lexical. On the 1,000-skill registry of the development machine it gives sensible results for clearly
worded tasks and plainly weaker ones elsewhere (for the SaaS demo task it picks `webapp-testing` for the frontend
part). It does not understand synonyms, and domain inference for a capability comes from its own description.
Model-assisted routing is designed as an alternative `RoutingStrategy` and is not built.

## Activation

`activate` serves one capability's entry file for one decision and records it (`activations`: decision,
capability, host, bytes, outcome). `recordOutcome` stores success, partial or failed. The served text is prefixed
with a notice that it is reference guidance and that the user's instructions take precedence.

## Host integration surfaces (Claude Code)

| Surface | What it does | Deterministic? | Status |
|---|---|---|---|
| MCP server `synaptome mcp` | `route_task`, `get_capability`, `search_capabilities`, `record_outcome` | The model decides to call it | VERIFIED: used from a live Claude Code session (decision #28, activations 3–4, outcome recorded) |
| Bridge skill (project `.claude/skills/synaptome`) | Tells the model to route first | No | Loaded by the host; **not** triggered unprompted in the one fresh-agent test |
| `UserPromptSubmit` hook `synaptome hook user-prompt` | Routes every prompt and injects the top capability as additional context; silent for trivial prompts | Yes, once configured | IMPLEMENTED and installed by `bridge init`; tested through the real CLI with host-shaped payloads (`apps/cli/test/bridge.test.ts`); **not yet observed in a live session** |

`synaptome bridge init <project>` writes `.mcp.json`, the bridge skill, and one `UserPromptSubmit` entry in the
project's `.claude/settings.local.json` (the project-local settings file, not the shared `settings.json` and never
the global one). `--no-hook` skips the hook. `bridge remove <project>` deletes exactly what was added and leaves
any other settings and hooks in that file untouched; a settings file that cannot be parsed is never modified.

The hook adds roughly 0.3 s to each prompt (one Node start plus a database query). For a prompt that routes, it
injects up to two capabilities within about 6,000 tokens; larger ones are referenced by path instead.

### What was and was not proven

- Proven: Claude Code loads the project-scoped MCP server and skill; a real session routed a real task through
  MCP, received two capabilities, applied them and recorded the outcome.
- Not proven: that a fresh session routes **without being told to**. One fresh-context agent given only a writing
  task, with the bridge skill present, completed it with a single `Write` and never called Synaptome. With more
  than a thousand skills in the listing, description-based triggering is unreliable on this machine.
- Blocked: the clean test (`claude -p` in a throwaway project with only the bridge) fails with "Failed to
  authenticate: OAuth session expired and could not be refreshed". A separate desktop session could not be started
  from a Remote Control session.

Prove it once `claude` is logged in (one command; it runs a single headless prompt that names no skill and
checks whether the hook served a capability):

```bash
synaptome bridge init <project-dir>
synaptome bridge verify <project-dir>
```

It prints `VERIFIED` (the hook served a capability), `VERIFIED-VIA-MCP` (the model called the tools itself),
`NOT-TRIGGERED`, or `BLOCKED` with the host's own error. On the development machine it currently prints
`BLOCKED: Failed to authenticate: OAuth session expired and could not be refreshed`. Whether Claude Code accepts
project-local hooks without an extra trust prompt in headless mode is therefore also unobserved.

## Agent and model orchestration

Not built. `WorkflowExecutor` has one implementation that returns the execution graph and leaves execution to the
host agent. `ModelProvider` has one implementation (headless Claude Code). `AgentProvider` is reserved. See
`ROADMAP.md`.
