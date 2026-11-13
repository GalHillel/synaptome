import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Deps } from '@synaptome/acquisition';
import { buildAdapterRegistry } from '@synaptome/adapters';
import { type ModelProvider, getCapability, hashFiles, readTree, tempSystem } from '@synaptome/core';
import { ConnectorRegistry } from '@synaptome/discovery';
import { EvalSetError, addEvalCases, evalSetSummary, listEvalCases, modelRunner } from '@synaptome/evaluation';
import { routeTask } from '@synaptome/router';
import { forgeAuthor, forgeAuthorHeldout, forgeCheck, forgeDecide, forgeDeprecate, forgeEvaluate, forgeNew, forgeRevise, forgeRollback, getForge } from '../src/index';

let sys: ReturnType<typeof tempSystem>;
let deps: Deps;
let claudeRoot: string;
beforeEach(() => {
  sys = tempSystem();
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-claude-'));
  deps = { connectors: new ConnectorRegistry(), adapters: buildAdapterRegistry({ claudeRoot }) };
});
afterEach(() => {
  sys.dispose();
  fs.rmSync(claudeRoot, { recursive: true, force: true });
});

const skill = (extra = '') => `---
name: release-notes-writer
description: Write release notes from merged changes, grouped by user impact. Use when the user asks for release notes or a changelog entry. Do not use for commit messages.
license: MIT
---
# Release notes writer

## Grouping
Group changes as Added, Changed, Fixed, Removed. Lead with what users notice.

## Wording
Name the user-visible effect, not the internal refactor. One line per change.

## Breaking changes
Put breaking changes first, each with a migration step.

## When not to use
Do not use for commit messages or code review comments.
${'Explains the reasoning behind each rule in plain language. '.repeat(8)}
${extra}`;
const ACTIVATION = { positive: ['Write release notes for version 2.1 from these merged pull requests', 'Draft the changelog entry for this release', 'Turn this list of merged changes into release notes'], negative: ['Write a SQL migration for the orders table', 'Summarise this finance report', 'Fix the failing pytest in the parser'] };

/** Answers well only with the skill in the system prompt; `heldoutKnown` decides which held-out prompts it also gets right. */
const provider = (opts: { heldoutKnown?: (prompt: string) => boolean } = {}): ModelProvider => ({
  id: 'fake',
  title: 'fake',
  availability: async () => ({ available: true, authenticated: true, detail: 'ok' }),
  complete: async (req) => ({ ok: true, ms: 1, text: req.system ? `alpha ${(opts.heldoutKnown ?? (() => true))(req.prompt) ? 'omega' : ''}` : 'generic answer' }),
});
const train = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, kind: 'behaviour' as const, prompt: `training request ${i}`, must: ['alpha'] }));
const heldout = (n: number, known = n) => Array.from({ length: n }, (_, i) => ({ id: `h${i}`, kind: 'behaviour' as const, prompt: `held-out request ${i}${i < known ? ' [known]' : ''}`, must: ['omega'] }));

/** A checked candidate with training cases from its own workspace and held-out cases from a separate author. */
function candidate(trainN = 5, heldoutN = 6, known = heldoutN) {
  const c = forgeNew(sys, { gap: 'release notes changelog', name: 'release-notes-writer' });
  fs.writeFileSync(path.join(c.path, 'SKILL.md'), skill());
  fs.writeFileSync(path.join(c.path, 'evals', 'activation.json'), JSON.stringify(ACTIVATION));
  fs.writeFileSync(path.join(c.path, 'evals', 'cases.json'), JSON.stringify(train(trainN)));
  expect(forgeCheck(sys, deps, c.id).state).toBe('checked');
  if (heldoutN) addEvalCases(sys, c.capabilityId, heldout(heldoutN, known), { split: 'heldout', author: 'person:reviewer' });
  return getForge(sys, c.id);
}
const decide = async (id: string, known?: (p: string) => boolean) => {
  await forgeEvaluate(sys, id, modelRunner(provider({ heldoutKnown: known ?? ((p) => p.includes('[known]')) })));
  return forgeDecide(sys, deps, id);
};

describe('evaluation sets', () => {
  it('records split and author, refuses held-out cases from the run that wrote the skill, and rejects malformed cases', () => {
    const c = candidate(3, 0);
    expect(() => addEvalCases(sys, c.capabilityId, heldout(2), { split: 'heldout', author: 'model:x:author:1', generatedBy: 'model:x:author:1' })).toThrow(EvalSetError);
    const r = addEvalCases(sys, c.capabilityId, [{ kind: 'behaviour', prompt: 'p1', must: ['(unclosed'] }, { kind: 'behaviour', prompt: 'p2' }, { kind: 'behaviour', prompt: 'training request 0', must: ['x'] }, { kind: 'behaviour', prompt: 'ok', must: ['y'] }], { split: 'heldout', author: 'person:a' });
    expect(r.added).toBe(1);
    expect(r.rejected.map((x) => x.why)).toEqual(['a pattern is not a valid regular expression', 'a behaviour case needs at least one "must" pattern', 'the same prompt is already in the set']);
    expect(evalSetSummary(sys, c.capabilityId)).toMatchObject({ train: { positive: 3, negative: 3, behaviour: 3 }, heldout: { behaviour: 1 } });
    expect(evalSetSummary(sys, c.capabilityId).authors.map((a) => a.author).sort()).toEqual(['person:a', 'workspace:unassigned']);
  });
});

describe('promotion on held-out evidence', () => {
  it('holds without enough held-out cases, however good the training results', async () => {
    const c = candidate(5, 3);
    const d = await decide(c.id);
    expect(d.state).toBe('held');
    expect(d.decision!.reasons.join(' ')).toMatch(/needs at least 5 held-out behaviour cases .* \(has 3\)/);
  });

  it('promotes on positive held-out lift and states n', async () => {
    const d = await decide(candidate().id);
    expect(d.state).toBe('promoted');
    expect(d.decision!.reasons.join(' ')).toMatch(/held-out: 100% with the skill vs 0% without \(n=6/);
    expect(d.record.versions).toHaveLength(1);
    expect(getCapability(sys, d.capabilityId)!.record.benchmarks[0]).toMatchObject({ suite: 'held-out', cases: 6 });
  });

  it('rejects a deliberately overfit skill: perfect on its own examples, weak on held-out ones', async () => {
    const d = await decide(candidate(5, 10, 6).id); // 100% of training cases, 60% of held-out cases
    expect(d.state).toBe('rejected');
    expect(d.decision!.reasons.join(' ')).toMatch(/overfit: passes 100% of its training cases but 60% of held-out cases \(n=5 and 10\)/);
  });

  it('a revision that scores worse than the promoted version on held-out cases is rejected as a regression', async () => {
    const c = candidate(5, 10);
    expect((await decide(c.id)).state).toBe('promoted'); // 10/10 held-out
    forgeRevise(sys, c.id, 'tighten wording');
    fs.writeFileSync(path.join(c.path, 'SKILL.md'), skill('A revised paragraph.'));
    forgeCheck(sys, deps, c.id);
    const d = await decide(c.id, (p) => /request [0-7]\b/.test(p)); // 8/10 = 80%: passes the bar, but below 100%
    expect(d.state).toBe('rejected');
    expect(d.decision!.reasons.join(' ')).toMatch(/regression: held-out pass rate 80% is below the promoted version's 100%/);
  });
});

describe('versions', () => {
  it('rolls back to the previously promoted version, byte for byte, and the sandbox follows', async () => {
    const c = candidate();
    await decide(c.id);
    const v1 = hashFiles(readTree(c.path).filter((f) => !f.path.startsWith('evals/') && f.path !== 'BRIEF.md'));
    forgeRevise(sys, c.id, 'second edition');
    fs.writeFileSync(path.join(c.path, 'SKILL.md'), skill('Second edition paragraph with more detail.'));
    forgeCheck(sys, deps, c.id);
    const v2 = await decide(c.id);
    expect(v2.state).toBe('promoted');
    expect(v2.record.versions).toHaveLength(2);
    expect(getCapability(sys, c.capabilityId)!.contentHash).not.toBe(v1);

    const rb = forgeRollback(sys, deps, c.id);
    expect(rb.record.versions).toHaveLength(1);
    expect(fs.readFileSync(path.join(c.path, 'SKILL.md'), 'utf8')).toBe(skill());
    const cap = getCapability(sys, c.capabilityId)!;
    expect(cap).toMatchObject({ contentHash: v1, status: 'approved' });
    const installed = path.join(sys.paths.sandboxHosts, 'claude-code', 'skills', 'release-notes-writer', 'SKILL.md');
    expect(fs.readFileSync(installed, 'utf8')).toBe(skill());
    expect(() => forgeRollback(sys, deps, c.id)).toThrow(/rollback needs an earlier one/);
  });

  it('deprecation takes a promoted skill out of routing and keeps its record', async () => {
    const c = candidate();
    await decide(c.id);
    expect(routeTask(sys, 'Write release notes for version 2.1 from these merged pull requests').selected.map((s) => s.capabilityId)).toContain(c.capabilityId);
    const d = forgeDeprecate(sys, c.id, 'replaced by an official skill');
    expect(d.state).toBe('deprecated');
    expect(getCapability(sys, c.capabilityId)!.status).toBe('deprecated');
    expect(routeTask(sys, 'Write release notes for version 2.1 from these merged pull requests').selected.map((s) => s.capabilityId)).not.toContain(c.capabilityId);
    expect(d.record.versions).toHaveLength(1);
  });
});

describe('model-written cases', () => {
  it('the authoring run writes training cases; held-out cases come from a separate run that never sees the skill', async () => {
    const prompts: string[] = [];
    const casesJson = (kind: string) => '```json\n' + JSON.stringify([{ kind: 'positive', prompt: `${kind} positive 1` }, { kind: 'negative', prompt: `${kind} negative 1` }, { kind: 'behaviour', prompt: `${kind} behaviour 1`, must: ['group'] }, { kind: 'behaviour', prompt: `${kind} behaviour bad`, must: ['(bad'] }]) + '\n```';
    const p: ModelProvider = {
      id: 'fake', title: 'fake', availability: async () => ({ available: true, authenticated: true, detail: 'ok' }),
      complete: async (req) => {
        prompts.push(req.prompt);
        if (/Write the complete contents of SKILL\.md/.test(req.prompt)) return { ok: true, ms: 1, text: skill() };
        return { ok: true, ms: 1, text: casesJson(/independent test set/.test(req.prompt) ? 'heldout' : 'train') };
      },
    };
    const c = forgeNew(sys, { gap: 'release notes changelog', name: 'release-notes-writer' });
    expect((await forgeAuthor(sys, c.id, p)).detail).toMatch(/3 training case\(s\) added, 1 rejected/);
    const run = getForge(sys, c.id).record.generatedBy!;
    expect(listEvalCases(sys, c.capabilityId, { split: 'train' }).every((x) => x.author === run)).toBe(true);
    const h = await forgeAuthorHeldout(sys, c.id, p);
    expect(h).toMatchObject({ status: 'written', added: 3 });
    const held = listEvalCases(sys, c.capabilityId, { split: 'heldout' });
    expect(held.every((x) => x.author !== run && /heldout/.test(x.author))).toBe(true);
    // the held-out author never saw the skill text
    expect(prompts.at(-1)).not.toContain('## Grouping');
    expect(prompts.at(-1)).toContain('independent test set');
  });
});
