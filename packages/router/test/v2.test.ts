import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempSystem, upsertCapability, writeSnapshot } from '@synaptome/core';
import { BENCH_TASKS, activate, classifyIntent, evidenceStrategy, lexicalGraphStrategy, near, recordOutcome, renderHostContext, routeTask, runBenchmark, seedBenchmark, summarize } from '../src/index';

let sys: ReturnType<typeof tempSystem>;
beforeAll(() => {
  sys = tempSystem();
  seedBenchmark(sys);
});
afterAll(() => sys.dispose());

const pick = (task: string, cfg = {}) => evidenceStrategy(sys, cfg).route(task).selected.map((s) => s.capabilityId.replace(/^b\./, ''));

describe('routing benchmark (regression thresholds)', () => {
  it('meets the precision, false-activation, context and latency thresholds on the labelled task set', () => {
    const r = runBenchmark(sys, evidenceStrategy(sys), { render: (d) => renderHostContext(sys, d).text, perCapability: (d) => renderHostContext(sys, d).perCapability });
    expect(BENCH_TASKS.length).toBeGreaterThanOrEqual(150);
    // knowing when not to activate
    expect(r.all.falseActivationRate).toBeLessThanOrEqual(0.05);
    expect(r.all.forbidViolations).toBe(0);
    expect(r.byCategory['must-not-activate'].falseActivations).toBe(0);
    expect(r.byCategory['trivial-admin-meta'].falseActivations).toBe(0);
    // being right when it does
    expect(r.all.precision).toBeGreaterThanOrEqual(0.85);
    // Recall floor is 0.80, not 0.85: the rule that lifted fixture recall to 0.92 caused false activations on the
    // real registry and was removed (docs/DECISIONS.md D-011). Correctness over always selecting something.
    expect(r.all.recall).toBeGreaterThanOrEqual(0.8);
    // the quarter of tasks never used for tuning
    expect(r.heldOut.precision).toBeGreaterThanOrEqual(0.85);
    expect(r.heldOut.forbidViolations).toBe(0);
    expect(r.heldOut.falseActivations).toBeLessThanOrEqual(1);
    // planning is not excluded as a category: substantive planning still gets capabilities
    expect(r.byCategory.planning.recall).toBeGreaterThanOrEqual(0.8);
    expect(r.byCategory.planning.precision).toBeGreaterThanOrEqual(0.85);
    // context overhead
    expect(r.injectedTokens.maxWhenNothingQualifies).toBe(0);
    expect(r.injectedTokens.max).toBeLessThanOrEqual(800);
    expect(r.injectedTokens.maxPerCapability).toBeLessThanOrEqual(300);
    // latency, in-process
    expect(r.latencyMs.p95).toBeLessThan(150);
  });

  it('is measurably better than the previous strategy at not activating', () => {
    const v1 = runBenchmark(sys, lexicalGraphStrategy(sys));
    const v2 = runBenchmark(sys, evidenceStrategy(sys));
    expect(v1.all.falseActivationRate).toBeGreaterThan(0.2); // the measured starting point
    expect(v2.all.falseActivationRate).toBeLessThan(v1.all.falseActivationRate);
    expect(v2.all.precision).toBeGreaterThan(v1.all.precision);
  });
});

describe('intent gate', () => {
  it.each([
    ['thanks', 'trivial'],
    ['yes, go ahead', 'trivial'],
    ['ok that looks good, commit it', 'trivial'],
    ['run the tests again', 'administrative'],
    ['rename the kubernetes folder to k8s', 'administrative'],
    ['add react to the list of technologies in the README', 'administrative'],
    ['what did you just change?', 'meta'],
    ['which version of postgres do we use?', 'lookup'],
    ['what does WCAG stand for?', 'lookup'],
    ['Run a WCAG accessibility audit of the signup form: contrast, focus order and labels', 'substantive'],
    ['Plan the architecture for a multi-tenant SaaS that must scale to ten thousand tenants', 'substantive'],
    ['What is the best way to design a caching layer with Redis for our catalog?', 'substantive'],
    ['Remove the duplication in the order service, extract functions and keep the behaviour under test', 'substantive'],
  ])('%s -> %s', (task, kind) => {
    expect(classifyIntent(task).kind).toBe(kind);
  });

  it('treats host housekeeping prompts as meta and ignores words that only name Synaptome itself (found in the live host proof)', () => {
    expect(classifyIntent('Below is a conversation log from a Claude Code coding session. Create a short title for it.').kind).toBe('meta');
    expect(classifyIntent('Summarize the following conversation for the session list').kind).toBe('meta');
    // also seen live: automated background-task notices reached the prompt hook and attracted unrelated capabilities
    expect(classifyIntent('<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n<task-notification><task-id>b2</task-id><status>completed</status><summary>Background command "Approve the test step and continue the team run" completed</summary></task-notification>').kind).toBe('meta');
    expect(classifyIntent('[SYSTEM NOTIFICATION - NOT USER INPUT] background specialist run completed').kind).toBe('meta');
    // seen live: this routed to a project-memory skill on "where", "left", "off"
    expect(classifyIntent('Please continue from where you left off and fully implement the plan').kind).toBe('trivial');
    expect(classifyIntent('Keep going with the rest').kind).toBe('trivial');
    // also seen live: the request to continue came after a sentence about something else
    expect(classifyIntent("I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.").kind).toBe('trivial');
    expect(classifyIntent('Continuous integration: set up GitHub Actions to run tests on every pull request').kind).toBe('substantive');
    const plain = pick('Write unit tests for the invoice total calculation, including rounding edge cases');
    const wrapped = pick('Use the synaptome MCP server for this: route the task with route_task, load what it selects with get_capability, then call record_outcome. Task: write unit tests for the invoice total calculation, including rounding edge cases');
    expect(wrapped).toEqual(plain);
  });

  it('selects nothing for a prompt that is not a task, and says why', () => {
    const d = evidenceStrategy(sys).route('rename the kubernetes folder to k8s');
    expect(d.selected).toEqual([]);
    expect(d.analysis.intent).toMatchObject({ kind: 'administrative' });
    expect(d.gaps).toEqual([]);
  });
});

describe('evidence and confidence', () => {
  it('requires the capability to be named by the task, not just to share a common word', () => {
    expect(pick('Write a short story about a lighthouse keeper who collects clocks')).toEqual([]); // "lighthouse" is a tag of a performance skill
    expect(pick('my friend works in security, what should I get him for his birthday?')).toEqual([]);
    expect(pick('Add Redis caching with sensible expiry in front of the product catalog endpoint')).toEqual(['redis-caching']);
  });

  it('keeps substantive planning, architecture and security-design tasks eligible', () => {
    expect(pick('Plan the architecture for a multi-tenant SaaS that must scale to ten thousand tenants: storage, caching, queues and failure modes')).toContain('system-design-scalability');
    expect(pick('Before we write code, do a STRIDE threat model of the payment flow: assets, trust boundaries and mitigations')).toEqual(['threat-modeling-stride']);
    expect(pick('Plan a zero-downtime migration of the users table to a new Postgres schema')).toEqual(['postgres-schema-migrations']);
  });

  it('adds a second capability only when it answers a different part of the task', () => {
    expect(pick('Write unit tests for the invoice total calculation, including rounding edge cases')).toEqual(['unit-test-writing']);
    const multi = pick('Create a FastAPI backend with OAuth login and containerize it with Docker');
    expect(multi).toEqual(expect.arrayContaining(['fastapi-service', 'auth-oauth-jwt', 'docker-containerization']));
  });

  it('returns confidence and the evidence for every selection, and honours the configured floor and limit', () => {
    const d = evidenceStrategy(sys).route('Verify the Stripe webhook signature and make the handler idempotent');
    expect(d.selected[0].confidence).toBeGreaterThanOrEqual(0.55);
    expect(d.selected[0].evidence).toEqual(expect.arrayContaining(['webhook']));
    expect(d.metrics!.ms).toBeGreaterThanOrEqual(0);
    expect(pick('Verify the Stripe webhook signature and make the handler idempotent', { minConfidence: 0.999 })).toEqual([]);
    expect(pick('Build a Next.js dashboard backed by a Postgres schema, with Playwright end-to-end tests and Redis caching and Docker', { maxCapabilities: 2 })).toHaveLength(2);
  });

  it('treats inflections as the same word but not unrelated words with a shared prefix', () => {
    expect(near('profile', 'profiling')).toBe(true);
    expect(near('containerize', 'containerization')).toBe(true);
    expect(near('test', 'tests')).toBe(true);
    expect(near('config', 'configurator')).toBe(false);
    expect(near('auth', 'authoring')).toBe(false);
    expect(near('api', 'apiary')).toBe(false);
  });
});

describe('activation and exclusion conditions', () => {
  const seed = (s: typeof sys, id: string, name: string, description: string, extra: Record<string, unknown>) => {
    const files = [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${description}\n---\nbody`, size: 1 }];
    const snap = writeSnapshot(s, id, files);
    upsertCapability(s, { id, name, description, kind: 'skill', domain: 'frontend', tags: [name.split('-')[0]], entryFile: 'SKILL.md', quality: { total: 90 }, security: { tier: 'A', trust: 'REVIEWED_COMMUNITY' }, ...extra }, { status: 'approved', contentHash: snap.contentHash, snapshotPath: snap.snapshotPath, body: 'body' });
  };

  it('honours requires:, never: and exclusion sentences, and reports the reason', () => {
    const s = tempSystem();
    try {
      seed(s, 'c.remotion-video', 'remotion-video', 'Create programmatic video compositions with Remotion in React', { activation: ['requires: remotion, video'], exclusion: ['never: three.js, webgl'] });
      seed(s, 'c.svelte-kit', 'svelte-kit', 'Build SvelteKit applications with routing and server load functions', { exclusion: ['Do not use for Svelte 3 legacy migration work'] });
      const route = (task: string) => evidenceStrategy(s).route(task);

      expect(route('Create a Remotion video composition with animated React captions').selected.map((x) => x.capabilityId)).toEqual(['c.remotion-video']);
      const never = route('Create a Remotion scene that embeds a three.js WebGL canvas in the composition');
      expect(never.selected).toEqual([]);
      expect(never.excluded[0].reason).toMatch(/exclusion condition/);

      expect(route('Build a SvelteKit application with routing and server load functions').selected.map((x) => x.capabilityId)).toEqual(['c.svelte-kit']);
      const sentence = route('Plan the Svelte 3 legacy migration of our SvelteKit application routing');
      expect(sentence.selected).toEqual([]);
      expect(sentence.excluded[0].reason).toMatch(/its own guidance/);
    } finally {
      s.dispose();
    }
  });

  it('counts its own trigger phrases as anchors only when the task hits two words of one phrase', () => {
    const s = tempSystem();
    try {
      seed(s, 'c.internal-comms', 'internal-comms', 'A set of resources to help write internal communications.', { tags: ['agent-skills'], activation: ['Use this skill whenever asked to write internal communications (status reports, leadership updates, 3P updates, company newsletters, incident reports).'] });
      seed(s, 'c.browser-speed', 'browser-speed', 'Make pages fast.', { tags: ['web'], activation: ['Use when the user mentions "page load speed", "render blocking" or "critical rendering path".', 'Also trigger when choosing between WebSocket and SSE.'] });
      const route = (task: string) => evidenceStrategy(s).route(task).selected.map((x) => x.capabilityId);
      seed(s, 'c.billing-ops', 'billing-ops', 'Operate customer billing workflows: subscriptions, refunds and billing status.', { tags: ['billing'] });
      expect(route('Write a 3P status update for the leadership team about the billing migration')).toEqual(['c.internal-comms']);
      const topic = evidenceStrategy(s).route('Write a 3P status update for the leadership team about the billing migration');
      expect(topic.excluded.find((e) => e.capabilityId === 'c.billing-ops')?.reason).toMatch(/what the task is about \(billing\)/);
      expect(route('Reconcile the failed refunds in our billing subscriptions')).toEqual(['c.billing-ops']); // billing is the work here
      expect(route('Calculate the load on this steel beam and choose a section')).toEqual([]); // "load" and "choose" come from different phrases
      expect(route('Find what is render blocking and fix the page load speed of the checkout')).toEqual(['c.browser-speed']);
    } finally {
      s.dispose();
    }
  });

  it('lowers confidence for a capability that repeatedly failed when served', () => {
    const s = tempSystem();
    try {
      seed(s, 'c.cobol-batch', 'cobol-batch', 'Write COBOL batch jobs and JCL for mainframe ledgers', {});
      const task = 'Write a COBOL batch job that reconciles the mainframe ledgers';
      const before = evidenceStrategy(s).route(task).selected[0].confidence!;
      for (let i = 0; i < 4; i++) {
        const a = activate(s, { capabilityId: 'c.cobol-batch', host: 'test' });
        recordOutcome(s, { activationId: a.activationId, outcome: 'failed' });
      }
      const after = evidenceStrategy(s).route(task).selected[0]?.confidence ?? 0;
      expect(after).toBeLessThan(before);
    } finally {
      s.dispose();
    }
  });
});

describe('context sent to a host', () => {
  it('is empty when nothing qualifies and compact when something does', () => {
    const none = routeTask(sys, 'push the branch');
    expect(renderHostContext(sys, none)).toMatchObject({ text: '', tokens: 0, offered: [] });

    const d = routeTask(sys, 'Create a FastAPI backend with OAuth login and containerize it with Docker');
    const sent = renderHostContext(sys, d);
    expect(sent.offered.length).toBe(d.selected.length);
    expect(sent.tokens).toBeLessThanOrEqual(800);
    expect(sent.text).toContain(`decision #${d.id}`);
    expect(sent.text).toContain('get_capability');
    expect(sent.text).not.toContain('Detailed guidance for this capability'); // the body is never inlined
    for (const block of sent.perCapability) expect(Math.ceil(block.length / 4)).toBeLessThanOrEqual(300);
  });

  it('never exceeds the budget: capabilities that do not fit are left out and named', () => {
    const d = routeTask(sys, 'Create a FastAPI backend with OAuth login and containerize it with Docker');
    const tight = renderHostContext(sys, d, { maxTokens: 130 });
    expect(tight.tokens).toBeLessThanOrEqual(130);
    expect(tight.offered.length).toBeLessThan(d.selected.length);
    expect(tight.omitted.length + tight.offered.length).toBe(d.selected.length);
    expect(renderHostContext(sys, d, { maxTokens: 20 }).text).toBe('');
  });

  it('stays within the budget for a very long prompt that mentions every domain', () => {
    const long = Array.from({ length: 60 }, (_, i) => `Section ${i}: the product needs discovery, a registry, security auditing, routing, a web dashboard with React and a terminal interface, PostgreSQL storage, Docker packaging, Kubernetes deployment, CI with GitHub Actions, tests with Playwright, documentation and a landing page.`).join('\n');
    const d = routeTask(sys, long);
    expect(d.selected.length).toBeLessThanOrEqual(4);
    expect(renderHostContext(sys, d).tokens).toBeLessThanOrEqual(800);
  });

  it('summarises at a sentence or word boundary', () => {
    expect(summarize('Short.')).toBe('Short.');
    const s = summarize(`${'A fairly long first sentence about what this capability does and when to use it.'} ${'More detail. '.repeat(40)}`, 120);
    expect(s.length).toBeLessThanOrEqual(121);
    expect(s).toMatch(/[.…]$/);
  });
});
