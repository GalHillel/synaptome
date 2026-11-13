import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAdapterRegistry } from '@synaptome/adapters';
import { type DiscoveryConnector, type FetchedFile, getCapability, setSetting, tempSystem } from '@synaptome/core';
import { ConnectorRegistry, scan, syncSources } from '@synaptome/discovery';
import { type Deps, dynamicTestCheck, evaluateCandidate, probeIsolation, promotionPolicy, validateRules } from '../src/index';

const MIT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software';
const f = (p: string, content: string): FetchedFile => ({ path: p, content, size: content.length });
const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: Write clear release notes from a list of merged changes. Use when the user asks for a changelog or release summary. Do not use for commit messages.\n---\n# ${name}\n\n## Workflow\n1. Group changes by type.\n2. Lead with user-visible impact.\n\n## Example\n\`\`\`\n### Added\n- Export to CSV\n\`\`\`\n\n${'Guidance line that explains the reasoning behind the structure in plain language. '.repeat(12)}\n`;

let sys: ReturnType<typeof tempSystem>;
let claudeRoot: string;
let deps: Deps;

beforeEach(() => {
  sys = tempSystem();
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synaptome-claude-'));
  fs.mkdirSync(path.join(claudeRoot, 'skills'), { recursive: true });
  const c: DiscoveryConnector = {
    id: 'fx', kind: 'fixture', title: 'Fixture', description: '', official: false,
    health: async () => ({ ok: true, detail: 'ok', authenticated: false }),
    search: async () => ({ drafts: [{ externalId: 'acme/skills:release-notes', kind: 'skill', name: 'release-notes', description: 'Release notes helper for changelog writing tasks', repo: 'acme/skills', path: 'release-notes', ref: 'a'.repeat(40), upstreamVersion: 'a'.repeat(40), publisher: 'acme', pushedAt: new Date().toISOString(), stars: 500, licenseSpdx: 'MIT' }] }),
    fetchPackage: async () => ({ files: [f('SKILL.md', skillMd('release-notes')), f('LICENSE', MIT)], skipped: [], provenance: { url: 'https://example.test/x', method: 'fixture pinned ref', verified: true } }),
  };
  deps = { connectors: new ConnectorRegistry().register(c), adapters: buildAdapterRegistry({ claudeRoot }) };
  syncSources(sys, deps.connectors);
});
afterEach(() => {
  sys.dispose();
  fs.rmSync(claudeRoot, { recursive: true, force: true });
});

async function evaluateWith(rules: unknown[], defaultEffect?: 'allow-auto' | 'require-approval') {
  setSetting(sys.db, 'policy.rules', rules);
  if (defaultEffect) setSetting(sys.db, 'policy.defaultEffect', defaultEffect);
  const r = await scan(sys, deps.connectors.get('fx'), { mode: 'broad' });
  return evaluateCandidate(sys, deps, r.candidateIds[0]);
}

describe('policy rules', () => {
  it('auto-promotes by default when every check passes, and cites the default', async () => {
    const r = await evaluateWith([]);
    expect(r.gate!.decision).toBe('auto-promote');
    expect(r.gate!.checks.find((c) => c.id === 'policy')).toMatchObject({ result: 'pass', evidence: 'no rule matched; default allow-auto' });
  });

  it('a deny rule blocks and is named as the reason', async () => {
    const r = await evaluateWith([{ id: 'no-acme', when: { publisher: 'acme' }, effect: 'deny', reason: 'not trusted here' }]);
    expect(r.gate!.decision).toBe('blocked');
    expect(r.gate!.blockers).toContain('policy no-acme');
    expect(getCapability(sys, 'acme.release-notes')!.status).toBe('registered');
  });

  it('a require-approval rule stops automatic promotion of a package that passes every other check', async () => {
    const r = await evaluateWith([{ id: 'review-skills', when: { kind: 'skill', tier: 'A' }, effect: 'require-approval' }]);
    expect(r.gate!.decision).toBe('needs-approval');
    expect(r.gate!.checks.find((c) => c.id === 'policy')!.evidence).toMatch(/rule "review-skills" \(require-approval\)/);
  });

  it('applies the first matching rule only', async () => {
    const r = await evaluateWith([
      { id: 'allow-acme', when: { publisher: 'acme' }, effect: 'allow-auto' },
      { id: 'deny-skills', when: { kind: 'skill' }, effect: 'deny' },
    ]);
    expect(r.gate!.decision).toBe('auto-promote');
  });

  it('with a require-approval default, an allow-auto rule permits automatic promotion only when every check passes', async () => {
    expect((await evaluateWith([], 'require-approval')).gate!.decision).toBe('needs-approval');
    setSetting(sys.db, 'policy.rules', [{ id: 'trusted', when: { publisher: 'acme' }, effect: 'allow-auto' }]);
    expect(promotionPolicy(sys, deps).evaluate('acme.release-notes', 'claude-code').decision).toBe('auto-promote');
  });

  it('can never loosen the gate: allow-auto on a package that fails a check still needs approval', async () => {
    await evaluateWith([]);
    // make the licence check fail
    sys.db.run("UPDATE capabilities SET record = json_set(record, '$.license.compatible', 'unknown') WHERE id = 'acme.release-notes'");
    setSetting(sys.db, 'policy.rules', [{ id: 'everything', when: { kind: 'skill' }, effect: 'allow-auto' }]);
    const g = promotionPolicy(sys, deps).evaluate('acme.release-notes', 'claude-code');
    expect(g.decision).toBe('needs-approval');
  });

  it('an unknown field in a rule never matches, so a typo cannot widen it', async () => {
    const r = await evaluateWith([{ id: 'typo', when: { publsher: 'acme' }, effect: 'deny' }]);
    expect(r.gate!.decision).toBe('auto-promote');
  });

  it('validates rules before they are saved', () => {
    expect(validateRules([{ id: 'ok', when: { kind: ['skill', 'agent'], permission: 'network' }, effect: 'require-approval' }])).toEqual([]);
    const errors = validateRules([{ id: 'a', when: { kind: 'skill' }, effect: 'deny' }, { id: 'a', when: { colour: 'red' }, effect: 'allow' }, { when: {}, effect: 'deny' }, { id: 'p', when: { namePattern: '([' }, effect: 'deny' }]).join('\n');
    for (const expected of [/duplicate id/, /unknown field "colour"/, /effect must be/, /id is required/, /at least one field/, /not a valid regular expression/]) expect(errors).toMatch(expected);
    expect(validateRules({})).toEqual(['rules must be a list']);
  });
});

describe('isolation for dynamic tests', () => {
  const fakeRun = (ok: Record<string, string>) => ((cmd: string) => ({ status: ok[cmd] ? 0 : 1, stdout: ok[cmd] ?? '' })) as any;

  it('finds Windows Sandbox, Docker and Podman without running anything untrusted', () => {
    expect(probeIsolation({ run: fakeRun({}), exists: () => false }).available).toEqual([]);
    const some = probeIsolation({ run: fakeRun({ docker: '27.1.0' }), exists: () => true });
    expect(some.available.map((a) => a.id)).toEqual(process.platform === 'win32' ? ['windows-sandbox', 'docker'] : ['docker']);
  });

  it('never passes for executable content until a dynamic test has run in isolation, and is blocked without isolation', () => {
    expect(dynamicTestCheck(false, { available: [], dynamicTestsImplemented: false, checkedAt: '' }).result).toBe('pass');
    expect(dynamicTestCheck(true, { available: [], dynamicTestsImplemented: false, checkedAt: '' })).toMatchObject({ result: 'unknown', evidence: expect.stringMatching(/^BLOCKED/) });
    expect(dynamicTestCheck(true, { available: [{ id: 'docker', detail: 'docker 27' }], dynamicTestsImplemented: false, checkedAt: '' })).toMatchObject({ result: 'unknown', evidence: expect.stringMatching(/not run: isolation is available \(docker\)/) });
    expect(dynamicTestCheck(true, { available: [{ id: 'docker', detail: 'docker 27' }], dynamicTestsImplemented: true, checkedAt: '' }).result).toBe('unknown');
  });
});
