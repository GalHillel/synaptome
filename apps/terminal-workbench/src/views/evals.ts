import { type ViewDef, type Line, mark, dim, mid, strong, when, H, P, KV, BLANK, section } from '../kit';

const split = (x: any) => `${x.positive}+ ${x.negative}- ${x.behaviour} graded`;
const result = (r: any) =>
  r.summary?.splits?.heldout ? `held-out ${r.summary.splits.heldout.variants.map((v: any) => `${v.variant} ${v.passed}/${v.total}`).join(', ')}`
    : r.summary?.variants ? r.summary.variants.map((v: any) => `${v.variant} ${v.passed}/${v.total}`).join(', ')
      : r.summary?.blocker ?? '';

/** Evaluation Lab: evaluation sets (split and authors) and every evaluation run. Promotion is decided on held-out cases only. */
export const view: ViewDef = {
  id: 'evals', title: 'Evaluation Lab', filterHint: 'filter by subject', empty: 'No evaluation sets or runs yet. Sets are created when a forge candidate is checked or with synaptome evalset add.',
  columns: [{ title: 'Subject', width: 0 }, { title: 'Status / training', width: 22 }, { title: 'Held-out / result', width: 30, optional: true }, { title: 'When', width: 12, optional: true }],
  async load(api, f) {
    const [sets, runs] = await Promise.all([api.call('evalsets.list'), api.call('evals.list', { limit: 60 })]);
    const q = f.toLowerCase();
    const keep = (s: string) => !q || s.toLowerCase().includes(q);
    const s = sets.filter((x: any) => keep(x.subjectId));
    const r = runs.filter((x: any) => keep(`${x.subjectId} ${x.suite}`));
    return [
      section('Evaluation sets', s.length),
      ...s.map((x: any) => ({ id: `set:${x.subjectId}`, raw: { type: 'set', ...x }, cells: [strong(x.subjectId), mid(`train ${split(x.train)}`), { t: `held-out ${split(x.heldout)}` }, dim(`${x.authors.length} author(s)`)] })),
      section('Evaluation runs', r.length),
      ...r.map((x: any) => ({ id: `run:${x.id}`, raw: { type: 'run', ...x }, cells: [strong(`${x.subjectId}  ${x.suite}`), mark(x.status), mid(result(x)), dim(when(x.createdAt))] })),
    ];
  },
  async inspect(api, item) {
    const x = item.raw;
    if (x.type === 'run') {
      const variants: any[] = x.summary?.splits?.heldout?.variants ?? x.summary?.variants ?? [];
      return [
        [strong(x.subjectId)], P(`run ${x.id}, suite ${x.suite}`, 'dim'), BLANK, [mark(x.status)], KV('when', when(x.createdAt)),
        ...(x.summary?.blocker ? [P(x.summary.blocker, 'warn')] : []),
        ...(variants.length ? [BLANK, H(x.summary?.splits?.heldout ? 'Held-out result' : 'Result'), ...variants.map((v: any) => [{ t: `${v.variant.padEnd(12)} `, b: true }, { t: `${v.passed}/${v.total} passed`, c: v.passed === v.total ? 'ok' : 'mid' }] as Line)] : []),
        ...(x.summary?.splits?.train ? [BLANK, H('Training result'), ...x.summary.splits.train.variants.map((v: any) => P(`${v.variant.padEnd(12)} ${v.passed}/${v.total} passed`, 'mid'))] : []),
      ];
    }
    const d = await api.call('evalsets.get', { id: x.subjectId });
    return [
      [strong(x.subjectId)], BLANK,
      KV('training', `${d.summary.train.positive} positive, ${d.summary.train.negative} negative, ${d.summary.train.behaviour} graded`),
      KV('held-out', `${d.summary.heldout.positive} positive, ${d.summary.heldout.negative} negative, ${d.summary.heldout.behaviour} graded`),
      ...d.summary.authors.map((a: any) => KV('author', `${a.author}: ${a.cases} case(s) in ${a.splits.join(', ')}`)),
      BLANK, H(`Cases ${d.cases.length}`),
      ...d.cases.flatMap((c: any) => [
        [mark(c.split === 'heldout' ? 'waiting' : 'pending', c.split === 'heldout' ? 'held-out' : 'training'), { t: `  ${c.id}  ${c.kind}`, c: 'dim' }] as Line,
        P(`   ${c.prompt}`),
        ...(c.must?.length ? [P(`   must: ${c.must.join(' | ')}${c.mustNot?.length ? `; must not: ${c.mustNot.join(' | ')}` : ''}`, 'dim')] : []),
      ]),
    ];
  },
  actions: () => [],
};
