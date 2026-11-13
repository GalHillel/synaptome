import type { Api } from '@synaptome/service';
import { type ViewDef, type Tone, mark, tier, dim, mid, strong, capabilityLines, capabilityActions } from '../kit';

export const view: ViewDef = {
  id: 'skills', title: 'Skills', filterHint: 'full-text search across names, descriptions, tags and content', empty: 'The registry is empty. Run a scan from Discover.',
  columns: [{ title: 'Capability', width: 0 }, { title: 'Kind', width: 8, optional: true }, { title: 'Domain', width: 12, optional: true }, { title: 'Status', width: 13 }, { title: 'T', width: 1 }, { title: 'Q', width: 3, right: true }, { title: 'Installed', width: 9, optional: true }],
  async load(api, f) {
    const r = await api.call('capabilities.list', { q: f, limit: 200 });
    return r.items.map((c: any) => ({ id: c.id, raw: c, cells: [strong(c.name), mid(c.kind), mid(c.domain), mark(c.status), tier(c.tier), c.quality == null ? dim('-') : mid(c.quality.toFixed(0)), c.installedHosts.length ? { t: c.installedHosts.map((h: string) => h.split(':')[1]).join(','), c: 'ok' as Tone } : dim('no')] }));
  },
  inspect: (api, item) => capabilityLines(api, item.id),
  actions: (item) => (item ? [...capabilityActions(item.raw, item.raw._installs), { label: 'Show entry file', hint: 'content is shown as data', run: async (api) => { const d = await api.call('capabilities.get', { id: item.id, content: true }); return d.entry ? `\n${d.entry.content}` : 'no readable entry file'; } }] : []),
};
