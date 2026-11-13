import type { Api } from '@synaptome/service';
import { type ViewDef, type Action, type Line, mark, dim, mid, strong, H, P, KV, BLANK, section } from '../kit';

export const view: ViewDef = {
  id: 'workflows', title: 'Workflows', filterHint: 'filter runs and workflows', empty: 'No workflows.',
  columns: [{ title: 'Run / workflow', width: 0 }, { title: 'Status', width: 13 }, { title: 'Started', width: 17, optional: true }, { title: 'Note', width: 34, optional: true }],
  async load(api, f) {
    const [runs, defs] = await Promise.all([api.call('workflows.runs', { limit: 60 }), api.call('workflows.list')]);
    const q = f.toLowerCase();
    const keep = (s: string) => !q || s.toLowerCase().includes(q);
    const r = runs.filter((x: any) => keep(`${x.id} ${x.workflowId}`));
    const d = defs.workflows.filter((w: any) => keep(`${w.id} ${w.title}`));
    return [
      section('Runs', r.length),
      ...r.map((x: any) => ({ id: x.id, raw: { type: 'run', ...x }, cells: [strong(`${x.workflowId}  ${x.id}`), mark(x.status), mid(x.createdAt.slice(0, 16).replace('T', ' ')), mid(x.error ?? '')] })),
      section('Workflows', d.length),
      ...d.map((w: any) => ({ id: `wf:${w.id}`, raw: { type: 'workflow', ...w }, cells: [strong(w.title), dim(`${w.steps.length} steps`), mid(w.id), dim(w.permissions.join(', '))] })),
    ];
  },
  async inspect(api, item) {
    if (item.raw.type === 'workflow') {
      const w = item.raw;
      return [[strong(w.title)], P(w.id, 'dim'), BLANK, P(w.description, 'mid'), BLANK, KV('permissions', w.permissions.join(', ') || 'none'), KV('inputs', Object.entries(w.inputs).map(([k, v]: any) => `${k} (${v.type}${v.required ? '' : ', optional'})`).join(', ') || 'none'), BLANK, H('Steps'), ...w.steps.map((s: any) => P(`${s.id.padEnd(10)} ${s.kind.padEnd(9)} ${s.needs.length ? `after ${s.needs.join(', ')}` : ''}${s.permissions.length ? `  [${s.permissions.join(', ')}]` : ''}`, 'mid'))];
    }
    const v = await api.call('workflows.run', { id: item.id });
    const t = await api.call('workflows.trace', { id: item.id });
    const traceLines: Line[] = t.calls.length
      ? [BLANK, H('Agent calls'), KV('tokens', `${t.totals.tokens}${t.budget?.tokens ? ` of ${t.budget.tokens}` : ''}`), KV('cost', t.totals.usd === null ? 'unknown (no price configured)' : `$${t.totals.usd.toFixed(4)}`), ...t.calls.map((c: any) => [mark(c.ok ? 'succeeded' : 'failed'), { t: `  ${c.agent.padEnd(12)} ${String((c.inputTokens ?? 0) + (c.outputTokens ?? 0)).padStart(8)} tok  ${Math.round((c.ms ?? 0) / 1000)} s  ${c.provider}`, c: 'mid' }] as Line), ...(Object.keys(t.board).length ? [BLANK, H('Team notes'), ...Object.entries(t.board).map(([k, x]: any) => P(`${k}: ${x.value}`, 'mid'))] : [])]
      : [];
    return [
      [strong(v.title)], P(v.id, 'dim'), BLANK, [mark(v.status)], ...(v.error ? [P(v.error, v.status === 'failed' ? 'warn' : 'mid')] : []), KV('inputs', JSON.stringify(v.inputs)), KV('granted', v.granted.join(', ') || 'none'), KV('started', `${v.createdAt.slice(0, 19).replace('T', ' ')} by ${v.startedBy}`), BLANK, H('Steps'),
      ...v.steps.flatMap((s: any) => [
        [mark(s.status), { t: `  ${s.id}`, b: true }, { t: s.attempts > 1 ? `  (${s.attempts} attempts)` : '', c: 'dim' }] as Line,
        ...(s.error ? [P(`    ${s.error}`, s.status === 'waiting' ? 'warn' : 'dim')] : []),
        ...(s.approval ? [P(`    ${s.approval.approved ? 'approved' : 'rejected'} by ${s.approval.by}${s.approval.note ? `: ${s.approval.note}` : ''}`, 'dim')] : []),
        ...(s.status === 'succeeded' && s.output != null ? [P(`    ${JSON.stringify(s.output).slice(0, 160)}`, 'dim')] : []),
      ]),
      ...traceLines,
    ];
  },
  actions(item) {
    if (!item) return [];
    if (item.raw.type === 'workflow') {
      const w = item.raw;
      const required = Object.entries(w.inputs).filter(([, v]: any) => v.required && v.default === undefined) as [string, any][];
      if (required.length > 1) return [];
      const [name, spec] = required[0] ?? [];
      return [{ label: `Start ${w.title}`, hint: `may use: ${w.permissions.join(', ') || 'nothing'}`, confirm: ['Sensitive steps wait for your approval'], ...(name ? { input: { label: `${name} (${spec.description || spec.type})`, required: true } } : {}), run: async (api, input) => `started ${(await api.call('workflows.start', { workflow: w.id, inputs: name ? { [name]: spec.type === 'number' ? Number(input) : input } : {} })).runId}` }];
    }
    const a: Action[] = [];
    const st = item.raw.status;
    if (st === 'waiting') {
      a.push({ label: 'Approve the waiting step', hint: 'the run continues', run: async (api) => { const v = await api.call('workflows.run', { id: item.id }); const s = v.steps.find((x: any) => x.status === 'waiting'); if (!s) return 'nothing is waiting'; await api.call('workflows.approve', { id: item.id, step: s.id, approve: true }); return `approved ${s.id}`; } });
      a.push({ label: 'Reject the waiting step', input: { label: 'Reason', required: true }, confirm: ['The step fails; what depends on it is skipped'], run: async (api, note) => { const v = await api.call('workflows.run', { id: item.id }); const s = v.steps.find((x: any) => x.status === 'waiting'); if (!s) return 'nothing is waiting'; await api.call('workflows.approve', { id: item.id, step: s.id, approve: false, note }); return `rejected ${s.id}`; } });
    }
    if (['queued', 'running'].includes(st)) a.push({ label: 'Resume this run', hint: 'completed steps are not repeated', run: async (api) => (await api.call('workflows.resume', { id: item.id }), 'resumed') });
    if (['queued', 'running', 'waiting'].includes(st)) a.push({ label: 'Cancel this run', confirm: ['A running step is stopped; the rest never start'], run: async (api) => `run ${(await api.call('workflows.cancel', { id: item.id })).status}` });
    return a;
  },
};
