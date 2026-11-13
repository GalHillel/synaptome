import type { Api } from '@synaptome/service';

/**
 * Shared kit for the Terminal Workbench views (types, status marks, line helpers, shared actions). Everything goes through the same command surface
 * (`api.call`) that the Web Command Center uses over HTTP, so both interfaces show the same state.
 */

export type Tone = 'fg' | 'mid' | 'dim' | 'accent' | 'ok' | 'warn' | 'danger';
export interface Seg {
  t: string;
  c?: Tone;
  b?: boolean;
}
export type Cell = string | Seg;
export type Line = Seg[];

export interface Item {
  id: string;
  cells: Cell[];
  raw: any;
  /** Section rows are headings inside a list and cannot be selected. */
  section?: boolean;
}
export interface Column {
  title: string;
  /** Fixed width in cells; 0 = share the remaining space. */
  width: number;
  right?: boolean;
  /** Dropped first when the pane is narrow. */
  optional?: boolean;
}
export interface Action {
  label: string;
  hint?: string;
  /** Shown in a confirmation before running. Lists consequences. */
  confirm?: string[];
  /** Asks for a line of text first. */
  input?: { label: string; required?: boolean };
  /** Opens another view (by id) instead of running anything. */
  go?: string;
  run(api: Api, input: string): Promise<string>;
}
export interface ViewDef {
  id: string;
  title: string;
  columns: Column[];
  filterHint: string;
  empty: string;
  load(api: Api, filter: string): Promise<Item[]>;
  inspect(api: Api, item: Item): Promise<Line[]>;
  actions(item: Item | null, marked: Item[]): Action[];
  /** After an action, the id of the row to select on the next load (read once), e.g. a jump to a linked capability. */
  takeFocus?(api: Api): string | null;
}

/* ---------- glyphs: status is glyph + word, never colour alone ---------- */

export const UNICODE = process.platform !== 'win32' || !!process.env.WT_SESSION || process.env.TERM_PROGRAM === 'vscode' || !!(process.env.SYNAPTOME_UNICODE ?? process.env.DRELQAVO_UNICODE);
export const G = UNICODE ? { on: '●', half: '◐', off: '○', no: '✕', warn: '▲', ok: '✓', box: '■', sel: '▸', mark: '◆', rule: '─', vrule: '│', dot: '·' } : { on: '*', half: 'o', off: '.', no: 'x', warn: '!', ok: '+', box: '#', sel: '>', mark: '+', rule: '-', vrule: '|', dot: '.' };
export const GLYPH = G;

export const STATUS: Record<string, [string, Tone, string?]> = {
  approved: [G.on, 'ok'], registered: [G.half, 'mid'], blocked: [G.no, 'danger'], rejected: [G.off, 'dim'], deprecated: [G.off, 'dim'],
  discovered: [G.off, 'dim'], queued: [G.half, 'accent'], quarantined: [G.warn, 'warn'], audited: [G.half, 'mid'],
  installed: [G.box, 'ok'], rolled_back: [G.off, 'dim', 'rolled back'], uninstalled: [G.off, 'dim'], failed: [G.no, 'danger'], superseded: [G.off, 'dim'],
  healthy: [G.on, 'ok'], unavailable: [G.no, 'danger'], degraded: [G.warn, 'warn'], unknown: ['?', 'dim'],
  completed: [G.on, 'ok'], skipped: [G.off, 'dim'], ok: [G.on, 'ok'], warn: [G.warn, 'warn'], fail: [G.no, 'danger'], pass: [G.ok, 'ok'],
  promoted: [G.on, 'ok'], held: [G.warn, 'warn'], draft: [G.off, 'dim'], checked: [G.half, 'mid'], evaluated: [G.half, 'mid'], 'eval-blocked': [G.warn, 'warn', 'eval blocked'],
  'auto-promote': [G.on, 'ok'], 'needs-approval': [G.half, 'warn', 'needs approval'], success: [G.on, 'ok'], partial: [G.half, 'warn'],
  succeeded: [G.ok, 'ok'], running: [G.half, 'accent'], waiting: [G.warn, 'warn', 'waiting for you'], pending: [G.off, 'dim'], cancelled: [G.off, 'dim'],
  VERIFIED: [G.on, 'ok', 'verified'], PARTIALLY_VERIFIED: [G.half, 'warn', 'partly verified'], EXPERIMENTAL: [G.half, 'warn', 'experimental'], UNSUPPORTED: [G.off, 'dim', 'unsupported'],
};
export function mark(s: string | null | undefined, label?: string): Seg {
  const m = STATUS[s ?? ''] ?? [G.dot, 'dim'];
  return { t: `${m[0]} ${label ?? m[2] ?? String(s ?? '-').replace(/_/g, ' ')}`, c: m[1] };
}
export const tier = (t: string): Seg => ({ t, c: t === 'A' ? 'ok' : t === 'B' ? 'warn' : 'danger', b: true });
export const dim = (t: unknown): Seg => ({ t: String(t ?? ''), c: 'dim' });
export const mid = (t: unknown): Seg => ({ t: String(t ?? ''), c: 'mid' });
export const strong = (t: unknown): Seg => ({ t: String(t ?? ''), b: true });
export const when = (iso?: string | null) => (iso ? iso.slice(5, 16).replace('T', ' ') : '-');
export const pct = (n: number) => `${Math.round(n * 100)}%`;

/* ---------- inspector line helpers ---------- */

export const H = (t: string): Line => [{ t: t.toUpperCase(), c: 'accent', b: true }];
export const P = (t: string, c: Tone = 'fg'): Line => [{ t, c }];
export const KV = (k: string, v: unknown, c: Tone = 'fg'): Line => [{ t: `${k.padEnd(13)} `, c: 'dim' }, { t: v == null || v === '' ? '-' : String(v), c }];
export const BLANK: Line = [{ t: '' }];
export const section = (title: string, n?: number): Item => ({ id: `§${title}`, cells: [{ t: `${title}${n != null ? `  ${n}` : ''}`, c: 'accent', b: true }], raw: null, section: true });

export function findingLines(findings: any[], limit = 12): Line[] {
  if (!findings?.length) return [P('No findings.', 'mid')];
  return findings.slice(0, limit).flatMap((f) => [[mark(f.severity === 'critical' || f.severity === 'high' ? 'fail' : f.severity === 'medium' ? 'warn' : 'unknown', f.severity), { t: `  ${f.message}` }] as Line, P(`   ${f.file}${f.line ? `:${f.line}` : ''}`, 'dim')]);
}
export function gateLines(gate: any): Line[] {
  if (!gate) return [P('The promotion gate has not been evaluated.', 'mid')];
  return [[{ t: 'decision      ', c: 'dim' }, mark(gate.decision)], ...gate.checks.flatMap((c: any) => [[mark(c.result === 'unknown' ? 'warn' : c.result, c.result.padEnd(7)), { t: ` ${c.label}` }] as Line, P(`          ${c.evidence}`, 'dim')])];
}

export async function capabilityLines(api: Api, id: string): Promise<Line[]> {
  const d = await api.call('capabilities.get', { id });
  const c = d.capability;
  const r = c.record;
  return [
    [strong(c.name)], P(c.id, 'dim'), BLANK,
    [mark(c.status), { t: '   tier ' }, tier(c.tier), { t: `   trust ${c.trust.toLowerCase().replace(/_/g, ' ')}`, c: 'mid' }], BLANK,
    P(c.description), BLANK,
    ...(c.status === 'blocked' ? [P('Blocked by the security audit. Excluded from routing.', 'danger'), BLANK] : []),
    ...(c.origin === 'host-inventory' ? [P('Already on this host before Synaptome; indexed read-only.', 'mid'), BLANK] : []),
    KV('kind/domain', `${c.kind} / ${c.domain}`), KV('publisher', c.publisher), KV('source', r.provenance.url), KV('commit', r.commit ? r.commit.slice(0, 12) : ''),
    KV('provenance', `${r.provenance.verified ? 'verified' : 'NOT verified'} - ${r.provenance.method}`, r.provenance.verified ? 'ok' : 'warn'),
    KV('licence', `${r.license.spdx || 'unknown'} (${r.license.compatible})`, r.license.compatible === 'yes' ? 'ok' : 'warn'), P(`              ${r.license.evidence}`, 'dim'),
    KV('context', `~${c.contextCost} tokens (estimate)`), KV('permissions', Object.entries(r.permissions).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'),
    KV('installed', d.installations.filter((i: any) => i.status === 'installed').map((i: any) => `${i.host}/${i.scope}`).join(', ') || 'no'),
    BLANK, H(`Quality ${d.score ? d.score.total : 'not scored'}`),
    ...(d.score ? Object.entries<any>(d.score.dimensions).flatMap(([k, v]) => [[{ t: `${v.score == null ? ' ? ' : String(v.score).padStart(3)}  `, c: v.score == null ? 'warn' : 'fg', b: true }, { t: k }] as Line, P(`     ${v.evidence}`, 'dim')]) : []),
    BLANK, H('Promotion gate'), ...gateLines(d.gate),
    BLANK, H('Audit'), ...(d.audit ? [P(d.audit.summary, 'mid'), ...findingLines(d.audit.findings)] : [P('No audit recorded.', 'mid')]),
  ];
}

/* ---------- shared actions ---------- */

export const approveAction = (c: any): Action => {
  const lic = c.record?.license?.compatible ?? 'unknown';
  return {
    label: 'Approve', hint: 'makes it installable and routable; installs nothing',
    confirm: [`Approve ${c.name} (tier ${c.tier}, quality ${c.quality ?? 'n/a'})`, ...(c.gate?.checks ?? []).filter((x: any) => x.result !== 'pass').map((x: any) => `${x.result}: ${x.label}`)],
    input: lic === 'yes' ? undefined : { label: `Licence is ${lic === 'no' ? 'not on the allow list' : 'unknown'}. Why do you accept it for local use?`, required: true },
    run: async (api, input) => (await api.call('capabilities.approve', { id: c.id, acceptLicence: input || undefined }), `${c.name} approved`),
  };
};
export const rejectAction = (c: any): Action => ({ label: 'Reject', hint: 'will not be routed or installed', input: { label: 'Reason (optional)' }, confirm: [`Reject ${c.name}`], run: async (api, input) => (await api.call('capabilities.reject', { id: c.id, reason: input }), `${c.name} rejected`) });
export const installAction = (c: any): Action => ({ label: 'Install to sandbox host', hint: 'staged install; real host untouched', run: async (api) => `staged at ${(await api.call('capabilities.install', { id: c.id })).targetPath}` });
export const undoActions = (i: any): Action[] => [
  { label: `Roll back (${i.scope})`, hint: i.previousId ? 'restores the previous version' : 'removes it from the host', confirm: [`Remove ${i.targetPath}`, i.scope === 'real' ? 'This changes a REAL host directory' : 'Sandbox host only'], run: async (api) => `${(await api.call('installations.rollback', { id: i.id })).status.replace('_', ' ')}` },
  { label: `Uninstall (${i.scope})`, confirm: [`Remove ${i.targetPath}`], run: async (api) => `${(await api.call('installations.uninstall', { id: i.id })).status}` },
];
export function capabilityActions(c: any, installs: any[] = []): Action[] {
  if (!c) return [];
  const a: Action[] = [];
  if (c.status === 'registered' && c.origin !== 'host-inventory') a.push(approveAction(c), rejectAction(c));
  const managed = (c.installedHosts ?? []).filter((h: string) => !h.endsWith(':external'));
  if (c.status === 'approved' && !managed.length) a.push(installAction(c));
  for (const i of installs.filter((x) => x.capabilityId === c.id && x.status === 'installed')) a.push(...undoActions(i));
  return a;
}

export const GLOBAL_ACTIONS: Action[] = [
  { label: 'Scan for new capabilities', hint: 'broad discovery: GitHub + MCP registry', run: async (api) => (await api.call('scan.run', { mode: 'broad' })).reports.map((r: any) => `${r.sourceId}: ${r.status}, ${r.added} new`).join(' | ') },
  { label: 'Search sources for a topic', hint: 'need-driven discovery', input: { label: 'What are you looking for?', required: true }, run: async (api, q) => (await api.call('scan.run', { mode: 'need', query: q })).reports.map((r: any) => `${r.sourceId}: ${r.added} new`).join(' | ') },
  { label: 'Scan one GitHub repository', input: { label: 'owner/name', required: true }, run: async (api, repo) => (await api.call('scan.run', { repo })).reports.map((r: any) => `${r.found} found, ${r.added} new`).join(' | ') },
  { label: 'Evaluate next queued candidate', hint: 'quarantine, audit, score, gate', run: async (api) => { const r = await api.call('queue.evaluateNext', { n: 1 }); return r[0] ? r[0].summary ?? r[0].error : 'the evaluation queue is empty'; } },
  { label: 'Check for updates', hint: 'never installs anything', run: async (api) => { const r = await api.call('updates.check'); return `${r.filter((x: any) => x.changed).length} update(s) among ${r.length} checked`; } },
  { label: 'Check source health', run: async (api) => (await api.call('sources.check')).map((s: any) => `${s.id}: ${s.health}`).join(' | ') },
  { label: 'Index local host inventory', hint: 'read-only audit of installed skills', run: async (api) => { const r = await api.call('inventory.run'); return `${r.indexed} indexed, ${r.unchanged} unchanged, ${r.flagged.length} flagged`; } },
  { label: 'Route a task', input: { label: 'Describe the task', required: true }, run: async (api, task) => { const d = await api.call('routing.route', { task }); return `decision #${d.id}: ${d.selected.map((s: any) => s.name).join(', ') || 'nothing selected'}${d.gaps.length ? `; ${d.gaps.length} gap(s)` : ''}`; } },
];
