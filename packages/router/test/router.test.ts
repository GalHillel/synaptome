import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CapabilityStatus, relate, tempSystem, upsertCapability, writeSnapshot } from '@synaptome/core';
import { ActivationError, activate, analyzeTask, explain, getDecision, listGaps, planOnlyExecutor, recordOutcome, routeTask } from '../src/index';

let sys: ReturnType<typeof tempSystem>;

export function seed(s: typeof sys, id: string, name: string, description: string, domain: string, opts: { status?: CapabilityStatus; tags?: string[]; quality?: number; origin?: string } = {}) {
  const files = [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nGuidance body for ${name}.`, size: 1 }];
  const snap = writeSnapshot(s, id, files);
  upsertCapability(s, { id, name, description, kind: 'skill', domain, tags: opts.tags ?? [], entryFile: 'SKILL.md', quality: { total: opts.quality ?? 90 }, security: { tier: 'A', trust: 'REVIEWED_COMMUNITY' } }, { status: opts.status ?? 'approved', origin: opts.origin ?? 'discovered', ...snap, body: files[0].content });
}

beforeEach(() => {
  sys = tempSystem();
  seed(sys, 'x.react-frontend', 'react-frontend', 'Build React frontend components, interactive dashboard UI and web application screens', 'frontend', { tags: ['react', 'frontend', 'ui', 'dashboard'] });
  seed(sys, 'x.api-backend', 'api-backend', 'Design and build backend REST API services, endpoints and server authentication for a SaaS application', 'backend', { tags: ['backend', 'api', 'server'] });
  seed(sys, 'x.postgres-schema', 'postgres-schema', 'Design a database schema, SQL migrations and queries for Postgres in a web application', 'database', { tags: ['database', 'sql', 'postgres'] });
  seed(sys, 'x.test-suite', 'test-suite', 'Write complete testing: unit tests, integration tests and e2e tests for an application', 'testing', { tags: ['testing', 'tests', 'e2e'] });
  seed(sys, 'x.sec-review', 'sec-review', 'Security review of an application: OWASP checks, auth and secrets handling', 'security', { tags: ['security', 'owasp'] });
  seed(sys, 'x.k8s-ops', 'k8s-ops', 'Operate Kubernetes clusters, helm charts and deployment pipelines', 'devops', { tags: ['kubernetes', 'devops'] });
  seed(sys, 'x.stock-valuation', 'stock-valuation', 'Financial valuation of stocks and investment portfolio analysis', 'finance', { tags: ['finance', 'stocks'] });
  seed(sys, 'x.python-debug', 'python-debug', 'Debug Python code: reproduce the bug, isolate the failing function, fix and add a regression test', 'testing', { tags: ['python', 'debug', 'bug'] });
});
afterEach(() => sys.dispose());

const SAAS = 'Create a sophisticated, production-quality SaaS web application with an advanced frontend, backend, database, interactive dashboard, and complete testing.';

describe('task understanding', () => {
  it('classifies scope and domains deterministically', () => {
    const big = analyzeTask(SAAS);
    expect(big.complexity).toBe('large');
    expect(big.domains.map((d) => d.id)).toEqual(expect.arrayContaining(['frontend', 'backend', 'database', 'testing']));
    expect(analyzeTask('Fix the null check in the Python date parser').complexity).toBe('trivial');
    expect(analyzeTask('Rotate the production database password and audit auth tokens').sensitivity).toBe('elevated');
  });
});

describe('routing', () => {
  it('composes a multi-capability workflow for a large task and excludes unrelated capabilities', () => {
    const d = routeTask(sys, SAAS);
    const ids = d.selected.map((s) => s.capabilityId);
    expect(ids).toEqual(expect.arrayContaining(['x.react-frontend', 'x.api-backend', 'x.postgres-schema', 'x.test-suite']));
    expect(ids).not.toContain('x.k8s-ops');
    expect(ids).not.toContain('x.stock-valuation');
    expect(d.plan.map((p) => p.stage)).toEqual([...d.plan.map((p) => p.stage)].sort((a, b) => ['research', 'design', 'build', 'verify', 'ship', 'document'].indexOf(a) - ['research', 'design', 'build', 'verify', 'ship', 'document'].indexOf(b)));
    expect(d.plan.find((p) => p.stage === 'verify')!.capabilityIds).toContain('x.test-suite');
    expect(d.selected.every((s) => s.reasons.length >= 3)).toBe(true);
    expect(explain(d)).toMatch(/Selected:[\s\S]*Plan:/);
    expect(getDecision(sys, d.id)!.selected).toHaveLength(d.selected.length);
  });

  it('keeps a small backend fix small: at most one capability, no design or frontend machinery', () => {
    const d = routeTask(sys, 'Fix the null check in the Python date parser');
    expect(d.analysis.complexity).toBe('trivial');
    expect(d.selected.length).toBeLessThanOrEqual(1);
    expect(d.selected.map((s) => s.capabilityId)).not.toContain('x.react-frontend');
    expect(d.plan.length).toBeLessThanOrEqual(1);
  });

  it('never selects unapproved, blocked or rejected capabilities, and says why', () => {
    seed(sys, 'y.k8s-pro', 'k8s-pro', 'Optimize Kubernetes infrastructure, cluster autoscaling and helm deployment', 'devops', { status: 'registered', tags: ['kubernetes', 'devops'], quality: 99 });
    seed(sys, 'y.k8s-bad', 'k8s-bad', 'Kubernetes cluster infrastructure optimization and helm deployment', 'devops', { status: 'blocked', tags: ['kubernetes'] });
    const d = routeTask(sys, 'Optimize our Kubernetes infrastructure and cluster deployment');
    expect(d.selected.map((s) => s.capabilityId)).toEqual(['x.k8s-ops']);
    expect(d.excluded.find((e) => e.capabilityId === 'y.k8s-pro')!.reason).toMatch(/not approved/);
    expect(d.excluded.find((e) => e.capabilityId === 'y.k8s-bad')!.reason).toMatch(/blocked/);
  });

  it('treats skills already on the host as usable without approval', () => {
    seed(sys, 'local.webgl-kit', 'webgl-kit', 'Build WebGL and three.js 3d interactive scenes in the browser frontend', 'frontend', { status: 'registered', origin: 'host-inventory', tags: ['webgl', '3d'] });
    const d = routeTask(sys, 'Build an interactive WebGL 3d product viewer for the browser');
    expect(d.selected.map((s) => s.capabilityId)).toContain('local.webgl-kit');
  });

  it('does not pick two overlapping capabilities for one task', () => {
    seed(sys, 'z.react-ui-kit', 'react-ui-kit', 'Build React frontend components and dashboard UI for web application screens', 'design', { tags: ['react', 'ui', 'design'] });
    relate(sys, 'z.react-ui-kit', 'overlaps', 'x.react-frontend', 0.8, 'test');
    const d = routeTask(sys, 'Design and build a React dashboard UI with a polished visual layout for our web frontend');
    const picked = d.selected.map((s) => s.capabilityId).filter((id) => id === 'x.react-frontend' || id === 'z.react-ui-kit');
    expect(picked).toHaveLength(1);
  });

  it('records capability gaps and counts repeats', () => {
    const task = 'Build an advanced interactive WebGL product configurator with three.js';
    const d1 = routeTask(sys, task);
    expect(d1.gaps.length).toBeGreaterThan(0);
    routeTask(sys, task);
    const g = listGaps(sys, 'open');
    expect(g[0].hits).toBe(2);
    expect(g[0].domain).toBe('frontend');
  });

  it('returns nothing rather than something irrelevant', () => {
    const d = routeTask(sys, 'Translate this paragraph into formal Japanese keigo');
    expect(d.selected).toEqual([]);
  });
});

describe('activation', () => {
  it('serves one capability for one task, records it, and stores the outcome', async () => {
    const d = routeTask(sys, SAAS, { origin: 'test' });
    const a = activate(sys, { capabilityId: 'x.api-backend', decisionId: d.id, host: 'claude-code' });
    expect(a.content).toContain('Guidance body for api-backend');
    expect(a.notice).toMatch(/user's own instructions take precedence/);
    expect(recordOutcome(sys, { decisionId: d.id, outcome: 'success', detail: 'built' })).toBe(1);
    const full = getDecision(sys, d.id)!;
    expect(full.activations[0]).toMatchObject({ capability_id: 'x.api-backend', outcome: 'success', host: 'claude-code' });
    expect((await planOnlyExecutor.execute(d)).status).toBe('planned');
  });

  it('refuses to activate blocked or unapproved capabilities', () => {
    seed(sys, 'y.bad', 'bad', 'blocked thing', 'general', { status: 'blocked' });
    seed(sys, 'y.pending', 'pending', 'pending thing', 'general', { status: 'registered' });
    expect(() => activate(sys, { capabilityId: 'y.bad', host: 'claude-code' })).toThrow(ActivationError);
    expect(() => activate(sys, { capabilityId: 'y.pending', host: 'claude-code' })).toThrow(/not approved/);
    expect(() => activate(sys, { capabilityId: 'nope', host: 'claude-code' })).toThrow(/No capability/);
  });
});
