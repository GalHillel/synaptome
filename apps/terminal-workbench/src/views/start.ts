import { type ViewDef, type Action, mark, mid, strong, H, P, BLANK } from '../kit';

interface Step { id: string; done: boolean; title: string; detail: string; action?: Action }

/** Get started: a checklist computed from the system's current state, with the next action for each step (same steps as the web screen). */
export async function startSteps(api: Parameters<ViewDef['load']>[0]): Promise<Step[]> {
  const [ov, diag, providers] = await Promise.all([api.call('system.overview'), api.call('system.diagnostics', { full: false }), api.call('providers.list')]);
  const failing = diag.filter((d: any) => d.status === 'fail');
  const verified = providers.filter((p: any) => p.status === 'VERIFIED');
  const by = ov.capabilities.byStatus ?? {};
  return [
    { id: 'checks', done: !failing.length, title: 'The system checks pass', detail: failing.length ? `${failing.length} check(s) failing: ${failing.map((f: any) => f.label).join(', ')}` : 'database, home folder and hosts look right', action: { label: 'See the checks', hint: 'Overview', go: 'overview', run: async () => 'opened Overview' } },
    { id: 'inventory', done: !!ov.inventory, title: 'Your existing skills are indexed', detail: ov.inventory ? `${ov.inventory.indexed} skill(s) already on this machine indexed and audited (read only), ${ov.inventory.flagged} flagged` : 'Synaptome has not looked at the skills already installed on this machine', action: { label: 'Index them now', hint: 'read-only audit of installed skills', run: async (a) => { const r = await a.call('inventory.run'); return `${r.indexed} indexed, ${r.flagged.length} flagged`; } } },
    { id: 'discovery', done: ov.candidates.total > 0, title: 'Discovery has run at least once', detail: ov.candidates.total ? `${ov.candidates.total} candidate(s) found across sources` : 'no scan yet', action: { label: 'Open Sources', go: 'sources', run: async () => 'opened Sources' } },
    { id: 'provider', done: verified.length > 0, title: 'A model provider is verified', detail: verified.length ? `verified: ${verified.map((p: any) => p.title).join(', ')}` : 'needed for the forge, evaluations and agent teams; check one in Integrations', action: { label: 'Open Integrations', go: 'integrations', run: async () => 'opened Integrations' } },
    { id: 'routing', done: ov.routing.decisions > 0, title: 'Routing has seen real tasks', detail: ov.routing.decisions ? `${ov.routing.decisions} routing decision(s) recorded` : 'connect a project so its prompts are routed: synaptome bridge init <project folder>', action: { label: 'Open Routing', go: 'routing', run: async () => 'opened Routing' } },
  ];
}

export const view: ViewDef = {
  id: 'start', title: 'Get started', filterHint: 'filter steps', empty: 'No steps.',
  columns: [{ title: 'Step', width: 0 }, { title: 'State', width: 10 }, { title: 'Detail', width: 44, optional: true }],
  async load(api, f) {
    const q = f.toLowerCase();
    return (await startSteps(api))
      .filter((s) => !q || `${s.title} ${s.detail}`.toLowerCase().includes(q))
      .map((s, i) => ({ id: s.id, raw: s, cells: [strong(`${i + 1}. ${s.title}`), mark(s.done ? 'succeeded' : 'pending', s.done ? 'done' : 'to do'), mid(s.detail)] }));
  },
  async inspect(_api, item) {
    const s: Step = item.raw;
    return [[strong(s.title)], BLANK, [mark(s.done ? 'succeeded' : 'pending', s.done ? 'done' : 'to do')], BLANK, P(s.detail, 'mid'), ...(!s.done && s.action ? [BLANK, H('Next'), P(`${s.action.label}  (press a)`)] : [])];
  },
  actions(item) {
    const s: Step | undefined = item?.raw;
    return s?.action ? [s.action] : [];
  },
};
