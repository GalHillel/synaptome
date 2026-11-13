import type { Api } from '@synaptome/service';
import { type ViewDef, mark, tier, dim, mid, strong, when, P, KV, BLANK, section, capabilityLines, undoActions, capabilityActions } from '../kit';

export const view: ViewDef = {
  id: 'queue', title: 'Queue', filterHint: 'filter queue rows', empty: 'Nothing is waiting and nothing is installed.',
  columns: [{ title: 'Capability', width: 0 }, { title: 'T', width: 1 }, { title: 'Q', width: 3, right: true }, { title: 'State', width: 16 }, { title: 'Detail', width: 30, optional: true }],
  async load(api, f) {
    const d = await api.call('queue.get');
    const q = f.toLowerCase();
    const keep = (name: string) => !q || name.toLowerCase().includes(q);
    const pending = [...d.pendingApproval, ...d.forgePending].filter((c: any) => keep(c.name));
    const ready = d.approvedNotInstalled.filter((c: any) => keep(c.name));
    const inst = d.installations.filter((i: any) => keep(i.name ?? i.capabilityId));
    return [
      section(`Pending approval   real-install budget ${d.realBudget.used}/${d.realBudget.limit}`, pending.length),
      ...pending.map((c: any) => ({ id: `p:${c.id}`, raw: { kind: 'cap', cap: c }, cells: [strong(c.name), tier(c.tier), c.quality == null ? dim('-') : mid(c.quality.toFixed(0)), c.gate ? mark(c.gate.decision) : dim('not evaluated'), mid((c.gate?.checks ?? []).filter((x: any) => x.result !== 'pass').map((x: any) => x.id).join(', '))] })),
      section('Approved, not installed', ready.length),
      ...ready.map((c: any) => ({ id: `r:${c.id}`, raw: { kind: 'cap', cap: c }, cells: [strong(c.name), tier(c.tier), c.quality == null ? dim('-') : mid(c.quality.toFixed(0)), mark('approved'), mid(c.description)] })),
      section('Installations', inst.length),
      ...inst.map((i: any) => ({ id: `i:${i.id}`, raw: { kind: 'inst', inst: i }, cells: [strong(i.name ?? i.capabilityId), dim(''), dim(''), mark(i.status), mid(`${i.host}/${i.scope}  ${when(i.createdAt)}`)] })),
    ];
  },
  async inspect(api, item) {
    if (item.raw.kind === 'inst') {
      const i = item.raw.inst;
      return [[strong(i.name ?? i.capabilityId)], P(i.id, 'dim'), BLANK, [mark(i.status)], BLANK, KV('host', i.host), KV('scope', i.scope, i.scope === 'real' ? 'warn' : 'fg'), KV('target', i.targetPath), KV('verified', i.verifyDetail), KV('installed', i.createdAt), KV('previous', i.previousId ?? 'none'), BLANK, ...(await capabilityLines(api, i.capabilityId)).slice(3)];
    }
    return capabilityLines(api, item.raw.cap.id);
  },
  actions(item) {
    if (!item) return [];
    if (item.raw.kind === 'inst') return item.raw.inst.status === 'installed' ? undoActions(item.raw.inst) : [];
    return capabilityActions(item.raw.cap);
  },
};
