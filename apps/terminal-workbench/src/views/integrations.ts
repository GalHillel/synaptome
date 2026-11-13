import { type ViewDef, type Line, mark, dim, mid, strong, when, H, P, KV, BLANK, section } from '../kit';

const providerMark = (p: any) => mark(p.status === 'VERIFIED' ? 'VERIFIED' : p.status === 'FAILED' ? 'fail' : 'UNSUPPORTED', p.status.toLowerCase());

/**
 * Integrations: model providers (where task text can go) and host adapters (where capabilities are installed).
 * A provider is VERIFIED only by a recorded live call; credentials are read from the environment and never stored.
 */
export const view: ViewDef = {
  id: 'integrations', title: 'Integrations', filterHint: 'filter providers and hosts', empty: 'No providers or host adapters.',
  columns: [{ title: 'Provider / host', width: 0 }, { title: 'Status', width: 18 }, { title: 'Where', width: 22, optional: true }, { title: 'Detail', width: 30, optional: true }],
  async load(api, f) {
    const [providers, adapters] = await Promise.all([api.call('providers.list'), api.call('system.adapters')]);
    const q = f.toLowerCase();
    const keep = (s: string) => !q || s.toLowerCase().includes(q);
    const p = providers.filter((x: any) => keep(`${x.id} ${x.title}`));
    const a = adapters.filter((x: any) => keep(`${x.id} ${x.title}`));
    return [
      section('Model providers', p.length),
      ...p.map((x: any) => ({ id: `provider:${x.id}`, raw: { type: 'provider', ...x }, cells: [strong(x.title), providerMark(x), mid(x.location === 'local' ? 'stays on this machine' : 'leaves this machine'), dim(x.lastCheck ? `${when(x.lastCheck.at)} ${x.lastCheck.detail}` : 'never checked')] })),
      section('Host adapters', a.length),
      ...a.map((x: any) => ({ id: `host:${x.id}`, raw: { type: 'host', ...x }, cells: [strong(x.title), mark(x.status), mid(x.kinds.join(', ') || '-'), dim(x.detected?.present ? 'found on this machine' : 'not found')] })),
    ];
  },
  async inspect(_api, item) {
    const x = item.raw;
    if (x.type === 'provider')
      return [
        [strong(x.title)], P(x.id, 'dim'), BLANK, [{ t: 'status        ', c: 'dim' }, providerMark(x)],
        KV('task text', x.location === 'local' ? 'stays on this machine' : 'leaves this machine', x.location === 'local' ? 'ok' : 'warn'),
        KV('privacy', x.allowedByPrivacy ? 'allowed by the privacy setting' : 'blocked by the privacy setting (local only)', x.allowedByPrivacy ? 'fg' : 'warn'),
        KV('enabled', x.enabled ? 'yes' : 'no'), KV('model', x.model ?? 'not set'), KV('billing', x.billing), KV('price', x.price ? JSON.stringify(x.price) : 'not configured'),
        BLANK, H('Last check'), ...(x.lastCheck ? [[mark(x.lastCheck.ok ? 'ok' : 'fail'), { t: `  ${when(x.lastCheck.at)}${x.lastCheck.model ? `  ${x.lastCheck.model}` : ''}`, c: 'mid' }] as Line, P(x.lastCheck.detail, 'dim')] : [P('Never checked. "Check this provider" makes one short live call and records the result.', 'mid')]),
      ];
    return [
      [strong(x.title)], P(x.id, 'dim'), BLANK, [{ t: 'status        ', c: 'dim' }, mark(x.status)], KV('installs', x.kinds.join(', ') || 'nothing'),
      KV('on this host', x.detected?.present ? 'found' : 'not found', x.detected?.present ? 'ok' : 'mid'), ...(x.detected?.detail ? [P(`              ${x.detected.detail}`, 'dim')] : []),
      BLANK, H('Evidence'), P(x.evidence, 'mid'),
    ];
  },
  actions(item) {
    if (!item || item.raw.type !== 'provider') return [];
    const p = item.raw;
    return [{
      label: 'Check this provider', hint: 'one live call',
      confirm: [p.location === 'remote' ? 'Sends one short test prompt off this machine' : 'Calls the local server once', 'The result becomes the provider status'],
      run: async (api) => { const r = await api.call('providers.test', { id: p.id }); return `${p.id}: ${r.ok ? 'verified' : 'not verified'} - ${r.detail}`; },
    }];
  },
};
