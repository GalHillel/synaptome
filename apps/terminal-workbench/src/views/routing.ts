import type { Api } from '@synaptome/service';
import { type ViewDef, type Tone, mark, dim, mid, strong, H, P, KV, BLANK, section, GLOBAL_ACTIONS } from '../kit';

export const view: ViewDef = {
  id: 'routing', title: 'Routing', filterHint: 'filter decisions by task text', empty: 'No task has been routed. Press a, then "Route a task".',
  columns: [{ title: '#', width: 4, right: true }, { title: 'Via', width: 5, optional: true }, { title: 'Size', width: 7, optional: true }, { title: 'Sel', width: 3, right: true }, { title: 'Gap', width: 3, right: true }, { title: 'Task', width: 0 }],
  async load(api, f) {
    const [d, gaps] = await Promise.all([api.call('routing.decisions', { limit: 60 }), api.call('routing.gaps')]);
    const q = f.toLowerCase();
    return [
      section('Decisions', d.length),
      ...d.filter((x: any) => !q || x.task.toLowerCase().includes(q)).map((x: any) => ({ id: `d:${x.id}`, raw: { decision: x }, cells: [mid(x.id), mid(x.origin), mid(x.analysis.complexity), strong(x.selected.length), x.gaps.length ? { t: String(x.gaps.length), c: 'warn' as Tone } : dim('0'), x.task] })),
      section('Capability gaps', gaps.length),
      ...gaps.map((g: any) => ({ id: `g:${g.id}`, raw: { gap: g }, cells: [mid(g.hits), mid(g.domain ?? ''), mid(g.status), dim(''), dim(''), strong(g.term)] })),
    ];
  },
  async inspect(api, item) {
    if (item.raw.gap) return [H(`Gap: ${item.raw.gap.term}`), KV('domain', item.raw.gap.domain), KV('hits', item.raw.gap.hits), KV('status', item.raw.gap.status), KV('last seen', item.raw.gap.last_seen_at), BLANK, P(item.raw.gap.sample_task ?? '', 'mid'), BLANK, P('Open a forge draft with: synaptome forge new "<gap>"', 'dim')];
    const d = await api.call('routing.decision', { id: item.raw.decision.id });
    return [P(d.task), BLANK, ...String(d.explanation).split('\n').map((l) => (/^[A-Z][a-z]+:/.test(l) ? H(l.replace(/:.*/, '')) : P(l, l.startsWith('  ') ? 'mid' : 'fg'))), BLANK, H('Activations'), ...(d.activations.length ? d.activations.map((a: any) => [{ t: `${a.name ?? a.capability_id}  `, b: true }, { t: `${a.host}  `, c: 'mid' as Tone }, a.outcome ? mark(a.outcome) : dim('outcome not reported')]) : [P('None recorded.', 'mid')])];
  },
  actions: () => [GLOBAL_ACTIONS[7], { label: 'Route a task and search sources for gaps', input: { label: 'Describe the task', required: true }, run: async (api, task) => { const d = await api.call('routing.route', { task, discover: true }); return `decision #${d.id}: ${d.selected.length} selected; ${d.discovery.map((r: any) => `${r.sourceId} +${r.added}`).join(', ') || 'no gap to search for'}`; } }],
};
