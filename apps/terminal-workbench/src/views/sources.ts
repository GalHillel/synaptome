import { type ViewDef, type Line, mark, dim, mid, strong, when, H, P, KV, BLANK } from '../kit';

/** Sources: where capabilities are discovered, with health, access terms, budgets and recent checks. */
export const view: ViewDef = {
  id: 'sources', title: 'Sources', filterHint: 'filter by source name', empty: 'No discovery sources are registered.',
  columns: [{ title: 'Source', width: 0 }, { title: 'Health', width: 13 }, { title: 'May scan now', width: 26, optional: true }, { title: 'Found', width: 6, right: true }, { title: 'Last scan', width: 12, optional: true }],
  async load(api, f) {
    const q = f.toLowerCase();
    return (await api.call('sources.list'))
      .filter((s: any) => !q || `${s.id} ${s.title}`.toLowerCase().includes(q))
      .map((s: any) => ({
        id: s.id, raw: s,
        cells: [strong(`${s.title}${s.official ? ' (official)' : ''}`), mark(s.health), !s.enabled ? dim('switched off') : s.gate.ok ? { t: 'yes', c: 'ok' as const } : mid(s.gate.reason), String(s.candidates ?? 0), dim(s.lastScanAt ? when(s.lastScanAt) : 'never')],
      }));
  },
  async inspect(api, item) {
    const s = item.raw;
    const b = s.gate.budget ?? {};
    const checks = await api.call('sources.checks', { id: s.id, limit: 12 });
    const checkLines: Line[] = checks.length
      ? checks.flatMap((c: any) => [[mark(c.ok ? 'ok' : 'fail'), { t: `  ${when(c.at)}${c.latencyMs != null ? `  ${c.latencyMs} ms` : ''}${c.requests ? `  ${c.requests} req` : ''}`, c: 'mid' }] as Line, P(`   ${c.detail}`, 'dim')])
      : [P('No checks recorded. Run "Check every source now" from the actions.', 'mid')];
    return [
      [strong(s.title)], P(s.id, 'dim'), BLANK, P(s.description ?? '', 'mid'), BLANK,
      [{ t: 'health        ', c: 'dim' }, mark(s.health), { t: s.healthDetail ? `  ${s.healthDetail}` : '', c: 'mid' }],
      KV('enabled', s.enabled ? 'yes' : 'no', s.enabled ? 'ok' : 'mid'),
      KV('may scan now', !s.enabled ? 'no, switched off' : s.gate.ok ? 'yes' : `no, ${s.gate.reason}`, s.gate.ok && s.enabled ? 'ok' : 'warn'),
      KV('terms', s.gate.terms ? `${s.gate.terms.allowed ? 'allowed' : 'not allowed'}: ${s.gate.terms.basis}` : 'not recorded'),
      KV('backoff', s.gate.backoffUntil ? `${s.gate.failures} failure(s); until ${when(s.gate.backoffUntil)}` : 'none'),
      KV('today', `${s.gate.today.scans} scan(s), ${s.gate.today.requests} request(s)`),
      KV('budget', `${b.scansPerDay ?? 'no limit'} scans/day, ${b.requestsPerDay ?? 'no limit'} requests/day, ${b.maxPerScan ?? 'default'} per scan`),
      KV('found', s.candidates ?? 0), KV('last success', s.lastOkAt ? when(s.lastOkAt) : 'never'),
      BLANK, H('Recent checks'), ...checkLines,
    ];
  },
  actions(item) {
    if (!item) return [];
    const s = item.raw;
    const b = s.gate.budget ?? {};
    return [
      { label: s.enabled ? 'Switch off' : 'Switch on', confirm: [s.enabled ? `${s.title} will not be scanned until switched on again` : `${s.title} will be scanned on the next run, within its budget`], run: async (api) => (await api.call('sources.setEnabled', { id: s.id, enabled: !s.enabled }), `${s.title} ${s.enabled ? 'switched off' : 'switched on'}`) },
      { label: 'Set daily scan budget', input: { label: `Scans per day for ${s.title} (empty for no limit; now ${b.scansPerDay ?? 'no limit'})` }, run: async (api, v) => {
        if (v !== '' && !(Number.isInteger(Number(v)) && Number(v) >= 0)) throw new Error('Enter a whole number, or leave it empty for no limit');
        await api.call('sources.setBudget', { id: s.id, scansPerDay: v === '' ? null : Number(v), requestsPerDay: b.requestsPerDay ?? null, maxPerScan: b.maxPerScan ?? null });
        return `budget saved: ${v === '' ? 'no limit' : `${v} scans/day`}`;
      } },
      { label: 'Check every source now', hint: 'one light request per source', run: async (api) => (await api.call('sources.check')).map((x: any) => `${x.id}: ${x.health}`).join(' | ') },
    ];
  },
};
