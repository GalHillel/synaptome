import type { Api } from '@synaptome/service';
import { type ViewDef, type Action, type Item, mark, mid, strong, when, H, P, KV, section } from '../kit';

/**
 * The Overview reloads on every live event, so it shows the quick diagnostics; the two slow checks (database integrity
 * scan, GitHub sign-in) run when asked (action on any diagnostics row) and their result is kept for the session.
 */
const fullRuns = new WeakMap<object, { at: string; checks: any[] }>();
const SLOW = new Set(['db-integrity', 'github-auth']);
const runFull: Action = {
  label: 'Run full diagnostics', hint: 'adds the database integrity scan and the GitHub sign-in check',
  run: async (api) => {
    const checks = await api.call('system.diagnostics', { full: true });
    fullRuns.set(api.sys, { at: new Date().toISOString(), checks });
    const bad = checks.filter((c: any) => c.status !== 'ok');
    return bad.length ? `${bad.length} check(s) need attention: ${bad.map((c: any) => c.label).join(', ')}` : `all ${checks.length} checks passed`;
  },
};

export const view: ViewDef = {
  id: 'overview', title: 'Overview', filterHint: 'filter rows', empty: 'No data yet.',
  columns: [{ title: 'Item', width: 28 }, { title: 'Value', width: 14 }, { title: 'Detail', width: 0 }],
  async load(api, f) {
    const [o, quick] = await Promise.all([api.call('system.overview'), api.call('system.diagnostics', { full: false })]);
    const full = fullRuns.get(api.sys);
    const slow = full ? full.checks.filter((c: any) => SLOW.has(c.id)).map((c: any) => ({ ...c, detail: `${c.detail} (checked ${when(full.at)})` })) : [{ id: 'full', label: 'Integrity and GitHub sign-in', status: 'unknown', detail: 'not checked in this session; a on this row runs them' }];
    const diag = [...quick, ...slow];
    const sum = (x: Record<string, number>) => Object.entries(x).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
    const rows: Item[] = [
      section('System'),
      { id: 'capabilities', cells: ['Capabilities', strong(o.capabilities.total), mid(sum(o.capabilities.byStatus))], raw: { lines: [H('Capabilities'), KV('by status', sum(o.capabilities.byStatus)), KV('by kind', sum(o.capabilities.byKind)), KV('by origin', sum(o.capabilities.byOrigin))] } },
      { id: 'pending', cells: ['Pending approval', { t: String(o.pendingApproval), c: o.pendingApproval ? 'accent' : 'fg', b: true }, mid('registered, awaiting a decision')], raw: { lines: [P('Open the Queue view (press 4) to approve or reject.')] } },
      { id: 'installs', cells: ['Managed installs', strong(o.installations.active), mid(`${o.installations.real} real, ${o.installations.external} pre-existing, ${o.installations.rolledBack} rolled back`)], raw: { lines: [KV('active', o.installations.active), KV('real host', o.installations.real), KV('pre-existing', o.installations.external), KV('rolled back', o.installations.rolledBack), KV('failed', o.installations.failed)] } },
      { id: 'candidates', cells: ['Candidates', strong(o.candidates.total), mid(sum(o.candidates.byState))], raw: { lines: [KV('by state', sum(o.candidates.byState)), KV('updates', o.candidates.updates)] } },
      { id: 'blocked', cells: ['Blocked', { t: String(o.security.blocked), c: o.security.blocked ? 'warn' : 'fg', b: true }, mid(`${o.security.criticalAudits} audits with critical findings`)], raw: { lines: [P('Open the Security view (press 5) for the findings.')] } },
      { id: 'routing', cells: ['Routing decisions', strong(o.routing.decisions), mid(`${o.routing.activations} activations, ${o.routing.openGaps} open gaps`)], raw: { lines: [KV('decisions', o.routing.decisions), KV('activations', o.routing.activations), KV('open gaps', o.routing.openGaps)] } },
      { id: 'forge', cells: ['Forge candidates', strong(o.forge.candidates), mid(`${o.forge.evalRuns} evaluation runs`)], raw: { lines: [KV('candidates', o.forge.candidates), KV('eval runs', o.forge.evalRuns)] } },
      section('Discovery sources'),
      ...o.sources.map((s: any) => ({ id: `src-${s.id}`, cells: [s.title, mark(s.health), mid(s.health_detail ?? '')], raw: { lines: [H(s.title), KV('health', s.health), KV('detail', s.health_detail), KV('last scan', s.last_scan_at)] } })),
      section('Diagnostics'),
      ...diag.map((d: any) => ({ id: `diag-${d.id}`, cells: [d.label, mark(d.status, d.status === 'ok' ? 'ok' : d.status === 'warn' ? 'notice' : d.status === 'unknown' ? 'not run' : 'FAILED'), mid(d.detail)], raw: { diag: true, lines: [H(d.label), KV('result', d.status === 'unknown' ? 'not run' : d.status), P(d.detail)] } })),
    ];
    const q = f.toLowerCase();
    return q ? rows.filter((r) => r.section || r.cells.some((c) => (typeof c === 'string' ? c : c.t).toLowerCase().includes(q))) : rows;
  },
  inspect: async (_api, item) => item.raw?.lines ?? [],
  actions: (item) => (item?.raw?.diag ? [runFull] : []),
};
