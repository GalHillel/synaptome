import type { Api } from '@synaptome/service';
import { type ViewDef, type Tone, mark, tier, dim, mid, strong, H, P, KV, BLANK, section, findingLines } from '../kit';

export const view: ViewDef = {
  id: 'security', title: 'Security', filterHint: 'filter findings', empty: 'No critical findings, blocked items or adapters to show.',
  columns: [{ title: 'Subject', width: 30 }, { title: 'Kind', width: 12, optional: true }, { title: 'T', width: 1 }, { title: 'Finding / status', width: 0 }],
  async load(api, f) {
    const [d, adapters] = await Promise.all([api.call('security.get'), api.call('system.adapters')]);
    const q = f.toLowerCase();
    const keep = (s: string) => !q || s.toLowerCase().includes(q);
    const crit = d.criticalAudits.filter((a: any) => keep(`${a.name} ${a.findings.map((x: any) => x.message).join(' ')}`));
    return [
      section('Critical findings', crit.length),
      ...crit.map((a: any) => ({ id: `a:${a.id}`, raw: { audit: a }, cells: [strong(a.name ?? a.subject_id), mid(a.subject_type), tier(a.tier), { t: a.findings[0]?.message ?? a.summary, c: 'danger' as Tone }] })),
      section('Blocked in quarantine', d.blockedCandidates.length),
      ...d.blockedCandidates.filter((c: any) => keep(c.name)).map((c: any) => ({ id: `c:${c.id}`, raw: { cand: c }, cells: [strong(c.name), mid(c.kind), tier('C'), mark('blocked', 'not registered')] })),
      section('Host adapters'),
      ...adapters.filter((a: any) => keep(a.title)).map((a: any) => ({ id: `h:${a.id}`, raw: { adapter: a }, cells: [strong(a.title), mid(a.detected.present ? 'detected' : 'absent'), dim(''), mark(a.status)] })),
    ];
  },
  async inspect(_api, item) {
    const { audit, cand, adapter } = item.raw;
    if (audit) return [[strong(audit.name ?? audit.subject_id)], P(`${audit.subject_type} ${audit.subject_id}`, 'dim'), BLANK, P(audit.summary, 'mid'), BLANK, H('Critical findings'), ...findingLines(audit.findings)];
    if (cand) return [[strong(cand.name)], P(cand.id, 'dim'), BLANK, P('Held in quarantine. It was never registered and cannot be approved.', 'danger'), BLANK, KV('source', cand.sourceId), KV('location', cand.url), KV('licence', cand.licenseSpdx ?? 'unknown')];
    return [[strong(adapter.title)], BLANK, [mark(adapter.status)], BLANK, KV('detected', adapter.detected.detail), KV('supports', adapter.kinds.join(', ') || 'nothing yet'), BLANK, H('Evidence'), P(adapter.evidence, 'mid')];
  },
  actions: () => [],
};
