import { type EvalCase, type Sys, emit, nowIso, pj } from '@synaptome/core';

/* =====================================================================
 * Evaluation sets: the cases a capability is judged by, each with a split and an author.
 * Held-out cases decide promotion, so they may never be written by the run that wrote the capability.
 * ===================================================================== */

export type Split = 'train' | 'heldout';
export type CaseKind = 'positive' | 'negative' | 'behaviour';
export interface StoredCase {
  id: string;
  split: Split;
  kind: CaseKind;
  prompt: string;
  must: string[];
  mustNot: string[];
  author: string;
  createdAt: string;
}
export interface CaseInput {
  id?: string;
  kind: CaseKind;
  prompt: string;
  must?: string[];
  mustNot?: string[];
}

export class EvalSetError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const setIdFor = (subjectId: string) => `es-${subjectId}`;
export function evalSetId(sys: Sys, subjectId: string): string {
  const id = setIdFor(subjectId);
  sys.db.run('INSERT OR IGNORE INTO eval_sets (id, subject_id, created_at) VALUES (?,?,?)', id, subjectId, nowIso());
  return id;
}

const compiles = (re: string) => {
  try {
    new RegExp(re, 'i');
    return true;
  } catch {
    return false;
  }
};

/**
 * Adds cases. Invalid ones are returned with the reason instead of being stored. When `generatedBy` names the run that
 * wrote the capability, that run may not author held-out cases.
 */
export function addEvalCases(sys: Sys, subjectId: string, cases: CaseInput[], opts: { split: Split; author: string; generatedBy?: string | null }): { added: number; rejected: { prompt: string; why: string }[] } {
  if (!opts.author.trim()) throw new EvalSetError('every case needs an author');
  if (opts.split === 'heldout' && opts.generatedBy && opts.author === opts.generatedBy) throw new EvalSetError(`held-out cases may not be written by the run that wrote the capability (${opts.generatedBy})`);
  const set = evalSetId(sys, subjectId);
  const existing = new Set(sys.db.all<{ prompt: string }>('SELECT prompt FROM eval_cases WHERE set_id=?', set).map((r) => r.prompt.trim().toLowerCase()));
  const rejected: { prompt: string; why: string }[] = [];
  let added = 0;
  sys.db.tx(() => {
    for (const c of cases) {
      const prompt = String(c?.prompt ?? '').trim();
      const must = (c?.must ?? []).map(String);
      const mustNot = (c?.mustNot ?? []).map(String);
      const why = !prompt ? 'empty prompt' : !['positive', 'negative', 'behaviour'].includes(c.kind) ? `unknown kind "${c.kind}"` : c.kind === 'behaviour' && !must.length ? 'a behaviour case needs at least one "must" pattern' : [...must, ...mustNot].find((r) => !compiles(r)) ? 'a pattern is not a valid regular expression' : existing.has(prompt.toLowerCase()) ? 'the same prompt is already in the set' : null;
      if (why) {
        rejected.push({ prompt: prompt.slice(0, 80), why });
        continue;
      }
      const n = sys.db.get<{ n: number }>('SELECT COUNT(*) n FROM eval_cases WHERE set_id=?', set)!.n + 1;
      const id = c.id && /^[\w.-]{1,60}$/.test(c.id) && !sys.db.get('SELECT 1 FROM eval_cases WHERE set_id=? AND id=?', set, c.id) ? c.id : `${opts.split === 'heldout' ? 'h' : 't'}${c.kind[0]}-${n}`;
      sys.db.run('INSERT INTO eval_cases (set_id, id, split, kind, prompt, must, must_not, author, created_at) VALUES (?,?,?,?,?,?,?,?,?)', set, id, opts.split, c.kind, prompt, JSON.stringify(must), JSON.stringify(mustNot), opts.author, nowIso());
      existing.add(prompt.toLowerCase());
      added++;
    }
  });
  emit(sys.db, 'eval.cases-added', subjectId, { split: opts.split, author: opts.author, added, rejected: rejected.length });
  return { added, rejected };
}

export function listEvalCases(sys: Sys, subjectId: string, f: { split?: Split; kind?: CaseKind } = {}): StoredCase[] {
  return sys.db
    .all<any>('SELECT * FROM eval_cases WHERE set_id=? ORDER BY created_at, id', setIdFor(subjectId))
    .filter((r) => (!f.split || r.split === f.split) && (!f.kind || r.kind === f.kind))
    .map((r) => ({ id: r.id, split: r.split, kind: r.kind, prompt: r.prompt, must: pj(r.must, []), mustNot: pj(r.must_not, []), author: r.author, createdAt: r.created_at }));
}

export function removeEvalCase(sys: Sys, subjectId: string, caseId: string): boolean {
  return Number(sys.db.run('DELETE FROM eval_cases WHERE set_id=? AND id=?', setIdFor(subjectId), caseId).changes) > 0;
}

export function evalSetSummary(sys: Sys, subjectId: string) {
  const rows = listEvalCases(sys, subjectId);
  const count = (split: Split, kind: CaseKind) => rows.filter((r) => r.split === split && r.kind === kind).length;
  return {
    subjectId,
    total: rows.length,
    train: { positive: count('train', 'positive'), negative: count('train', 'negative'), behaviour: count('train', 'behaviour') },
    heldout: { positive: count('heldout', 'positive'), negative: count('heldout', 'negative'), behaviour: count('heldout', 'behaviour') },
    authors: [...new Set(rows.map((r) => r.author))].map((a) => ({ author: a, cases: rows.filter((r) => r.author === a).length, splits: [...new Set(rows.filter((r) => r.author === a).map((r) => r.split))] })),
  };
}

export const toEvalCase = (c: StoredCase): EvalCase => ({ id: c.id, prompt: c.prompt, must: c.must, mustNot: c.mustNot });
