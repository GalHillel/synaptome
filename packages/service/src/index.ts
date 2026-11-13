import { spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  AcquisitionError, type Deps, applyUpdate, approve, capabilityDossier, evaluateCandidate, evaluateQueue, ingestInventory, inspectUpdate, install, latestGate, listInstallations,
  readCapabilityEntry, reject, rollback, uninstall,
} from '@synaptome/acquisition';
import { UNSUPPORTED_HOSTS, buildAdapterRegistry } from '@synaptome/adapters';
import { buildConnectorRegistry } from '@synaptome/connectors';
import { MIGRATIONS, type ModelProvider, PRODUCT, type Sys, env, eventsSince, listNotifications, markNotificationsRead, facets, getCandidate, getSettings, listCandidates, listCapabilities, overview, pj, recentEvents, setOrigin, setSetting, watchEvents } from '@synaptome/core';
import { type ScanReport, checkSourceHealth, checkUpdates, evaluationQueue, listSources, scan, scanHistory, schedulePlan, setSourceBudget, setSourceEnabled, sourceChecks, sourceGate, syncSources } from '@synaptome/discovery';
import { claudeCliProvider, evalSetSummary, listEvalCases, listEvals } from '@synaptome/evaluation';
import { ForgeError, forgeAuthor, forgeCheck, forgeDecide, forgeNew, getForge, listForge } from '@synaptome/forge';
import { SPECIALISTS, agentRunner, trace } from '@synaptome/agents';
import { buildProviders, checkProvider, providerStatus } from '@synaptome/providers';
import { WorkflowError, approveStep, cancelRun, defaultRunners, findWorkflow, getRun, listRuns, runHistory, runWorkflow, startRun, loadWorkflows } from '@synaptome/workflow';
import { ActivationError, explain, getDecision, listActivations, listDecisions, listGaps, routeTask } from '@synaptome/router';

/* =====================================================================
 * Diagnostics (shared by `synaptome doctor`, the TUI and the Web UI)
 * ===================================================================== */

export interface Diagnostic {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}
const onPath = (bin: string) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
};

/**
 * `full: false` skips the two slow checks (a whole-database integrity scan, about 0.4 s at 34 MB, and asking `gh` for a
 * token, a process start) so a screen that refreshes often can show the rest without blocking. `doctor` runs them all.
 */
export function runDiagnostics(sys: Sys, opts: { full?: boolean } = {}): Diagnostic[] {
  const full = opts.full !== false;
  const d: Diagnostic[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  d.push({ id: 'node', label: 'Node.js runtime', status: major >= 24 ? 'ok' : 'fail', detail: `v${process.versions.node} (requires >= 24)` });
  try {
    sys.db.get("SELECT 1 FROM capabilities_fts WHERE capabilities_fts MATCH 'x' LIMIT 1");
    d.push({ id: 'sqlite-fts5', label: 'SQLite full-text search', status: 'ok', detail: `sqlite ${sys.db.get<{ v: string }>('SELECT sqlite_version() v')!.v}, FTS5 available` });
  } catch (e: any) {
    d.push({ id: 'sqlite-fts5', label: 'SQLite full-text search', status: 'fail', detail: e.message });
  }
  const cur = sys.db.get<{ v: number }>('SELECT MAX(version) v FROM schema_migrations')?.v ?? 0;
  const want = Math.max(...MIGRATIONS.map((m) => m.version));
  d.push({ id: 'schema', label: 'Database schema', status: cur === want ? 'ok' : 'fail', detail: `version ${cur} of ${want} at ${sys.paths.db}` });
  try {
    const probe = path.join(sys.home, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe);
    d.push({ id: 'home', label: 'Home directory writable', status: 'ok', detail: sys.home });
  } catch (e: any) {
    d.push({ id: 'home', label: 'Home directory writable', status: 'fail', detail: e.message });
  }
  if (full) {
    const integ = sys.db.get<{ integrity_check: string }>('PRAGMA integrity_check');
    d.push({ id: 'db-integrity', label: 'Database integrity', status: integ?.integrity_check === 'ok' ? 'ok' : 'fail', detail: integ?.integrity_check ?? 'no result' });
  }
  const gh = onPath('gh');
  if (!full) {
    /* the gh token check starts a process; only in a full run */
  } else if (!gh) d.push({ id: 'github-auth', label: 'GitHub authentication', status: 'warn', detail: 'gh CLI not found; GitHub discovery runs unauthenticated (lower rate limits) unless GITHUB_TOKEN is set' });
  else {
    const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
    const ok = r.status === 0 && !!r.stdout.trim();
    d.push({ id: 'github-auth', label: 'GitHub authentication', status: ok ? 'ok' : 'warn', detail: ok ? 'token available from gh (read at runtime, never stored)' : 'gh present but not logged in' });
  }
  for (const [id, bin] of [['claude-code', 'claude'], ['opencode', 'opencode'], ['codex', 'codex'], ['gemini-cli', 'gemini']] as const) {
    const p = onPath(bin);
    d.push({ id: `host-${id}`, label: `Host: ${id}`, status: p ? 'ok' : 'warn', detail: p ? `found at ${p}` : 'not installed on this machine' });
  }
  const missing = sys.db.all<{ id: string; snapshot_path: string }>('SELECT id, snapshot_path FROM capabilities WHERE snapshot_path IS NOT NULL').filter((r) => !fs.existsSync(r.snapshot_path));
  d.push({ id: 'store', label: 'Snapshot store', status: missing.length ? 'fail' : 'ok', detail: missing.length ? `${missing.length} snapshot(s) missing: ${missing.slice(0, 3).map((m) => m.id).join(', ')}` : `all registered snapshots present in ${sys.paths.store}` });
  return d;
}

/* =====================================================================
 * Command surface. One definition of every query and action; the CLI,
 * the Terminal Workbench (in-process) and the Web Command Center (HTTP)
 * all go through `api.call(name, args)`.
 * ===================================================================== */

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public hint?: string) {
    super(message);
  }
}
const need = <T>(v: T | null | undefined, what: string): T => {
  if (v == null) throw new ApiError(404, 'not-found', `No ${what}`);
  return v;
};
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new ApiError(400, 'invalid', `"${name}" is required`);
  return v;
};

export type CommandKind = 'query' | 'action';
export interface CommandDef {
  kind: CommandKind;
  title: string;
  run(args: any): unknown | Promise<unknown>;
}

export function createApi(sys: Sys, opts: { claudeRoot?: string; origin?: string; model?: ModelProvider } = {}) {
  const claudeRoot = opts.claudeRoot ?? env('CLAUDE_ROOT');
  const connectors = buildConnectorRegistry(sys, { claudeRoot });
  syncSources(sys, connectors);
  const deps: Deps = { connectors, adapters: buildAdapterRegistry({ claudeRoot, projectRoot: sys.settings().hosts.claudeProject || undefined }) };
  const origin = opts.origin ?? 'api';
  /** A source id that exists, or a 404 (found by fuzzing: an unknown id used to surface as a server error). */
  const knownSource = (v: unknown) => {
    const id = str(v, 'id');
    need(sys.db.get('SELECT 1 FROM sources WHERE id = ?', id), `source "${id}"`);
    return id;
  };

  const commands: Record<string, CommandDef> = {
    /* ---- queries ---- */
    'system.overview': { kind: 'query', title: 'System overview', run: () => ({ product: PRODUCT, home: sys.home, ...overview(sys) }) },
    'system.diagnostics': { kind: 'query', title: 'Run diagnostics', run: (a) => runDiagnostics(sys, { full: a?.full !== false }) },
    'system.events': { kind: 'query', title: 'Recent events', run: (a) => (a?.after != null ? eventsSince(sys.db, Number(a.after), Math.min(500, Number(a.limit) || 200)) : recentEvents(sys.db, Math.min(500, Number(a?.limit) || 100), a?.type || undefined)) },
    'system.settings': { kind: 'query', title: 'Settings', run: () => getSettings(sys.db) },
    'system.adapters': { kind: 'query', title: 'Host adapters', run: () => [...deps.adapters.list().map((x) => ({ id: x.id, title: x.title, status: x.status, evidence: x.statusEvidence, kinds: x.supportedKinds, detected: x.detect() })), ...UNSUPPORTED_HOSTS.map((h) => ({ id: h.id, title: h.title, status: h.status, evidence: h.reason, kinds: [], detected: { present: false, detail: h.reason } }))] },
    'system.schedule': { kind: 'query', title: 'Schedule plan', run: () => ({ registered: false, plan: schedulePlan('synaptome', sys.settings()) }) },
    'capabilities.list': { kind: 'query', title: 'List capabilities', run: (a = {}) => listCapabilities(sys, { q: a.q || undefined, kind: a.kind || undefined, domain: a.domain || undefined, status: a.status || undefined, trust: a.trust || undefined, tier: a.tier || undefined, origin: a.origin || undefined, installed: a.installed === true ? true : a.installed === false ? false : undefined, minQuality: a.minQuality != null && a.minQuality !== '' ? Number(a.minQuality) : undefined, sort: a.sort || undefined, limit: Math.min(200, Number(a.limit) || 60), offset: Number(a.offset) || 0 }) },
    'capabilities.facets': { kind: 'query', title: 'Capability facets', run: () => facets(sys) },
    'capabilities.get': { kind: 'query', title: 'Capability dossier', run: (a) => { const d = need(capabilityDossier(sys, str(a?.id, 'id')), `capability "${a.id}"`); return { ...d, entry: a.content ? readCapabilityEntry(sys, a.id) : null }; } },
    'candidates.list': { kind: 'query', title: 'List candidates', run: (a = {}) => { const r = listCandidates(sys, { state: a.state || undefined, source: a.source || undefined, kind: a.kind || undefined, q: a.q || undefined, sort: a.sort || undefined, limit: 500 }); const items = a.source || a.includeLocal ? r.items : r.items.filter((c) => c.sourceId !== 'local-claude'); return { total: items.length, items: items.slice(0, Math.min(200, Number(a.limit) || 80)) }; } },
    'candidates.get': { kind: 'query', title: 'Candidate detail', run: (a) => { const c = need(getCandidate(sys, str(a?.id, 'id')), `candidate "${a.id}"`); const au = sys.db.get<any>('SELECT * FROM audits WHERE subject_id=? ORDER BY id DESC LIMIT 1', c.id); return { ...c, audit: au ? { id: au.id, tier: au.tier, trust: au.trust, summary: au.summary, findings: pj(au.findings, []), licence: pj(au.license, null), at: au.created_at } : null }; } },
    'candidates.queue': { kind: 'query', title: 'Evaluation queue', run: (a) => evaluationQueue(sys, Number(a?.limit) || 30) },
    'sources.list': { kind: 'query', title: 'Discovery sources', run: () => listSources(sys, connectors).map((s) => ({ ...s, gate: sourceGate(sys, connectors.get(s.id)) })) },
    'sources.checks': { kind: 'query', title: 'Recent checks of one source', run: (a) => sourceChecks(sys, str(a?.id, 'id'), Math.min(100, Number(a?.limit) || 20)) },
    'sources.setEnabled': { kind: 'action', title: 'Enable or disable a source', run: (a) => (setSourceEnabled(sys, knownSource(a?.id), a?.enabled === true), { ok: true }) },
    'sources.setBudget': {
      kind: 'action', title: 'Set a source budget',
      run: (a) => {
        const id = knownSource(a?.id);
        try {
          return setSourceBudget(sys, id, { scansPerDay: a?.scansPerDay ?? undefined, requestsPerDay: a?.requestsPerDay ?? undefined, maxPerScan: a?.maxPerScan ?? undefined });
        } catch (e: any) {
          throw new ApiError(400, 'invalid', e.message);
        }
      },
    },
    'notifications.list': { kind: 'query', title: 'Notifications', run: (a = {}) => listNotifications(sys, { unreadOnly: a.all !== true, limit: Math.min(200, Number(a.limit) || 50) }) },
    'notifications.read': { kind: 'action', title: 'Mark notifications read', run: (a = {}) => ({ marked: markNotificationsRead(sys, a.id != null ? Number(a.id) : undefined) }) },
    'scans.list': { kind: 'query', title: 'Scan history', run: (a) => scanHistory(sys, Number(a?.limit) || 30) },
    'queue.get': { kind: 'query', title: 'Installation queue', run: () => ({ pendingApproval: listCapabilities(sys, { status: 'registered', origin: 'discovered', limit: 200, sort: 'quality' }).items.map((c) => ({ ...c, gate: latestGate(sys, c.id) })), forgePending: listCapabilities(sys, { status: 'registered', origin: 'forge', limit: 50 }).items, approvedNotInstalled: listCapabilities(sys, { status: 'approved', installed: false, limit: 200 }).items, installations: listInstallations(sys, { managedOnly: true }), realBudget: { used: sys.db.get<{ n: number }>("SELECT COUNT(DISTINCT capability_id) n FROM installations WHERE scope='real' AND status='installed'")!.n, limit: sys.settings().hosts.realInstallBudget } }) },
    'security.get': { kind: 'query', title: 'Security overview', run: () => ({ blockedCandidates: listCandidates(sys, { state: 'blocked', limit: 200 }).items, blockedCapabilities: listCapabilities(sys, { status: 'blocked', limit: 200 }).items, trust: facets(sys).trust, tiers: facets(sys).tier, recentAudits: sys.db.all<any>('SELECT a.id, a.subject_type, a.subject_id, a.tier, a.trust, a.critical, a.summary, a.created_at, COALESCE(c.name, k.name) AS name FROM audits a LEFT JOIN candidates c ON c.id = a.subject_id LEFT JOIN capabilities k ON k.id = a.subject_id WHERE a.subject_type != \'inventory\' ORDER BY a.id DESC LIMIT 40'), criticalAudits: sys.db.all<any>('SELECT a.id, a.subject_type, a.subject_id, a.tier, a.summary, a.findings, a.created_at, COALESCE(c.name, k.name) AS name FROM audits a LEFT JOIN candidates c ON c.id = a.subject_id LEFT JOIN capabilities k ON k.id = a.subject_id WHERE a.critical > 0 ORDER BY a.id DESC LIMIT 60').map((r) => ({ ...r, findings: pj<any[]>(r.findings, []).filter((f) => f.severity === 'critical').slice(0, 4) })) }) },
    'routing.decisions': { kind: 'query', title: 'Routing history', run: (a) => listDecisions(sys, Number(a?.limit) || 40) },
    'routing.decision': { kind: 'query', title: 'Routing decision', run: (a) => { const d = need(getDecision(sys, Number(a?.id)), `decision ${a?.id}`); return { ...d, explanation: explain(d as any) }; } },
    'routing.activations': { kind: 'query', title: 'Activations', run: (a) => listActivations(sys, { limit: Number(a?.limit) || 60 }) },
    'routing.gaps': { kind: 'query', title: 'Capability gaps', run: () => listGaps(sys) },
    'forge.list': { kind: 'query', title: 'Forge candidates', run: () => listForge(sys) },
    'forge.get': { kind: 'query', title: 'Forge candidate', run: (a) => getForge(sys, str(a?.id, 'id')) },
    'evals.list': { kind: 'query', title: 'Evaluation runs', run: (a) => listEvals(sys, a?.subjectId || undefined, Number(a?.limit) || 60) },

    /* ---- actions ---- */
    'scan.run': {
      kind: 'action', title: 'Scan for capabilities',
      async run(a = {}) {
        const mode = a.repo ? 'need' : a.mode ?? (a.query ? 'need' : 'broad');
        if (!['broad', 'incremental', 'need'].includes(mode)) throw new ApiError(400, 'invalid', `Invalid mode "${mode}"`);
        if (mode === 'need' && !a.query && !a.repo) throw new ApiError(400, 'invalid', 'A need-driven scan requires a query or a repository');
        if (a.repo && !/^[\w.-]+\/[\w.-]+$/.test(a.repo)) throw new ApiError(400, 'invalid', 'Repository must look like owner/name');
        const ids: string[] = a.repo ? ['github'] : Array.isArray(a.sources) && a.sources.length ? a.sources : ['github', 'mcp-registry'];
        const reports: ScanReport[] = [];
        for (const id of ids) reports.push(await scan(sys, connectors.get(id), { mode, query: a.repo ? `repo:${a.repo}` : a.query || undefined, limit: a.limit ? Number(a.limit) : undefined, origin }));
        return { reports };
      },
    },
    'sources.check': { kind: 'action', title: 'Check source health', async run() { for (const c of connectors.list()) await checkSourceHealth(sys, c); return listSources(sys, connectors); } },
    'candidates.evaluate': { kind: 'action', title: 'Evaluate a candidate', run: (a) => evaluateCandidate(sys, deps, str(a?.id, 'id')) },
    'queue.evaluateNext': { kind: 'action', title: 'Evaluate next in queue', run: (a) => evaluateQueue(sys, deps, Math.min(10, Number(a?.n) || 1)) },
    'capabilities.approve': { kind: 'action', title: 'Approve a capability', run: (a) => ({ gate: approve(sys, deps, str(a?.id, 'id'), { acceptLicence: a.acceptLicence || undefined, by: origin }) }) },
    'capabilities.reject': { kind: 'action', title: 'Reject a capability', run: (a) => { reject(sys, str(a?.id, 'id'), a.reason || `rejected via ${origin}`); return { ok: true }; } },
    'capabilities.install': { kind: 'action', title: 'Install a capability', run: (a) => install(sys, deps, str(a?.id, 'id'), { host: a.host || 'claude-code', scope: a.real ? 'real' : 'sandbox', confirmReal: a.confirm === true, by: origin }) },
    'installations.rollback': { kind: 'action', title: 'Roll back an installation', run: (a) => rollback(sys, deps, str(a?.id, 'id'), { force: a?.force === true }) },
    'installations.uninstall': { kind: 'action', title: 'Uninstall', run: (a) => uninstall(sys, deps, str(a?.id, 'id'), { force: a?.force === true }) },
    'routing.route': {
      kind: 'action', title: 'Route a task',
      async run(a) {
        const d = routeTask(sys, str(a?.task, 'task'), { origin });
        const discovery: ScanReport[] = [];
        if (a.discover && d.gaps.length) for (const g of d.gaps.slice(0, 2)) for (const id of ['github', 'mcp-registry']) discovery.push(await scan(sys, connectors.get(id), { mode: 'need', query: g.term, limit: 8, origin: 'router' }));
        return { ...d, explanation: explain(d), discovery };
      },
    },
    'settings.set': { kind: 'action', title: 'Change a setting', run: (a) => { try { setSetting(sys.db, str(a?.key, 'key'), a.value); } catch (e: any) { throw new ApiError(400, 'invalid', e.message); } return getSettings(sys.db); } },
    'inventory.run': { kind: 'action', title: 'Index local host inventory', run: () => ingestInventory(sys, deps) },
    'updates.check': { kind: 'action', title: 'Check for updates', run: () => checkUpdates(sys, connectors) },
    'updates.inspect': { kind: 'action', title: 'Inspect an update', run: (a) => inspectUpdate(sys, deps, str(a?.id, 'id')) },
    'updates.apply': { kind: 'action', title: 'Apply an update', run: (a) => applyUpdate(sys, deps, str(a?.id, 'id')) },
    'forge.check': { kind: 'action', title: 'Run forge checks', run: (a) => forgeCheck(sys, deps, str(a?.id, 'id')) },
    'forge.decide': { kind: 'action', title: 'Decide a forge candidate', run: (a) => forgeDecide(sys, deps, str(a?.id, 'id'), { reject: a.reject || undefined }) },
    'forge.new': { kind: 'action', title: 'Create a forge draft for a gap', run: (a) => forgeNew(sys, { gap: str(a?.gap, 'gap'), name: a.name || undefined, author: origin }) },
    'forge.author': { kind: 'action', title: 'Write a forge draft with a model', run: (a) => forgeAuthor(sys, str(a?.id, 'id'), opts.model ?? claudeCliProvider()) },

    /* ---- model providers ---- */
    'providers.list': { kind: 'query', title: 'Model providers', run: () => providerStatus(sys, buildProviders(sys)) },
    'providers.test': { kind: 'action', title: 'Verify a provider with one live call', run: async (a) => { const e = need(buildProviders(sys).find((x) => x.spec.id === str(a?.id, 'id')), `provider "${a?.id}"`); return checkProvider(sys, e); } },

    /* ---- workflows ---- */
    'workflows.list': { kind: 'query', title: 'Workflows', run: () => { const l = loadWorkflows(sys); return { workflows: l.workflows.map((w) => ({ id: w.def.id, version: w.def.version, title: w.def.title, description: w.def.description, origin: w.origin, inputs: w.def.inputs, permissions: w.def.permissions, steps: w.def.steps.map((s) => ({ id: s.id, title: s.title ?? s.id, kind: s.kind, needs: s.needs, permissions: s.permissions })) })), problems: l.problems }; } },
    'workflows.runs': { kind: 'query', title: 'Workflow runs', run: (a = {}) => listRuns(sys, { status: a.status || undefined, workflowId: a.workflow || undefined, limit: Math.min(200, Number(a.limit) || 50) }) },
    'workflows.run': { kind: 'query', title: 'Workflow run', run: (a) => need(getRun(sys, str(a?.id, 'id')), `workflow run "${a?.id}"`) },
    'workflows.history': { kind: 'query', title: 'Workflow run history', run: (a) => runHistory(sys, str(a?.id, 'id')) },
    'workflows.start': {
      kind: 'action', title: 'Start a workflow',
      run: (a) => {
        const w = need(findWorkflow(sys, str(a?.workflow, 'workflow')), `workflow "${a?.workflow}"`);
        const runId = startRun(sys, w.def, a.inputs ?? {}, { by: origin, grant: Array.isArray(a.grant) ? a.grant : undefined });
        void runWorkflow(sys, runId, { runners: workflowRunners() }).catch(() => undefined); // progress arrives on the event stream
        return { runId };
      },
    },
    'workflows.approve': { kind: 'action', title: 'Approve or reject a waiting step', run: (a) => { const v = approveStep(sys, str(a?.id, 'id'), str(a?.step, 'step'), { by: origin, approve: a.approve !== false, note: a.note || '' }); void runWorkflow(sys, v.id, { runners: workflowRunners() }).catch(() => undefined); return v; } },
    'workflows.resume': { kind: 'action', title: 'Resume a run', run: (a) => { const id = str(a?.id, 'id'); need(getRun(sys, id), `workflow run "${id}"`); void runWorkflow(sys, id, { runners: workflowRunners() }).catch(() => undefined); return { runId: id }; } },
    'workflows.trace': { kind: 'query', title: 'Agent trace of a run', run: (a) => need(trace(sys, str(a?.id, 'id')), `workflow run "${a?.id}"`) },
    'graph.get': {
      kind: 'query',
      title: 'Capability graph',
      run: (a = {}) => {
        const statuses: string[] = Array.isArray(a.statuses) && a.statuses.length ? a.statuses : ['approved', 'registered', 'blocked', 'deprecated'];
        const nodes = sys.db.all<any>(`SELECT id, name, domain, kind, status, quality, origin FROM capabilities WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY id LIMIT ?`, ...statuses, Math.min(50_000, Number(a.limit) || 20_000));
        const ids = new Set(nodes.map((n) => n.id));
        const edges = new Map<string, { src: string; dst: string; rel: string; weight: number }>();
        const add = (src: string, dst: string, rel: string, w = 1) => {
          if (src === dst || !ids.has(src) || !ids.has(dst)) return;
          const [x, y] = src < dst ? [src, dst] : [dst, src];
          const k = `${x}|${y}|${rel}`;
          const e = edges.get(k);
          if (e) e.weight += w;
          else edges.set(k, { src: x, dst: y, rel, weight: w });
        };
        for (const r of sys.db.all<any>('SELECT src, rel, dst, weight FROM relations')) add(r.src, r.dst, r.rel, r.weight);
        // Capabilities chosen together for the same task were used together: evidence from routing history.
        for (const d of sys.db.all<any>("SELECT selected FROM route_decisions WHERE selected != '[]' ORDER BY id DESC LIMIT 5000")) {
          const sel = pj<any[]>(d.selected, []).map((s) => s.capabilityId);
          for (let i = 0; i < sel.length; i++) for (let k = i + 1; k < sel.length; k++) add(sel[i], sel[k], 'used-together');
        }
        return { nodes, edges: [...edges.values()] };
      },
    },
    'evalsets.list': { kind: 'query', title: 'Evaluation sets', run: () => sys.db.all<any>('SELECT subject_id FROM eval_sets ORDER BY created_at DESC').map((r) => evalSetSummary(sys, r.subject_id)) },
    'evalsets.get': { kind: 'query', title: 'One evaluation set', run: (a) => ({ summary: evalSetSummary(sys, str(a?.id, 'id')), cases: listEvalCases(sys, str(a?.id, 'id')) }) },
    'agents.list': { kind: 'query', title: 'Specialist agents', run: () => SPECIALISTS.map(({ instructions, ...rest }) => ({ ...rest, instructions })) },
    'workflows.cancel': { kind: 'action', title: 'Cancel a run', run: (a) => cancelRun(sys, str(a?.id, 'id'), origin) },
  };
  /** Step runners for workflows started through this API. API steps call back into this same API. */
  const workflowRunners = () => defaultRunners({ api: { call, commands }, model: opts.model ?? claudeCliProvider(), agent: agentRunner({ providers: buildProviders(sys) }) });

  async function call<T = any>(name: string, args?: unknown): Promise<T> {
    const cmd = commands[name];
    if (!cmd) throw new ApiError(404, 'unknown-command', `Unknown command "${name}"`);
    const prev = origin;
    setOrigin(origin);
    try {
      return (await cmd.run(args ?? {})) as T;
    } catch (e: any) {
      if (e instanceof ApiError) throw e;
      if (e instanceof AcquisitionError) throw new ApiError(e.code === 'not-found' ? 404 : e.code === 'failed' ? 500 : e.code === 'invalid' ? 400 : 409, e.code, e.message, e.hint);
      if (e instanceof ForgeError) throw new ApiError(e.code === 'not-found' ? 404 : 409, e.code, e.message, e.hint);
      if (e instanceof ActivationError) throw new ApiError(e.code === 'not-found' ? 404 : 409, e.code, e.message);
      if (e instanceof WorkflowError) throw new ApiError(e.code === 'not-found' ? 404 : e.code === 'invalid' ? 400 : 409, e.code, e.message, e.hint);
      throw new ApiError(500, 'internal', e?.message ?? String(e));
    } finally {
      setOrigin(prev);
    }
  }
  return { call, commands, deps, sys };
}
export type Api = ReturnType<typeof createApi>;

/* =====================================================================
 * Local HTTP server: JSON command endpoint + resumable SSE event stream
 * + the Web Command Center's static assets. Bound to loopback only.
 * ===================================================================== */

export interface WebAssets {
  html: string;
  js: string;
  css: string;
}
export interface ServerHandle {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export function startServer(sys: Sys, opts: { port?: number; assets?: () => WebAssets | Promise<WebAssets>; claudeRoot?: string; token?: string } = {}): Promise<ServerHandle> {
  const api = createApi(sys, { claudeRoot: opts.claudeRoot, origin: 'web' });
  const token = opts.token ?? randomBytes(24).toString('hex');
  const streams = new Set<http.ServerResponse>();
  let assets: WebAssets | null = null;
  const getAssets = async () => (assets && !env('DEV') ? assets : (assets = opts.assets ? await opts.assets() : { html: '<!doctype html><title>Synaptome</title><p>API only: no web assets were provided.</p>', js: '', css: '' }));
  const base = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
  const send = (res: http.ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}) => res.writeHead(status, { ...base, 'Content-Type': type, ...extra }).end(body);
  const json = (res: http.ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
  /**
   * The per-start token travels only in a request header. A custom header cannot be attached by a cross-site
   * page without a CORS preflight, which this server never grants, and it never appears in a URL, a log line,
   * browser history or a Referer. Compared in constant time.
   */
  const tokenOk = (req: http.IncomingMessage) => {
    const given = req.headers[PRODUCT.tokenHeader];
    if (typeof given !== 'string' || given.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(token));
  };
  const unauthorized = (res: http.ServerResponse) => json(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Missing or wrong token' } });

  /**
   * Reads and discards a request body (up to the same 1 MB limit) before a refusal is sent. Answering while the client
   * is still sending can reset the connection, so the client would see a network error instead of the 4xx (found by
   * fuzzing); the dashboard relies on seeing a 401 to explain a stale token.
   */
  const drain = (req: http.IncomingMessage) =>
    new Promise<void>((resolve) => {
      if (req.readableEnded) return resolve();
      let n = 0;
      const done = () => (clearTimeout(t), resolve());
      const t = setTimeout(done, 2000);
      req.on('data', (c: Buffer) => {
        n += c.length;
        if (n > 1_000_000) (req.destroy(), done());
      });
      req.once('end', done);
      req.once('error', done);
      req.once('close', done);
    });

  const server = http.createServer(async (req, res) => {
    const refuse = async (status: number, body: unknown) => (await drain(req), json(res, status, body));
    try {
      const port = (server.address() as any).port;
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      // DNS-rebinding and cross-site protection: only loopback Host values, and same-origin browser requests.
      const hostOk = [`127.0.0.1:${port}`, `localhost:${port}`].includes(String(req.headers.host));
      const originHdr = req.headers.origin;
      const originOk = !originHdr || [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(String(originHdr));
      if (!hostOk || !originOk) return refuse(403, { ok: false, error: { code: 'forbidden', message: 'Requests are only accepted from this machine' } });
      // Browsers label where a request came from. Anything a browser marks as not same-origin never reaches the API.
      const fetchSite = req.headers['sec-fetch-site'];
      if (url.pathname.startsWith('/api/') && typeof fetchSite === 'string' && fetchSite !== 'same-origin') return refuse(403, { ok: false, error: { code: 'forbidden', message: 'Cross-site requests are not accepted' } });
      // A credential in a URL is refused outright, valid or not, so nothing can come to depend on it.
      if (url.searchParams.has('token')) return refuse(400, { ok: false, error: { code: 'token-in-url', message: `Credentials are not accepted in the URL; send the ${PRODUCT.tokenHeader} header` } });

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const a = await getAssets();
        return send(res, 200, a.html.replace('__SYNAPTOME_TOKEN__', token), 'text/html; charset=utf-8', { 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      }
      if (req.method === 'GET' && url.pathname === '/app.js') return send(res, 200, (await getAssets()).js, 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/app.css') return send(res, 200, (await getAssets()).css, 'text/css; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, product: PRODUCT.name, version: PRODUCT.version });

      if (req.method === 'GET' && url.pathname === '/api/events/stream') {
        if (!tokenOk(req)) return unauthorized(res);
        const resume = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? NaN);
        let last = Number.isFinite(resume) && resume >= 0 ? resume : sys.db.get<{ m: number }>('SELECT COALESCE(MAX(id),0) m FROM events')!.m;
        res.writeHead(200, { ...base, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        // Replays everything after `last`, then delivers new events as they are committed (this process at once,
        // other processes within the watcher's interval).
        const stop = watchEvents(sys.db, (rows) => {
          for (const e of rows) res.write(`id: ${e.id}\nevent: synaptome\ndata: ${JSON.stringify(e)}\n\n`);
        }, { after: last });
        const beat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
        streams.add(res);
        req.on('close', () => {
          stop();
          clearInterval(beat);
          streams.delete(res);
        });
        return;
      }

      const m = /^\/api\/call\/([\w.]+)$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        if (!tokenOk(req)) return (await drain(req), unauthorized(res));
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 1_000_000) return json(res, 413, { ok: false, error: { code: 'too-large', message: 'Request body too large' } });
        }
        let args: unknown = {};
        if (raw.trim()) {
          try {
            args = JSON.parse(raw);
          } catch {
            return json(res, 400, { ok: false, error: { code: 'invalid', message: 'Body is not valid JSON' } });
          }
        }
        try {
          return json(res, 200, { ok: true, data: await api.call(m[1], args) });
        } catch (e: any) {
          const status = e instanceof ApiError ? e.status : 500;
          return json(res, status, { ok: false, error: { code: e.code ?? 'internal', message: e.message, hint: e.hint } });
        }
      }
      return refuse(404, { ok: false, error: { code: 'not-found', message: `No route for ${req.method} ${url.pathname}` } });
    } catch (e: any) {
      if (!res.headersSent) json(res, 500, { ok: false, error: { code: 'internal', message: e?.message ?? 'Internal error' } });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4319, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        port,
        token,
        close: () =>
          new Promise<void>((done) => {
            for (const s of streams) s.end();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
