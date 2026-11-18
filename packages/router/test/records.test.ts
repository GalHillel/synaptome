import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempSystem, upsertCapability, writeSnapshot } from '@synaptome/core';
import { activate, getDecision, recordOutcome, routeTask } from '../src/index';

function seed(s: ReturnType<typeof tempSystem>, id: string, name: string, description: string, domain: string, opts: { tags: string[] }) {
  const files = [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nGuidance body for ${name}.`, size: 1 }];
  upsertCapability(s, { id, name, description, kind: 'skill', domain, tags: opts.tags, entryFile: 'SKILL.md', quality: { total: 90 }, security: { tier: 'A', trust: 'REVIEWED_COMMUNITY' } }, { status: 'approved', origin: 'discovered', ...writeSnapshot(s, id, files), body: files[0].content });
}

// What the routing records claim must match what happened (plan NG, M1; audit H1, H2).
let sys: ReturnType<typeof tempSystem>;
beforeEach(() => {
  sys = tempSystem();
  seed(sys, 'x.api-backend', 'api-backend', 'Design and build backend REST API services, endpoints and server authentication', 'backend', { tags: ['backend', 'api', 'server'] });
  seed(sys, 'x.k8s-ops', 'k8s-ops', 'Operate Kubernetes clusters, helm charts and deployment pipelines', 'devops', { tags: ['kubernetes', 'devops'] });
});
afterEach(() => sys.dispose());

describe('activation attribution (H2)', () => {
  it('credits a load to the decision that selected the capability', () => {
    const d = routeTask(sys, 'Build REST API endpoints with server authentication for the backend');
    expect(d.selected.map((s) => s.capabilityId)).toContain('x.api-backend');
    const a = activate(sys, { capabilityId: 'x.api-backend', decisionId: d.id, host: 'test' });
    expect(sys.db.get<any>('SELECT decision_id, reason FROM activations WHERE id=?', a.activationId)).toMatchObject({ decision_id: d.id, reason: null });
  });

  it('records a load the decision did not select without crediting the decision, and says why', () => {
    const d = routeTask(sys, 'Build REST API endpoints with server authentication for the backend');
    expect(d.selected.map((s) => s.capabilityId)).not.toContain('x.k8s-ops');
    const a = activate(sys, { capabilityId: 'x.k8s-ops', decisionId: d.id, host: 'test' });
    const row = sys.db.get<any>('SELECT decision_id, reason FROM activations WHERE id=?', a.activationId);
    expect(row.decision_id).toBeNull();
    expect(row.reason).toMatch(new RegExp(`not selected by decision #${d.id}`));
  });

  it('does not credit a decision that does not exist', () => {
    const a = activate(sys, { capabilityId: 'x.k8s-ops', decisionId: 99999, host: 'test' });
    expect(sys.db.get<any>('SELECT decision_id, reason FROM activations WHERE id=?', a.activationId)).toMatchObject({ decision_id: null, reason: 'decision #99999 does not exist' });
  });
});

describe('outcomes (H1)', () => {
  it('keeps an outcome reported for a decision with no load, marked as reported (not verified)', () => {
    const d = routeTask(sys, 'Build REST API endpoints with server authentication for the backend');
    expect(recordOutcome(sys, { decisionId: d.id, outcome: 'success', detail: 'done' })).toBe(0);
    expect((getDecision(sys, d.id)!.analysis as any).outcome).toMatchObject({ value: 'success', detail: 'done', activations: 0, evidence: 'reported' });
  });

  it('also updates the loads of that decision when there are some', () => {
    const d = routeTask(sys, 'Build REST API endpoints with server authentication for the backend');
    activate(sys, { capabilityId: 'x.api-backend', decisionId: d.id, host: 'test' });
    expect(recordOutcome(sys, { decisionId: d.id, outcome: 'partial' })).toBe(1);
    expect((getDecision(sys, d.id)!.analysis as any).outcome).toMatchObject({ value: 'partial', activations: 1 });
  });
});
