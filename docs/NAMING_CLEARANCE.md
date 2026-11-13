# Naming clearance

Preliminary, non-legal clearance performed 2026-11-11/12 with public lookups only. Nothing was purchased or
registered. Final legal validation is a release gate (master plan, Phase 12).

## 1. "Synapse OS" — rejected

| Where | Finding |
|---|---|
| npm `synapse-os` | Taken. Active (v0.5.0, 2026-08-30), "local-first long-term memory for AI agents, over MCP", GPL-3.0. Same category. |
| npm `synapse`, `synapse-cli` | Taken. `synapseos` free. |
| GitHub | 146 repositories named synapse-os / SynapseOS, including "The operating system for autonomous AI organizations", an Arch-based "AI OS", two hobby kernels, a `SynapsesOS` organisation. |
| Established marks | Azure Synapse (Microsoft), Razer Synapse, Matrix Synapse, TDT Synapse; USPTO returns 267 records for the word SYNAPSE. |

Decision (owner, 2026-11-11): do not use Synapse OS. Product name: **Synaptome**.

## 2. "Synaptome" — preliminary result

"Synaptome" is an existing neuroscience term (the full set of synapses of a brain or region). It is used
descriptively by research groups; no software product of that name was found.

| Where | Method | Result |
|---|---|---|
| USPTO | Trademark Search API, wordmark query `synaptome` and `synaptome*`; control query `synapse` returned 267 | **0 records** |
| USPTO, near names | wordmark `synaptom*` | **1 record: SYNAPTOMIX** (see section 3) |
| Trademarkia aggregate | site search | 0 results |
| EUIPO / TMview | API request | **Not checked**: request rejected by the site's bot protection |
| WIPO Global Brand Database | — | **Not checked**: interactive, captcha-protected |
| Israeli trademark register | — | **Not checked**: no programmatic access |
| Web search for products/companies | two searches | No company or product named Synaptome found |
| npm `synaptome` | registry | 404, free |
| npm scope `@synaptome` | registry search `scope:synaptome` | 0 packages. Whether the org name itself can be created is only known at creation time. |
| PyPI, crates.io, RubyGems | registries | 404, free |
| Docker Hub user / library image | API | 404, free |
| GitHub user/org `synaptome` | API | **Taken**: empty personal account created 2026-09-25, 0 repositories. Free alternatives seen: `synaptome-dev`, `synaptome-os`, `synaptomehq`, `getsynaptome`, `synaptome-ai`. |
| GitHub repositories named synaptome | search | 21, all small (top 8 stars), almost all neuroscience data/code; two unrelated small tools (research-metrics library, live-visuals runtime) |
| Domains (RDAP) | lookup only | `.com` registered since 2006; `.ai` registered and listed for sale; `.org` and `.app` registered; **`.dev`, `.io`, `.sh` unregistered** |

## 3. Item needing an owner decision: SYNAPTOMIX

| Field | Value |
|---|---|
| Mark | SYNAPTOMIX (standard character, service mark) |
| USPTO serial | 99306765 |
| Owner | Morphomix LLC (Delaware LLC, Illinois) |
| Filed | 2025-07-28, basis 1(b); published for opposition 2026-01-13 |
| Status | Live, not yet registered: "Statement of use – to examiner" |
| Class | IC 042: computer programming, software design and development, technology consultation including artificial intelligence |

Assessment (not legal advice): the marks are not identical, and "synaptome" is a dictionary term in
neuroscience, which weakens exclusivity. But SYNAPTOMIX shares the first nine letters, is live, and covers
software and AI services, the same field. Whether that creates a likelihood of confusion is a legal
judgement that this check cannot make. It is recorded here as an unresolved risk.

## 4. Alternatives generated for the first decision

npm-free at check time (GitHub repository counts in brackets): Synaptome (21), Synaptor (11), Synaptogen (11),
Saltatory (9), Arborize (8), Myelinos (1), Engramos (4), Telodendron (0), Perikaryon (1), Varicosity (4),
Neuroplex (12), Synaptos (15), Dendros (42), Axonos (50), Neuroglia (43), Synaptix (356), Synaptica (115),
Synaptiq (127), Axona (229), Neurite (111). Excluded for known existing companies: AxonIQ.
USPTO wordmark check of the leading alternatives (exact, then first-seven-letters prefix):

| Name | Exact | Near |
|---|---|---|
| Saltatory | 0 | 0 |
| Telodendron | 0 | 0 |
| Myelinos | 0 | 0 |
| Engramos | 0 | 0 |
| Perikaryon | 0 | 0 |
| Synaptor, Synaptos | 0 | 16 `SYNAPTO*` records, one live in class 42 (SYNAPTOMIX) |
| Synaptogen | 1 dead (class 10) | same 16 |
| Arborize | 1 dead (class 44) | — |
| Neuroplex | 8, two live (classes 1, 5) | 43 |

Every `Synapto…` name sits next to SYNAPTOMIX; Synaptome is the closest of them. The other registers were not checked for any alternative.

## 5. Open items for the release gate

- EUIPO, WIPO and Israeli register searches by a person or counsel.
- Decision on the GitHub namespace (the bare handle is taken).
- Decision on a domain (lookup only so far).
- npm name and scope availability re-checked immediately before anything is reserved.
