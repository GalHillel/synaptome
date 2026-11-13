import type { Api } from '@synaptome/service';
import { type ViewDef, type Item, mark, dim, mid, strong, H, P, KV, BLANK, section } from '../kit';

export const view: ViewDef = {
  id: 'settings', title: 'Settings', filterHint: 'filter settings', empty: 'No settings.',
  columns: [{ title: 'Setting', width: 30 }, { title: 'Value', width: 22 }, { title: 'Meaning', width: 0, optional: true }],
  async load(api, f) {
    const [s, sources, sched] = await Promise.all([api.call('system.settings'), api.call('sources.list'), api.call('system.schedule')]);
    const rows: Item[] = [
      section('Appearance'),
      { id: 'ui.theme', raw: { key: 'ui.theme', cycle: ['auto', 'dark', 'light'], value: s.ui.theme }, cells: ['Theme', strong(s.ui.theme), mid('auto follows the terminal; press t to cycle')] },
      section('Installation policy'),
      { id: 'policy.autoInstall', raw: { key: 'policy.autoInstall', cycle: ['sandbox', 'off'], value: s.policy.autoInstall }, cells: ['Automatic promotion', strong(s.policy.autoInstall), mid('sandbox = approve and stage Tier A that passes every gate check')] },
      { id: 'policy.autoInstallThreshold', raw: { key: 'policy.autoInstallThreshold', number: true, value: s.policy.autoInstallThreshold }, cells: ['Minimum quality score', strong(s.policy.autoInstallThreshold), mid('one gate condition of eleven; unknown evidence never passes')] },
      { id: 'hosts.realInstallBudget', raw: { readonly: 'Change it deliberately from the CLI: synaptome config set hosts.realInstallBudget <n>' }, cells: ['Real-install budget', strong(s.hosts.realInstallBudget), mid('capabilities allowed in real host directories')] },
      { id: 'licences', raw: { readonly: s.policy.allowedLicenses.join(', ') }, cells: ['Allowed licences', strong(`${s.policy.allowedLicenses.length} SPDX ids`), mid(s.policy.allowedLicenses.join(' '))] },
      section('Discovery sources'),
      ...sources.map((x: any) => ({ id: `source:${x.id}`, raw: { source: x, disabled: s.discovery.disabledSources }, cells: [x.title, x.enabled ? mark('ok', 'enabled') : mark('skipped', 'disabled'), mid(x.healthDetail ?? x.description)] })),
      section('Scheduled scans (not registered; shown for review)'),
      ...sched.plan.map((t: any) => ({ id: `sched:${t.name}`, raw: { readonly: t.windows.create }, cells: [t.name, mid(t.schedule), dim(t.windows.create)] })),
    ];
    const q = f.toLowerCase();
    return q ? rows.filter((r) => r.section || r.cells.some((c) => (typeof c === 'string' ? c : c.t).toLowerCase().includes(q))) : rows;
  },
  async inspect(_api, item) {
    const r = item.raw;
    if (r.readonly) return [H(String(typeof item.cells[0] === 'string' ? item.cells[0] : item.cells[0].t)), P(r.readonly, 'mid')];
    if (r.source) return [H(r.source.title), P(r.source.description, 'mid'), BLANK, KV('enabled', r.source.enabled ? 'yes' : 'no'), KV('health', r.source.health), KV('detail', r.source.healthDetail), KV('candidates', r.source.candidates), BLANK, P('Press Enter or a to enable or disable it.', 'dim')];
    return [H(r.key), KV('value', r.value), BLANK, P(r.cycle ? `Press Enter or a to switch between: ${r.cycle.join(', ')}` : 'Press Enter or a to type a new value.', 'dim')];
  },
  actions(item) {
    if (!item || item.raw.readonly) return [];
    const r = item.raw;
    if (r.source) return [{ label: r.source.enabled ? `Disable ${r.source.title}` : `Enable ${r.source.title}`, run: async (api) => (await api.call('settings.set', { key: 'discovery.disabledSources', value: r.source.enabled ? [...r.disabled, r.source.id] : r.disabled.filter((d: string) => d !== r.source.id) }), `${r.source.title} ${r.source.enabled ? 'disabled' : 'enabled'}`) }];
    if (r.cycle) return r.cycle.filter((v: string) => v !== r.value).map((v: string) => ({ label: `Set to ${v}`, run: async (api: Api) => (await api.call('settings.set', { key: r.key, value: v }), `${r.key} = ${v}`) }));
    return [{ label: 'Change value', input: { label: `New value for ${r.key} (50-100)`, required: true }, run: async (api, input) => { const n = Number(input); if (!(n >= 50 && n <= 100)) throw new Error('Enter a number between 50 and 100'); await api.call('settings.set', { key: r.key, value: n }); return `${r.key} = ${n}`; } }];
  },
};
