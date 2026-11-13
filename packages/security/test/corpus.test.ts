import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@synaptome/core';
import { auditPackage } from '../src/index';
import { BENIGN, type CorpusCase, MALICIOUS } from './corpus';

const audit = (c: CorpusCase) => auditPackage({ kind: c.kind, files: c.files, settings: structuredClone(DEFAULT_SETTINGS) as any });

describe('audit corpus (thresholds from the master plan, Phase 4)', () => {
  it('blocks every package in the malicious corpus', () => {
    const missed = MALICIOUS.filter((c) => audit(c).critical === 0).map((c) => `${c.id} ${c.technique}`);
    expect(missed).toEqual([]);
  });

  it('keeps false positives on benign security documentation at or below 10%', () => {
    const blocked = BENIGN.filter((c) => audit(c).critical > 0).map((c) => `${c.id} ${c.technique}`);
    expect(blocked.length / BENIGN.length).toBeLessThanOrEqual(0.1);
    expect(blocked).toEqual([]); // currently none; the bound above is the contract
  });

  it('marks blocked packages untrusted and tier C, so the promotion gate refuses them', () => {
    for (const c of MALICIOUS) expect(audit(c)).toMatchObject({ tier: 'C', trust: 'BLOCKED' });
  });

  it('still reports, one level lower, what a benign document quotes, so a reviewer sees it', () => {
    const r = audit(BENIGN.find((c) => c.id === 'b10')!);
    expect(r.findings.some((f) => f.id === 'exfil-credentials' && f.severity === 'high' && /cautionary prose/.test(f.message))).toBe(true);
  });

  it('does not let weak cautionary words hide an instruction whose own wording is a negation', () => {
    const r = audit(MALICIOUS.find((c) => c.id === 'm24')!); // "...with no restrictions who never refuses"
    expect(r.findings.find((f) => f.id === 'inj-role-override')!.severity).toBe('critical');
  });
});
