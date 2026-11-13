import type { Api } from '@synaptome/service';
import { type ViewDef, type Line, mark, dim, mid, strong, pct, H, P, KV, BLANK } from '../kit';

export const view: ViewDef = {
  id: 'forge', title: 'Forge', filterHint: 'filter forge candidates', empty: 'No forge candidates. Create one with: synaptome forge new "<gap>"',
  columns: [{ title: 'Candidate', width: 0 }, { title: 'State', width: 15 }, { title: 'Activation', width: 11, optional: true }, { title: 'Baseline', width: 26, optional: true }],
  async load(api, f) {
    const list = await api.call('forge.list');
    return list.filter((c: any) => !f || c.name.includes(f.toLowerCase())).map((c: any) => ({ id: c.id, raw: c, cells: [strong(c.name), mark(c.state), c.record.activation ? mid(`${pct(c.record.activation.positiveRate)}/${pct(c.record.activation.negativeRate)}`) : dim('untested'), c.record.baseline?.summary ? mid(c.record.baseline.summary.variants.map((v: any) => `${v.variant} ${v.passed}/${v.total}`).join(', ')) : dim(c.record.baseline ? 'blocked' : 'not run')] }));
  },
  async inspect(_api, item) {
    const c = item.raw;
    const r = c.record;
    return [
      [strong(c.name)], P(c.id, 'dim'), BLANK, [mark(c.state)], KV('gap', c.gap), KV('author', r.author), BLANK,
      ...(c.decision ? [H(`Decision: ${c.decision.verdict}`), ...c.decision.reasons.map((x: string) => P(`- ${x}`, c.decision.verdict === 'promote' ? 'ok' : 'warn')), BLANK] : []),
      H('Structure'), r.lint ? [mark(r.lint.ok ? 'pass' : 'fail', r.lint.ok ? 'passes' : 'fails')] : P('Not checked.', 'mid'), ...(r.lint?.problems ?? []).map((p: string) => P(`- ${p}`, 'warn')),
      BLANK, H('Security screening'), P(r.audit?.summary ?? 'Not screened.', 'mid'),
      BLANK, H('Activation tests'), ...(r.activation ? [...r.activation.positives.map((p: any) => [mark(p.passed ? 'pass' : 'fail', 'route   '), { t: ` ${p.prompt}` }] as Line), ...r.activation.negatives.map((p: any) => [mark(p.passed ? 'pass' : 'fail', 'stay out'), { t: ` ${p.prompt}` }] as Line)] : [P('Not tested.', 'mid')]),
      BLANK, H('Baseline comparison'), ...(r.baseline ? (r.baseline.status === 'blocked' ? [P(`Blocked (${r.baseline.runner}): ${r.baseline.blocker}`, 'warn')] : [KV('runner', r.baseline.runner), ...r.baseline.summary.variants.map((v: any) => KV(v.variant, `${v.passed} of ${v.total} cases pass`)), KV('lift', r.baseline.summary.lift), P(r.baseline.summary.note, 'dim')]) : [P('Not run.', 'mid')]),
      BLANK, H('Workspace'), P(c.path, 'dim'),
    ];
  },
  actions(item) {
    if (!item || ['promoted', 'rejected'].includes(item.raw.state)) return [];
    return [
      { label: 'Run checks', hint: 'lint, security screening, activation tests', run: async (api) => `checks finished: ${(await api.call('forge.check', { id: item.id })).state}` },
      { label: 'Decide on evidence', hint: 'promote, reject or hold', confirm: ['Applies the forge rules to the recorded evidence'], run: async (api) => `decision: ${(await api.call('forge.decide', { id: item.id })).decision.verdict}` },
      { label: 'Reject', input: { label: 'Reason', required: true }, confirm: [`Reject ${item.raw.name}`], run: async (api, reason) => `decision: ${(await api.call('forge.decide', { id: item.id, reject: reason })).decision.verdict}` },
    ];
  },
};
