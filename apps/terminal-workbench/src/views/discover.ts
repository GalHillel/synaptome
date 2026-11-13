import type { Api } from '@synaptome/service';
import { type ViewDef, type Action, mark, tier, dim, mid, strong, H, P, KV, BLANK, findingLines, GLOBAL_ACTIONS } from '../kit';

export const view: ViewDef = {
  id: 'discover', title: 'Discover', filterHint: 'filter candidates by name, description or repository', empty: 'No candidates. Press a and choose a scan.',
  columns: [{ title: 'Rank', width: 4, right: true }, { title: 'Candidate', width: 0 }, { title: 'Kind', width: 10, optional: true }, { title: 'State', width: 14 }, { title: 'Source', width: 12, optional: true }, { title: 'Licence', width: 11, optional: true }],
  async load(api, f) {
    const r = await api.call('candidates.list', { q: f, limit: 150 });
    return r.items.map((c: any) => ({ id: c.id, raw: c, cells: [mid(c.rank.toFixed(0)), strong(c.name), mid(c.kind), mark(c.state), mid(c.sourceId), c.licenseSpdx ? mid(c.licenseSpdx) : dim('unknown')] }));
  },
  async inspect(api, item) {
    const c = await api.call('candidates.get', { id: item.id });
    return [
      [strong(c.name)], P(c.id, 'dim'), BLANK, [mark(c.state), { t: `   ${c.kind} via ${c.sourceId}   rank ${c.rank.toFixed(0)}`, c: 'mid' }], BLANK,
      P(c.description || 'No description supplied by the source.', c.description ? 'fg' : 'dim'), BLANK,
      ...(c.state === 'blocked' ? [P('Blocked in quarantine. Not registered.', 'danger'), BLANK] : []),
      ...(c.duplicateOf ? [P(`Duplicate of ${c.duplicateOf}. Nothing was merged.`, 'warn'), BLANK] : []),
      KV('location', c.url), KV('pinned ref', c.ref ? c.ref.slice(0, 12) : ''), KV('publisher', c.publisher), KV('licence', c.licenseSpdx ?? 'unknown'), P(`              ${c.licenseEvidence ?? ''}`, 'dim'),
      KV('popularity', c.stars != null ? `${c.stars} (weak evidence)` : ''), KV('next step', c.recommendedAction), KV('update', c.updateAvailable ? 'upstream changed since audit' : 'none detected', c.updateAvailable ? 'warn' : 'fg'),
      BLANK, H('Why this rank'), P('Rank orders the queue. It is not a quality score.', 'dim'), ...c.rankReasons.map((x: string) => P(x, 'mid')),
      ...(c.overlap.length ? [BLANK, H('Possible overlap'), ...c.overlap.map((o: any) => P(`${o.name} (${o.similarity}) ${o.basis}`, 'mid'))] : []),
      ...(c.audit ? [BLANK, H('Audit'), P(c.audit.summary, 'mid'), ...findingLines(c.audit.findings)] : []),
    ];
  },
  actions(item, marked) {
    const targets = (marked.length ? marked : item ? [item] : []).filter((i) => ['queued', 'discovered', 'audited'].includes(i.raw.state));
    const a: Action[] = [];
    if (targets.length) a.push({ label: targets.length > 1 ? `Evaluate ${targets.length} marked candidates` : 'Evaluate this candidate', hint: 'quarantine, audit, score, test, gate', run: async (api) => { const out: string[] = []; for (const t of targets) { const r = await api.call('candidates.evaluate', { id: t.id }); out.push(`${t.raw.name}: ${r.state}, tier ${r.tier}${r.gate ? `, ${r.gate.decision}` : ''}`); } return out.join(' | '); } });
    if (item?.raw.updateAvailable) a.push({ label: 'Inspect upstream update', hint: 'stages and audits the new version; applies nothing', run: async (api) => { const r = await api.call('updates.inspect', { id: item.id }); return `${r.verdict}${r.reasons.length ? ': ' + r.reasons.join('; ') : ''}`; } });
    return [...a, ...GLOBAL_ACTIONS.slice(0, 3), GLOBAL_ACTIONS[5]];
  },
};
