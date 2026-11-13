import fs from 'node:fs';
import path from 'node:path';
import { type Deps, type GateOutcome, install, promotionPolicy, recordGate, runFunctionalTests, storeAudit, storeScore } from '@synaptome/acquisition';
import {
  type EvalCase, type EvaluationRunner, type FetchedFile, type ModelProvider, type Sys,
  emit, estimateTokens, getCapability, hashFiles, inferDomain, j, listCandidates, listCapabilities, nowIso, parseFrontmatter, pj, readTree, slug, transitionCapability, upsertCapability, writeSnapshot,
} from '@synaptome/core';
import { type CaseInput, type EvalSummary, addEvalCases, listEvalCases, recordEval, summarize, toEvalCase } from '@synaptome/evaluation';
import { lexicalGraphStrategy } from '@synaptome/router';
import { auditPackage, scorePackage } from '@synaptome/security';

/**
 * Skill Forge. Lifecycle of a forged candidate:
 *   draft -> checked -> evaluated -> promoted | rejected | held  (promoted -> deprecated; promoted -> rolled back)
 * A candidate is never "useful" because its files parse: it must pass structural lint, a security
 * screen, positive AND negative activation tests, and a measured comparison against a baseline on
 * HELD-OUT cases that the run which wrote it did not write.
 */

export type ForgeState = 'draft' | 'checked' | 'evaluated' | 'eval-blocked' | 'promoted' | 'rejected' | 'held' | 'deprecated';
export interface ForgeVersion {
  contentHash: string;
  promotedAt: string;
  heldout: { withSkill: number; baseline: number; n: number };
  train: { withSkill: number; baseline: number; n: number } | null;
}

export interface ForgeCandidate {
  id: string;
  gap: string | null;
  name: string;
  state: ForgeState;
  path: string;
  capabilityId: string;
  record: {
    domain: string;
    author: string;
    alternatives: { id: string; name: string; where: 'registry' | 'discovered'; note: string }[];
    lint?: { ok: boolean; problems: string[] };
    audit?: { tier: string; critical: number; high: number; summary: string };
    activation?: { positives: { prompt: string; passed: boolean }[]; negatives: { prompt: string; passed: boolean }[]; positiveRate: number; negativeRate: number };
    baseline?: { status: 'completed' | 'blocked'; runner: string; blocker?: string; summary?: EvalSummary; splits?: { train: EvalSummary | null; heldout: EvalSummary | null }; contentHash?: string; evalId: number };
    gate?: { decision: string; failed: string[] };
    /** The run that wrote SKILL.md; it may not author held-out cases. */
    generatedBy?: string;
    /** Promoted versions, newest last, with the held-out evidence each was promoted on. */
    versions?: ForgeVersion[];
  };
  decision: { verdict: 'promote' | 'reject' | 'hold'; reasons: string[]; at: string } | null;
  createdAt: string;
  updatedAt: string;
}

export class ForgeError extends Error {
  constructor(public code: 'not-found' | 'invalid' | 'state', message: string, public hint?: string) {
    super(message);
  }
}

const map = (r: any): ForgeCandidate => ({ id: r.id, gap: r.gap, name: r.name, state: r.state, path: r.path, capabilityId: `forge.${r.name}`, record: pj(r.record, { domain: 'general', author: 'unknown', alternatives: [] }), decision: pj(r.decision, null), createdAt: r.created_at, updatedAt: r.updated_at });
export const listForge = (sys: Sys): ForgeCandidate[] => sys.db.all<any>('SELECT * FROM forge_candidates ORDER BY created_at DESC').map(map);
export function getForge(sys: Sys, id: string): ForgeCandidate {
  const r = sys.db.get<any>('SELECT * FROM forge_candidates WHERE id=? OR name=?', id, id);
  if (!r) throw new ForgeError('not-found', `No forge candidate "${id}"`, 'list them with: synaptome forge list');
  return map(r);
}
function save(sys: Sys, c: ForgeCandidate) {
  sys.db.run('UPDATE forge_candidates SET state=?, record=?, decision=?, updated_at=? WHERE id=?', c.state, j(c.record), j(c.decision), nowIso(), c.id);
}

/* ---------- 1. gap -> draft workspace ---------- */

export function forgeNew(sys: Sys, input: { gap: string; name?: string; author?: string }): ForgeCandidate {
  const gapRow = sys.db.get<any>('SELECT * FROM gaps WHERE term=? OR CAST(id AS TEXT)=?', input.gap, input.gap);
  const gapTerm: string = gapRow?.term ?? input.gap;
  const name = slug(input.name ?? gapTerm).slice(0, 48);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new ForgeError('invalid', `Cannot derive a valid skill name from "${input.name ?? gapTerm}"`);
  if (sys.db.get('SELECT 1 FROM forge_candidates WHERE name=?', name)) throw new ForgeError('state', `A forge candidate named "${name}" already exists`);
  const domain = gapRow?.domain ?? inferDomain(gapTerm);

  // Search before creating: is an existing or already-discovered capability the better answer?
  const alternatives: ForgeCandidate['record']['alternatives'] = [
    ...listCapabilities(sys, { q: gapTerm, limit: 5 }).items.filter((c) => c.status !== 'blocked' && c.status !== 'rejected').map((c) => ({ id: c.id, name: c.name, where: 'registry' as const, note: `${c.status}, quality ${c.quality ?? 'n/a'}` })),
    ...gapTerm.split(/\s+/).flatMap((t) => listCandidates(sys, { q: t, limit: 4 }).items).filter((c, i, a) => c.sourceId !== 'local-claude' && !c.capabilityId && a.findIndex((x) => x.id === c.id) === i).slice(0, 6).map((c) => ({ id: c.id, name: c.name, where: 'discovered' as const, note: `${c.state} via ${c.sourceId}, rank ${c.rank}` })),
  ];
  const tasks = sys.db.all<{ task: string }>("SELECT task FROM route_decisions WHERE gaps LIKE ? ORDER BY id DESC LIMIT 5", `%${gapTerm}%`).map((r) => r.task);

  const id = `f-${slug(name)}`;
  const dir = path.join(sys.paths.forge, id);
  fs.mkdirSync(path.join(dir, 'evals'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'BRIEF.md'),
    [`# Forge brief: ${name}`, '', `Gap: **${gapTerm}** (domain ${domain}${gapRow ? `, seen ${gapRow.hits} time(s)` : ''})`, '', '## Tasks that hit this gap', ...(tasks.length ? tasks.map((t) => `- ${t}`) : ['- (none recorded; the gap was entered manually)']), '', '## Existing alternatives found (check these before writing anything new)', ...(alternatives.length ? alternatives.map((a) => `- ${a.where}: ${a.name} [${a.id}] — ${a.note}`) : ['- none']), '', '## What to produce', '- `SKILL.md`: front-matter (name, description with "Use when…", license), concrete workflow, decision rules, pitfalls, and when NOT to use it.', '- `evals/activation.json`: at least 3 positive and 3 negative task prompts.', '- `evals/cases.json`: at least 3 cases, each with a prompt and `must` / `mustNot` regex graders that a correct answer satisfies and a generic answer would likely miss.', '', 'Do not copy text from the alternatives above; they are listed for comparison only.'].join('\n'),
  );
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: TODO one or two sentences. Say what it does and "Use when …".\nlicense: MIT\n---\n# ${name}\n\nTODO write the skill. See BRIEF.md.\n`);
  fs.writeFileSync(path.join(dir, 'evals', 'activation.json'), JSON.stringify({ positive: [], negative: [] }, null, 2));
  fs.writeFileSync(path.join(dir, 'evals', 'cases.json'), JSON.stringify([], null, 2));
  const now = nowIso();
  sys.db.run('INSERT INTO forge_candidates (id, gap, name, state, path, record, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, gapTerm, name, 'draft', dir, j({ domain, author: input.author ?? 'unassigned', alternatives }), now, now);
  if (gapRow) sys.db.run("UPDATE gaps SET status='in-forge' WHERE id=?", gapRow.id);
  emit(sys.db, 'forge.created', id, { gap: gapTerm, alternatives: alternatives.length });
  return getForge(sys, id);
}

/** Optional authoring through a model provider. Reports blocked instead of writing filler when the provider is unavailable. */
export async function forgeAuthor(sys: Sys, id: string, provider: ModelProvider): Promise<{ status: 'written' | 'blocked'; detail: string }> {
  const c = getForge(sys, id);
  const avail = await provider.availability();
  if (!avail.available || !avail.authenticated) return { status: 'blocked', detail: `${provider.title}: ${avail.detail}` };
  const brief = fs.readFileSync(path.join(c.path, 'BRIEF.md'), 'utf8');
  const r = await provider.complete({ prompt: `Write the complete contents of SKILL.md for the skill described in this brief. Output only the file contents, starting with the YAML front-matter.\n\n${brief}` });
  if (!r.ok || !/^---\s*\n/.test(r.text.trim())) return { status: 'blocked', detail: r.error ?? 'provider did not return a SKILL.md document' };
  fs.writeFileSync(path.join(c.path, 'SKILL.md'), r.text.trim() + '\n');
  const run = `model:${provider.id}:author:${Date.now()}`;
  c.record.author = `model:${provider.id}`;
  c.record.generatedBy = run;
  save(sys, c);
  // The same run also writes TRAINING cases (activation and behaviour). It never writes held-out cases.
  const cases = await proposeCases(provider, [`# Skill brief\n${brief}`, `# The skill as written\n${r.text.trim().slice(0, 12_000)}`].join('\n\n'), { positives: 4, negatives: 4, behaviour: 6 });
  const added = cases.length ? addEvalCases(sys, c.capabilityId, cases, { split: 'train', author: run, generatedBy: run }) : { added: 0, rejected: [] };
  return { status: 'written', detail: `${estimateTokens(r.text)} tokens (estimate) written by ${provider.title}; ${added.added} training case(s) added${added.rejected.length ? `, ${added.rejected.length} rejected` : ''}` };
}

const CASE_FORMAT = 'Answer with one fenced ```json block holding an array of objects: {"kind": "positive" | "negative" | "behaviour", "prompt": "...", "must": ["regex", ...], "mustNot": ["regex", ...]}. "positive": a request this capability should be used for; "negative": a plausible request it must NOT be used for; "behaviour": a request plus case-insensitive regexes that any correct expert answer must contain (must) or must not contain (mustNot). Keep regexes short and robust to wording (prefer key terms and alternatives like "draw ?calls|draw-calls"). No other text.';

/** Asks a model for evaluation cases and keeps the well-formed ones. */
async function proposeCases(provider: ModelProvider, material: string, want: { positives: number; negatives: number; behaviour: number }): Promise<CaseInput[]> {
  const r = await provider.complete({ prompt: `${material}\n\nWrite ${want.positives} positive, ${want.negatives} negative and ${want.behaviour} behaviour cases. ${CASE_FORMAT}`, maxTokens: 4096 });
  if (!r.ok) return [];
  const block = [...r.text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1] ?? r.text;
  try {
    const arr = JSON.parse(block);
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x.prompt === 'string').map((x) => ({ kind: x.kind, prompt: x.prompt, must: Array.isArray(x.must) ? x.must : [], mustNot: Array.isArray(x.mustNot) ? x.mustNot : [] })) : [];
  } catch {
    return [];
  }
}

/**
 * Held-out cases from a separate model run that sees only the gap and the brief, never the skill text, and is recorded
 * as a different author from the run that wrote the skill.
 */
export async function forgeAuthorHeldout(sys: Sys, id: string, provider: ModelProvider, opts: { behaviour?: number; activation?: number } = {}): Promise<{ status: 'written' | 'blocked'; detail: string; added: number }> {
  const c = getForge(sys, id);
  const avail = await provider.availability();
  if (!avail.available || !avail.authenticated) return { status: 'blocked', detail: `${provider.title}: ${avail.detail}`, added: 0 };
  const brief = fs.readFileSync(path.join(c.path, 'BRIEF.md'), 'utf8').replace(/## Existing alternatives[\s\S]*?(?=\n## |$)/, '');
  const author = `model:${provider.id}:heldout:${Date.now()}`;
  const cases = await proposeCases(provider, `You write an independent test set for a capability that another author is building. You have NOT seen their work and must not guess its wording; test what a competent expert answer to these requests must contain.\n\n# What the capability is for\n${brief}`, { positives: opts.activation ?? 3, negatives: opts.activation ?? 3, behaviour: opts.behaviour ?? 12 });
  if (!cases.length) return { status: 'blocked', detail: 'the provider did not return usable cases', added: 0 };
  const r = addEvalCases(sys, c.capabilityId, cases, { split: 'heldout', author, generatedBy: c.record.generatedBy ?? null });
  return { status: 'written', detail: `${r.added} held-out case(s) by ${author}${r.rejected.length ? `; ${r.rejected.length} rejected (${[...new Set(r.rejected.map((x) => x.why))].join('; ')})` : ''}`, added: r.added };
}

/** Workspace files written by hand (evals/activation.json, cases.json, heldout.json) join the set once. */
function importWorkspaceCases(sys: Sys, c: ForgeCandidate) {
  if (listEvalCases(sys, c.capabilityId).length) return;
  const dir = path.join(c.path, 'evals');
  const act = readJson<{ positive?: string[]; negative?: string[] }>(path.join(dir, 'activation.json'), {});
  const author = `workspace:${c.record.author}`;
  const train: CaseInput[] = [...(act.positive ?? []).map((prompt) => ({ kind: 'positive' as const, prompt })), ...(act.negative ?? []).map((prompt) => ({ kind: 'negative' as const, prompt })), ...readJson<EvalCase[]>(path.join(dir, 'cases.json'), []).map((x) => ({ id: x.id, kind: 'behaviour' as const, prompt: x.prompt, must: x.must, mustNot: x.mustNot }))];
  if (train.length) addEvalCases(sys, c.capabilityId, train, { split: 'train', author });
  const held = readJson<EvalCase[]>(path.join(dir, 'heldout.json'), []);
  if (held.length) addEvalCases(sys, c.capabilityId, held.map((x) => ({ id: x.id, kind: 'behaviour' as const, prompt: x.prompt, must: x.must, mustNot: x.mustNot })), { split: 'heldout', author: 'workspace:heldout.json', generatedBy: c.record.generatedBy ?? null });
}

/* ---------- 2. checks: lint, security, activation ---------- */

function packageFiles(dir: string): FetchedFile[] {
  const out: FetchedFile[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (rel !== 'evals') walk(full);
      } else if (rel !== 'BRIEF.md') {
        const content = fs.readFileSync(full, 'utf8');
        out.push({ path: rel, content, size: Buffer.byteLength(content) });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

export function lintSkill(md: string): { ok: boolean; problems: string[] } {
  const { data, body, hasFrontmatter } = parseFrontmatter(md);
  const p: string[] = [];
  if (!hasFrontmatter) p.push('no front-matter');
  if (typeof data.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(data.name)) p.push('name must be lowercase letters, digits and hyphens (max 64)');
  const desc = typeof data.description === 'string' ? data.description : '';
  if (desc.length < 60) p.push('description shorter than 60 characters');
  if (desc.length > 1024) p.push('description longer than 1024 characters');
  if (!/\buse (this |it )?(skill )?(when|for)\b/i.test(desc)) p.push('description does not say when to use the skill ("Use when …")');
  if (/\bTODO\b/.test(md)) p.push('contains TODO placeholders');
  if (body.trim().length < 800) p.push(`body is ${body.trim().length} characters; too thin to carry expertise (minimum 800)`);
  if ((body.match(/^#{2,3} /gm) ?? []).length < 3) p.push('fewer than three sections');
  if (!/\b(do not use|don't use|not for|when not to use|out of scope)\b/i.test(md)) p.push('does not state when NOT to use it');
  if (typeof data.license !== 'string' || !data.license) p.push('no license in front-matter');
  return { ok: p.length === 0, problems: p };
}

export function forgeCheck(sys: Sys, deps: Deps, id: string): ForgeCandidate {
  const c = getForge(sys, id);
  if (['promoted', 'rejected'].includes(c.state)) throw new ForgeError('state', `${c.id} is already ${c.state}`);
  const files = packageFiles(c.path);
  const skill = files.find((f) => f.path === 'SKILL.md');
  if (!skill) throw new ForgeError('invalid', 'SKILL.md is missing from the forge workspace');
  const settings = sys.settings();
  const lint = lintSkill(skill.content);
  const fm = parseFrontmatter(skill.content).data;
  if (fm.name !== c.name) lint.problems.push(`front-matter name "${fm.name}" differs from the candidate name "${c.name}"`), (lint.ok = false);
  c.record.lint = lint;

  // Security screening: same audit as for anything downloaded.
  const audit = auditPackage({ kind: 'skill', files, publisher: 'forge', provenanceVerified: true, settings });
  const contentHash = hashFiles(files);
  storeAudit(sys, 'forge', c.capabilityId, contentHash, audit);
  c.record.audit = { tier: audit.tier, critical: audit.critical, high: audit.high, summary: audit.summary };

  if (!lint.ok || audit.tier === 'C') {
    c.state = 'draft';
    save(sys, c);
    emit(sys.db, 'forge.check-failed', c.id, { lint: lint.problems, tier: audit.tier });
    return getForge(sys, c.id);
  }

  // Register (NOT approved) so it can be routed against under test.
  const desc = String(fm.description);
  const score = scorePackage({ kind: 'skill', files, audit, provenanceVerified: true, pushedAt: nowIso(), hostCompatible: true, settings });
  const snap = writeSnapshot(sys, c.capabilityId, files);
  const prior = getCapability(sys, c.capabilityId);
  upsertCapability(
    sys,
    {
      id: c.capabilityId, name: c.name, description: desc, kind: 'skill', domain: c.record.domain, category: 'skill', tags: [...new Set([...(Array.isArray(fm.tags) ? fm.tags : []), ...(c.gap ?? '').split(/\s+/)].filter(Boolean).map((t: string) => t.toLowerCase()))],
      platforms: ['claude-code', 'opencode'], publisher: 'forge', license: audit.licence, permissions: audit.permissions, executables: audit.executables,
      provenance: { sourceId: 'forge', url: c.path, fetchedAt: nowIso(), verified: true, method: `forge: authored locally by ${c.record.author}` }, verification: 'partial',
      security: { tier: audit.tier, trust: 'EXPERIMENTAL', critical: audit.critical, findings: audit.findings.length }, quality: { total: score.total, dimensions: score.dimensions, unknowns: score.unknowns },
      contextCost: estimateTokens(skill.content), entryFile: 'SKILL.md', fileCount: files.length, lastAuditAt: nowIso(),
    },
    { status: prior?.status === 'approved' ? 'registered' : 'registered', origin: 'forge', ...snap, version: contentHash.slice(0, 12), body: skill.content },
  );

  // Activation tests: it must route for its own tasks AND stay out of unrelated ones (all splits).
  importWorkspaceCases(sys, c);
  const act = { positive: listEvalCases(sys, c.capabilityId, { kind: 'positive' }).map((x) => x.prompt), negative: listEvalCases(sys, c.capabilityId, { kind: 'negative' }).map((x) => x.prompt) };
  if (act.positive.length < 3 || act.negative.length < 3) {
    c.record.lint = { ok: false, problems: [`the evaluation set needs at least 3 positive and 3 negative activation prompts (has ${act.positive.length} and ${act.negative.length}; add them to evals/activation.json or with synaptome eval add)`] };
    c.state = 'draft';
    save(sys, c);
    return getForge(sys, c.id);
  }
  const strategy = lexicalGraphStrategy(sys, { assumeEligible: new Set([c.capabilityId]) });
  const routed = (prompt: string) => strategy.route(prompt).selected.some((s) => s.capabilityId === c.capabilityId);
  const positives = act.positive.map((prompt) => ({ prompt, passed: routed(prompt) }));
  const negatives = act.negative.map((prompt) => ({ prompt, passed: !routed(prompt) }));
  const rate = (xs: { passed: boolean }[]) => xs.filter((x) => x.passed).length / xs.length;
  c.record.activation = { positives, negatives, positiveRate: rate(positives), negativeRate: rate(negatives) };
  recordEval(sys, c.capabilityId, 'activation', 'router:lexical-graph-v1', 'completed', [...positives.map((p) => ({ ...p, expect: 'selected' })), ...negatives.map((n) => ({ ...n, expect: 'not selected' }))], { positiveRate: c.record.activation.positiveRate, negativeRate: c.record.activation.negativeRate, positives: positives.length, negatives: negatives.length });
  c.state = 'checked';
  save(sys, c);
  emit(sys.db, 'forge.checked', c.id, { tier: audit.tier, positiveRate: c.record.activation.positiveRate, negativeRate: c.record.activation.negativeRate });
  return getForge(sys, c.id);
}

/**
 * Reopens a decided candidate for revision. A promoted skill is taken out of routing first
 * (status back to "registered") and its previous snapshot stays in capability_versions, so a
 * deployed skill is never rewritten silently. It must pass every check and the gate again.
 */
export function forgeRevise(sys: Sys, id: string, reason: string): ForgeCandidate {
  const c = getForge(sys, id);
  if (!['promoted', 'rejected', 'held'].includes(c.state)) throw new ForgeError('state', `${c.id} is "${c.state}"; only decided candidates are revised`);
  if (!reason.trim()) throw new ForgeError('invalid', 'A reason for the revision is required');
  const cap = getCapability(sys, c.capabilityId);
  if (cap && cap.status !== 'registered') transitionCapability(sys, cap.id, 'registered', { reason: `forge revision: ${reason.trim()}`, by: 'forge' });
  (c.record as any).revisions = [...((c.record as any).revisions ?? []), { at: nowIso(), from: c.state, reason, previousDecision: c.decision }];
  c.record.lint = undefined;
  c.record.audit = undefined;
  c.record.activation = undefined;
  c.record.baseline = undefined;
  c.record.gate = undefined;
  c.state = 'draft';
  c.decision = null;
  save(sys, c);
  emit(sys.db, 'forge.revision-opened', c.id, { reason });
  return getForge(sys, c.id);
}

/* ---------- 3. baseline evaluation ---------- */

/** Behaviour cases from the evaluation set (importing workspace files the first time). */
export function forgeCases(c: ForgeCandidate, sys?: Sys): (EvalCase & { split: 'train' | 'heldout' })[] {
  if (sys) {
    importWorkspaceCases(sys, c);
    return listEvalCases(sys, c.capabilityId, { kind: 'behaviour' }).map((x) => ({ ...toEvalCase(x), split: x.split }));
  }
  const cases = readJson<EvalCase[]>(path.join(c.path, 'evals', 'cases.json'), []);
  return cases.filter((x) => x && typeof x.id === 'string' && typeof x.prompt === 'string' && Array.isArray(x.must) && x.must.length > 0).map((x) => ({ ...x, split: 'train' as const }));
}
export function forgeVariants(c: ForgeCandidate): { id: string; system?: string }[] {
  const skill = fs.readFileSync(path.join(c.path, 'SKILL.md'), 'utf8');
  return [{ id: 'baseline' }, { id: 'with-skill', system: `Apply the following skill to the user's request.\n\n${skill}` }];
}

export async function forgeEvaluate(sys: Sys, id: string, runner: EvaluationRunner): Promise<ForgeCandidate> {
  const c = getForge(sys, id);
  if (!['checked', 'evaluated', 'eval-blocked', 'held'].includes(c.state)) throw new ForgeError('state', `${c.id} is "${c.state}"; run the checks first`, `synaptome forge check ${c.id}`);
  const cases = forgeCases(c, sys);
  if (cases.length < 3) throw new ForgeError('invalid', `the evaluation set has ${cases.length} behaviour case(s); at least 3 are required`);
  const contentHash = hashFiles(packageFiles(c.path));
  const r = await runner.run({ cases: cases.map(({ split, ...x }) => x), variants: forgeVariants(c) });
  if (r.status === 'blocked') {
    const evalId = recordEval(sys, c.capabilityId, 'baseline', runner.id, 'blocked', r.results, { blocker: r.blocker });
    c.record.baseline = { status: 'blocked', runner: runner.id, blocker: r.blocker, contentHash, evalId };
    c.state = 'eval-blocked';
  } else {
    const splitOf = new Map(cases.map((x) => [x.id, x.split]));
    const per = (split: 'train' | 'heldout') => {
      const n = cases.filter((x) => x.split === split).length;
      return n ? summarize(r.results.filter((x) => splitOf.get(x.caseId) === split), n) : null;
    };
    const summary = summarize(r.results, cases.length);
    const splits = { train: per('train'), heldout: per('heldout') };
    const evalId = recordEval(sys, c.capabilityId, 'baseline', runner.id, 'completed', r.results, { ...summary, splits });
    c.record.baseline = { status: 'completed', runner: runner.id, summary, splits, contentHash, evalId };
    c.state = 'evaluated';
  }
  save(sys, c);
  return getForge(sys, c.id);
}

/* ---------- 4. decision ---------- */

export const FORGE_RULES = {
  minPositiveActivation: 0.8,
  minNegativeActivation: 1,
  /** On held-out cases, with the skill. */
  minPassRate: 0.7,
  /** Held-out pass rate with the skill minus without it. */
  minLift: 0.01,
  /** Promotion needs at least this many held-out behaviour cases not written by the run that wrote the skill. */
  minHeldout: 5,
  /** Training pass rate minus held-out pass rate (both with the skill) above this means the skill fits its own examples, not the task. */
  maxOverfitGap: 0.25,
  /** A revision may not score more than this below the promoted version on held-out cases. */
  maxRegression: 0.05,
};
const pct0 = (x: number) => `${(x * 100).toFixed(0)}%`;

export function forgeDecide(sys: Sys, deps: Deps, id: string, opts: { reject?: string } = {}): ForgeCandidate {
  const c = getForge(sys, id);
  if (['promoted', 'rejected'].includes(c.state)) throw new ForgeError('state', `${c.id} is already ${c.state}`);
  const reasons: string[] = [];
  let verdict: 'promote' | 'reject' | 'hold' = 'promote';
  const fail = (v: 'reject' | 'hold', why: string) => {
    if (verdict !== 'reject') verdict = v;
    reasons.push(why);
  };
  if (opts.reject) fail('reject', `rejected by reviewer: ${opts.reject}`);
  if (!c.record.lint?.ok) fail('hold', `structural checks not passed: ${(c.record.lint?.problems ?? ['not run']).join('; ')}`);
  if (!c.record.audit) fail('hold', 'security screening not run');
  else if (c.record.audit.tier === 'C') fail('reject', `security screening: ${c.record.audit.summary}`);
  const a = c.record.activation;
  if (!a) fail('hold', 'activation tests not run');
  else {
    if (a.positiveRate < FORGE_RULES.minPositiveActivation) fail('reject', `only ${(a.positiveRate * 100).toFixed(0)}% of positive activation prompts route to it (need ${FORGE_RULES.minPositiveActivation * 100}%)`);
    if (a.negativeRate < FORGE_RULES.minNegativeActivation) fail('reject', `it activates on ${a.negatives.filter((n) => !n.passed).length} unrelated prompt(s)`);
  }
  const b = c.record.baseline;
  if (!b) fail('hold', 'baseline evaluation not run');
  else if (b.status === 'blocked') fail('hold', `baseline evaluation blocked: ${b.blocker}`);
  else {
    // Promotion is decided on held-out cases only; training cases may have shaped the skill.
    const ho = b.splits?.heldout ?? null;
    const tr = b.splits?.train ?? null;
    const variant = (s: EvalSummary | null, v: string) => s?.variants.find((x) => x.variant === v);
    if (!ho || ho.cases < FORGE_RULES.minHeldout) fail('hold', `needs at least ${FORGE_RULES.minHeldout} held-out behaviour cases written by someone other than the run that wrote the skill (has ${ho?.cases ?? 0}); add them with: synaptome eval add ${c.id} --split heldout, or synaptome forge heldout ${c.id}`);
    else {
      const w = variant(ho, 'with-skill');
      const base = variant(ho, 'baseline');
      if (!w || !base) fail('hold', 'the evaluation is missing a variant');
      else {
        if (w.passRate < FORGE_RULES.minPassRate) fail('reject', `on held-out cases only ${pct0(w.passRate)} pass with the skill (need ${pct0(FORGE_RULES.minPassRate)}; n=${ho.cases})`);
        if ((ho.lift ?? 0) < FORGE_RULES.minLift) fail('reject', `no measured improvement on held-out cases: ${pct0(w.passRate)} with the skill vs ${pct0(base.passRate)} without (n=${ho.cases})`);
        const tw = variant(tr, 'with-skill');
        if (tw && tw.passRate - w.passRate > FORGE_RULES.maxOverfitGap) fail('reject', `overfit: passes ${pct0(tw.passRate)} of its training cases but ${pct0(w.passRate)} of held-out cases (n=${tr!.cases} and ${ho.cases})`);
        const prev = c.record.versions?.at(-1);
        if (prev && prev.contentHash !== b.contentHash && w.passRate < prev.heldout.withSkill - FORGE_RULES.maxRegression) fail('reject', `regression: held-out pass rate ${pct0(w.passRate)} is below the promoted version's ${pct0(prev.heldout.withSkill)}`);
        if (verdict === 'promote') reasons.push(`held-out: ${pct0(w.passRate)} with the skill vs ${pct0(base.passRate)} without (n=${ho.cases}, runner ${b.runner})${tw ? `; training: ${pct0(tw.passRate)} (n=${tr!.cases})` : ''}; with samples this small the direction is shown, not significance`);
      }
    }
  }
  if (verdict === 'promote' && a) reasons.push(`activation: ${(a.positiveRate * 100).toFixed(0)}% of positives, ${(a.negativeRate * 100).toFixed(0)}% of negatives correct`);

  const cap = getCapability(sys, c.capabilityId);
  if (verdict === 'promote' && cap) {
    // Passing the forge does not bypass the promotion gate; it supplies the gate's evidence.
    const files = packageFiles(c.path);
    const settings = sys.settings();
    const audit = auditPackage({ kind: 'skill', files, publisher: 'forge', provenanceVerified: true, settings });
    const functional = runFunctionalTests(sys, deps, cap, files);
    const ho = b!.splits!.heldout!;
    const w = ho.variants.find((v) => v.variant === 'with-skill')!;
    const base = ho.variants.find((v) => v.variant === 'baseline')!;
    const tr = b!.splits!.train;
    const score = scorePackage({ kind: 'skill', files, audit, provenanceVerified: true, pushedAt: nowIso(), hostCompatible: true, functional, evaluation: { passRate: w.passRate, baselinePassRate: base.passRate, cases: ho.cases }, settings });
    storeScore(sys, cap.id, score);
    upsertCapability(sys, { ...cap.record, quality: { total: score.total, dimensions: score.dimensions, unknowns: score.unknowns }, benchmarks: [{ suite: 'held-out', runner: b!.runner, withSkill: w.passRate, baseline: base.passRate, cases: ho.cases, evalId: b!.evalId }] });
    c.record.versions = [...(c.record.versions ?? []), { contentHash: b!.contentHash ?? hashFiles(files), promotedAt: nowIso(), heldout: { withSkill: w.passRate, baseline: base.passRate, n: ho.cases }, train: tr ? { withSkill: tr.variants.find((v) => v.variant === 'with-skill')?.passRate ?? 0, baseline: tr.variants.find((v) => v.variant === 'baseline')?.passRate ?? 0, n: tr.cases } : null }];
    const host = settings.hosts.targets[0] ?? 'claude-code';
    const gate = promotionPolicy(sys, deps).evaluate(cap.id, host) as GateOutcome;
    recordGate(sys, cap.id, host, gate, 'forge');
    c.record.gate = { decision: gate.decision, failed: gate.checks.filter((x) => x.result !== 'pass').map((x) => `${x.id}:${x.result}`) };
    if (gate.decision === 'auto-promote') {
      transitionCapability(sys, cap.id, 'approved', { reason: `forge evaluation passed and the promotion gate passed (score ${score.total})`, by: 'forge', payload: { score: score.total } });
      if (settings.policy.autoInstall === 'sandbox') {
        try {
          install(sys, deps, cap.id, { host, scope: 'sandbox', by: 'forge' });
        } catch (e: any) {
          reasons.push(`sandbox install failed: ${e.message}`);
        }
      }
      reasons.push(`promotion gate passed (score ${score.total}); approved and staged in the sandbox host`);
    } else reasons.push(`forge evaluation passed; promotion gate says "${gate.decision}" (${c.record.gate.failed.join(', ') || 'no failed checks'}), so it waits for approval`);
    if (c.gap) sys.db.run("UPDATE gaps SET status='closed' WHERE term=?", c.gap);
  }
  if ((verdict as string) === 'reject') {
    if (cap) transitionCapability(sys, cap.id, 'rejected', { reason: `forge evaluation rejected it: ${reasons.join('; ') || 'did not pass'}`, by: 'forge' });
    if (c.gap) sys.db.run("UPDATE gaps SET status='open' WHERE term=?", c.gap);
  }
  c.state = verdict === 'promote' ? 'promoted' : verdict === 'reject' ? 'rejected' : 'held';
  c.decision = { verdict, reasons, at: nowIso() };
  save(sys, c);
  emit(sys.db, `forge.${c.state}`, c.id, { reasons });
  return getForge(sys, c.id);
}

/* ---------- 5. versions: deprecation and rollback ---------- */

/** Takes a promoted skill out of routing for good; its versions and evidence stay on record. */
export function forgeDeprecate(sys: Sys, id: string, reason: string): ForgeCandidate {
  const c = getForge(sys, id);
  if (c.state !== 'promoted') throw new ForgeError('state', `${c.id} is "${c.state}"; only a promoted skill is deprecated`);
  if (!reason.trim()) throw new ForgeError('invalid', 'A reason for the deprecation is required');
  if (getCapability(sys, c.capabilityId)) transitionCapability(sys, c.capabilityId, 'deprecated', { reason: `forge: ${reason.trim()}`, by: 'forge' });
  c.state = 'deprecated';
  c.decision = { verdict: c.decision?.verdict ?? 'promote', reasons: [...(c.decision?.reasons ?? []), `deprecated: ${reason.trim()}`], at: nowIso() };
  save(sys, c);
  emit(sys.db, 'forge.deprecated', c.id, { reason });
  return getForge(sys, c.id);
}

/**
 * Returns to the previously promoted version: its files come back from the snapshot store (integrity-checked), the
 * capability points at them again, and the sandbox install is refreshed. The newer version stays in the history.
 */
export function forgeRollback(sys: Sys, deps: Deps, id: string, reason = 'rolled back to the previous version'): ForgeCandidate {
  const c = getForge(sys, id);
  const versions = c.record.versions ?? [];
  if (versions.length < 2) throw new ForgeError('state', `${c.id} has ${versions.length} promoted version(s); rollback needs an earlier one`);
  const target = versions[versions.length - 2];
  const row = sys.db.get<any>('SELECT snapshot_path FROM capability_versions WHERE capability_id=? AND content_hash=?', c.capabilityId, target.contentHash);
  const files = row && fs.existsSync(row.snapshot_path) ? readTree(row.snapshot_path) : [];
  if (!files.length || hashFiles(files) !== target.contentHash) throw new ForgeError('invalid', `the stored copy of version ${target.contentHash.slice(0, 12)} is missing or fails its integrity check`);
  for (const f of packageFiles(c.path)) fs.rmSync(path.join(c.path, f.path), { force: true });
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(c.path, f.path)), { recursive: true });
    fs.writeFileSync(path.join(c.path, f.path), f.content);
  }
  const cap = getCapability(sys, c.capabilityId)!;
  const skill = files.find((f) => f.path === 'SKILL.md')!;
  upsertCapability(sys, { ...cap.record, description: String(parseFrontmatter(skill.content).data.description ?? cap.description), contextCost: estimateTokens(skill.content) }, { status: 'approved', origin: 'forge', ...writeSnapshot(sys, c.capabilityId, files), version: target.contentHash.slice(0, 12), body: skill.content });
  const settings = sys.settings();
  if (settings.policy.autoInstall === 'sandbox') {
    try {
      install(sys, deps, c.capabilityId, { host: settings.hosts.targets[0] ?? 'claude-code', scope: 'sandbox', by: 'forge' });
    } catch {
      /* the registry is already correct; the install can be repeated */
    }
  }
  c.record.versions = versions.slice(0, -1);
  c.state = 'promoted';
  c.decision = { verdict: 'promote', reasons: [`${reason}: ${target.contentHash.slice(0, 12)} (held-out ${pct0(target.heldout.withSkill)} with the skill, n=${target.heldout.n})`], at: nowIso() };
  save(sys, c);
  emit(sys.db, 'forge.rolled-back', c.id, { to: target.contentHash, from: versions.at(-1)!.contentHash });
  return getForge(sys, c.id);
}
