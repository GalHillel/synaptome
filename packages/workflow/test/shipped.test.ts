import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempSystem } from '@synaptome/core';
import { SHIPPED_WORKFLOWS, approveStep, defaultRunners, findWorkflow, getRun, loadWorkflows, runWorkflow, startRun, validateWorkflow } from '../src/index';

let sys: ReturnType<typeof tempSystem>;
beforeEach(() => {
  sys = tempSystem();
});
afterEach(() => sys.dispose());

/** A stand-in for the Synaptome API that records every call. */
function fakeApi(decision: 'auto-promote' | 'needs-approval') {
  const calls: { name: string; args: any }[] = [];
  const handlers: Record<string, (a: any) => unknown> = {
    'scan.run': () => ({ reports: [{ candidateIds: ['c-1', 'c-2'] }] }),
    'candidates.evaluate': (a) => ({ candidateId: a.id, capabilityId: 'acme.notes', state: 'registered', tier: 'A', gate: { decision } }),
    'capabilities.approve': () => ({ gate: { decision: 'needs-approval' } }),
    'capabilities.install': () => ({ id: 'i-1', verifyDetail: 'SKILL.md valid' }),
    'capabilities.get': () => ({ capability: { id: 'acme.notes', status: 'approved' } }),
    'forge.new': (a) => ({ id: `f-${a.gap.replace(/\s+/g, '-')}`, path: '/tmp/forge' }),
    'forge.author': () => ({ status: 'blocked', detail: 'no provider in this test' }),
    'forge.check': () => ({ state: 'draft' }),
  };
  const kinds: Record<string, 'query' | 'action'> = { 'capabilities.get': 'query' };
  return {
    calls,
    api: {
      commands: Object.fromEntries(Object.keys(handlers).map((k) => [k, { kind: kinds[k] ?? 'action', title: k }])),
      call: async (name: string, args: any) => (calls.push({ name, args }), handlers[name](args)),
    },
  };
}

describe('shipped workflows', () => {
  it('are valid definitions', () => {
    for (const w of SHIPPED_WORKFLOWS) expect(validateWorkflow(w)).toMatchObject({ ok: true });
    expect(loadWorkflows(sys).workflows.map((w) => w.def.id)).toEqual(['capability.acquire', 'capability.forge-gap', 'team.build']);
  });

  it('acquire: when the gate auto-promotes, nobody is asked and the capability is staged in the sandbox', async () => {
    const { api, calls } = fakeApi('auto-promote');
    const id = startRun(sys, findWorkflow(sys, 'capability.acquire')!.def, { need: 'release notes' });
    const r = await runWorkflow(sys, id, { runners: defaultRunners({ api }) });
    expect(r.status).toBe('succeeded');
    expect(r.steps.find((s) => s.id === 'approve')!.status).toBe('skipped');
    expect(calls.map((c) => c.name)).toEqual(['scan.run', 'candidates.evaluate', 'capabilities.install', 'capabilities.get']);
    expect(calls[0].args).toMatchObject({ mode: 'need', query: 'release notes', limit: 5, sources: ['github'] });
    expect(calls[2].args).toEqual({ id: 'acme.notes', host: 'claude-code' }); // sandbox: no "real"
    expect(getRun(sys, id)!.steps.find((s) => s.id === 'report')!.output).toMatchObject({ capability: 'acme.notes', gate: 'auto-promote', approval: 'skipped', stage: 'succeeded', installation: 'i-1' });
  });

  it('acquire: when the gate asks for a person, the run waits; the approval is what approves the capability', async () => {
    const { api, calls } = fakeApi('needs-approval');
    const id = startRun(sys, findWorkflow(sys, 'capability.acquire')!.def, { need: 'release notes' });
    expect((await runWorkflow(sys, id, { runners: defaultRunners({ api }) })).status).toBe('waiting');
    expect(calls.map((c) => c.name)).toEqual(['scan.run', 'candidates.evaluate']);
    approveStep(sys, id, 'approve', { by: 'tester', approve: true });
    const r = await runWorkflow(sys, id, { runners: defaultRunners({ api }) });
    expect(r.status).toBe('succeeded');
    expect(calls.map((c) => c.name)).toEqual(['scan.run', 'candidates.evaluate', 'capabilities.approve', 'capabilities.install', 'capabilities.get']);
  });

  it('acquire: a rejection stages nothing, still reports, and the run says why it did not complete', async () => {
    const { api, calls } = fakeApi('needs-approval');
    const id = startRun(sys, findWorkflow(sys, 'capability.acquire')!.def, { need: 'release notes' });
    await runWorkflow(sys, id, { runners: defaultRunners({ api }) });
    approveStep(sys, id, 'approve', { by: 'tester', approve: false, note: 'weak match' });
    const r = await runWorkflow(sys, id, { runners: defaultRunners({ api }) });
    expect(r.status).toBe('failed');
    expect(Object.fromEntries(r.steps.map((s) => [s.id, s.status]))).toMatchObject({ approve: 'failed', stage: 'skipped', verify: 'succeeded', report: 'succeeded' });
    expect(calls.map((c) => c.name)).not.toContain('capabilities.install');
    expect(getRun(sys, id)!.error).toBe('step failed: approve');
  });

  it('forge-gap: drafts, tries to author, checks, and reports honestly when no model is available', async () => {
    const { api } = fakeApi('auto-promote');
    const id = startRun(sys, findWorkflow(sys, 'capability.forge-gap')!.def, { gap: 'terraform drift' });
    const r = await runWorkflow(sys, id, { runners: defaultRunners({ api }) });
    expect(r.status).toBe('succeeded');
    expect(getRun(sys, id)!.steps.find((s) => s.id === 'report')!.output).toEqual({ gap: 'terraform drift', forge: 'f-terraform-drift', authored: 'blocked', authorDetail: 'no provider in this test', state: 'draft', path: '/tmp/forge' });
  });

  it("loads the owner's own workflows from the home and reports invalid ones instead of running them", () => {
    const dir = path.join(sys.home, 'workflows');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'mine.json'), JSON.stringify({ id: 'my.flow', title: 'Mine', steps: [{ id: 'a', kind: 'noop' }] }));
    fs.writeFileSync(path.join(dir, 'broken.json'), JSON.stringify({ id: 'my.broken', title: 'Broken', steps: [{ id: 'a', kind: 'noop', needs: ['a'] }] }));
    fs.writeFileSync(path.join(dir, 'clash.json'), JSON.stringify({ id: 'capability.acquire', title: 'Clash', steps: [{ id: 'a', kind: 'noop' }] }));
    const l = loadWorkflows(sys);
    expect(l.workflows.map((w) => w.def.id)).toContain('my.flow');
    expect(l.problems.map((p) => path.basename(p.file))).toEqual(['broken.json', 'clash.json']);
  });
});
