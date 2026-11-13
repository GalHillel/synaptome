# Synaptome roadmap

Status words used everywhere in this repository:
**VERIFIED** (implemented, tested, and observed working end to end) · **IMPLEMENTED** (code and tests exist, end-to-end
behaviour not yet observed) · **PARTIAL** · **BLOCKED** (with the exact blocker) · **NOT STARTED**.

Current, evidence-backed status lives in [`docs/PROGRESS.md`](docs/PROGRESS.md). This file is the long-term direction.
Nothing here is removed because it falls outside the first milestone.

## Milestone 1 — working foundation (this milestone)

One local system with a canonical registry, two live discovery sources, a quarantine/audit/score pipeline with an
explicit promotion gate, controlled installation with rollback, deterministic routing with one real Claude Code
integration, a first Skill Forge loop with baseline evaluation, and two interfaces (TUI and Web) on the same state.

## Long-term vision (all retained)

| Area | Where it stands after milestone 1 | Next steps |
|---|---|---|
| Autonomous ecosystem discovery | Connector contract, GitHub + MCP registry + local inventory, broad/incremental/need scans, health, history, ranking, overlap flags, evaluation queue, visible schedule plan | More connectors (GitLab, npm/PyPI package signals, vendor plugin marketplaces, curated lists), code search, release-feed watching, security advisory feeds, trend analysis, registered schedules after user opt-in |
| Safe automatic acquisition | Quarantine, static audit, tiers, trust, evidence-based scorecard, promotion gate with deny rules, sandbox auto-install | Sandboxed execution for Tier B, dependency vulnerability data, signature/attestation checks, staged auto-updates with behavioural diff |
| Intelligent task routing | Deterministic analysis + FTS retrieval + graph expansion + explanation; MCP bridge into Claude Code | Learned ranking from recorded outcomes, semantic retrieval where FTS measurably fails, per-host context budgets, conflict resolution from project rules |
| Skill Forge and self-improvement | Gap detection, candidate generation, activation tests, security pass, baseline evaluation, promote/reject | Iterative revision loops, larger eval suites, regression gates on update, lesson capture from sanitized outcomes |
| Multi-agent orchestration | `WorkflowExecutor` contract with a plan-only executor; `AgentProvider` reserved | Agent catalog, team assembly, parallel/sequential/adversarial patterns, result synthesis, escalation |
| Multi-model selection | `ModelProvider` contract with one provider (headless Claude Code) | Provider registry (hosted and local), capability/cost/latency/privacy routing, honest availability states |
| Workflow execution | Execution graph produced and recorded | Real executors per host, checkpoints, resumability, verification steps wired to evaluation |
| Capability graph intelligence | `relations` edge table (alternatives, overlap, contains, requires) | Graph queries in routing and UI, dependency/conflict reasoning, version lineage |
| Cross-platform adapters | Claude Code adapter exercised for real; OpenCode experimental; others declared unsupported | Codex, Gemini CLI, Cursor, VS Code agents, Cline, Roo, Windsurf — each marked VERIFIED only after install/discovery/invocation/update/removal tests |
| Persistent knowledge and memory | Append-only events, decisions, activations, outcomes, gaps | Scoped knowledge store with provenance, confidence and privacy class; optional external sinks (e.g. Obsidian) |
| Continuous evaluation | Evaluation runner, recorded runs with sample sizes | Baseline suites per domain, scheduled regression runs, cost/latency/context metrics |
| Advanced Web and Terminal experiences | Both interfaces on shared state with search, palette, inspectors, queue, security. After Phase 9: 17 screens in each, a capability graph (canvas on the Web, domain tree in the terminal), live updates from one event log, checked in real Windows terminals | Workflow graphs, diff views for updates, macOS/Linux terminal validation, mouse verified in real terminals |
| Brand and distribution | Working name, original identity, name probe | Trademark/domain research, packaging and installer, upgrade and uninstall flows |
