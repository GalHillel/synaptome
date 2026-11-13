import fs from 'node:fs';
import path from 'node:path';
import { AdapterRegistry, treeDigest } from '@synaptome/adapters';
import {
  type CandidateRow, type CapabilityRecord, type CapabilityRow, type FetchedFile, type FetchedPackage, type GateCheck, type HostAdapter, type PermissionPolicy, type Sys,
  PERMISSIONS, emit, estimateTokens, getCandidate, getCapability, hashFiles, inferDomain, j, listCapabilities, normalizedHash, notify, nowIso, parseFrontmatter, pj, relate,
  readTree, sha256, shortHash, slug, snapshotProvider, toList, tokenize, transitionCapability, upsertCapability, writeSnapshot, writeTree,
} from '@synaptome/core';
import { type ConnectorRegistry, scan, syncSources } from '@synaptome/discovery';
import { type AuditResult, type Scorecard, auditPackage, extractDependencies, scorePackage } from '@synaptome/security';
import { decideByRules, dynamicTestCheck, policyFacts, probeIsolation } from './policy';

export * from './policy';

/** Replaces the recorded dependencies of a capability with what its current files declare. */
export function storeDependencies(sys: Sys, capabilityId: string, files: FetchedFile[], frontmatter: Record<string, any>) {
  const found = extractDependencies(files, frontmatter);
  sys.db.tx(() => {
    sys.db.run('DELETE FROM dependencies WHERE capability_id = ?', capabilityId);
    for (const d of found) sys.db.run('INSERT INTO dependencies (capability_id, kind, name, spec, required, evidence, created_at) VALUES (?,?,?,?,?,?,?)', capabilityId, d.kind, d.name, d.spec, d.required, d.evidence, nowIso());
  });
  return found;
}

export function listDependencies(sys: Sys, capabilityId: string) {
  return sys.db.all<any>('SELECT kind, name, spec, required, evidence FROM dependencies WHERE capability_id = ? ORDER BY kind, name', capabilityId).map((r) => ({ ...r, required: !!r.required, advisories: 'not checked' }));
}

export interface Deps {
  connectors: ConnectorRegistry;
  adapters: AdapterRegistry;
}

export class AcquisitionError extends Error {
  constructor(public code: 'not-found' | 'blocked' | 'not-approved' | 'conflict' | 'unsupported' | 'budget' | 'not-staged' | 'needs-confirmation' | 'failed' | 'invalid' | 'busy' | 'modified', message: string, public hint?: string) {
    super(message);
  }
}

/* =====================================================================
 * ACQUISITION: quarantine -> audit -> score -> functional tests -> register
 * ===================================================================== */

export interface EvaluationReport {
  candidateId: string;
  capabilityId: string | null;
  state: string;
  tier: string;
  trust: string;
  score: number | null;
  unknowns: string[];
  findings: { critical: number; high: number; total: number };
  licence: { spdx: string; compatible: string; evidence: string };
  duplicateOf: string | null;
  gate: GateOutcome | null;
  autoInstalled: string[];
  summary: string;
}

function latestAudit(sys: Sys, cap: { id: string; candidateId: string | null }) {
  const r = sys.db.get<any>('SELECT * FROM audits WHERE subject_id IN (?, ?) ORDER BY id DESC LIMIT 1', cap.id, cap.candidateId ?? '');
  return r ? { ...r, findings: pj<any[]>(r.findings, []), license: pj<any>(r.license, {}), permissions: pj<Record<string, boolean>>(r.permissions, {}) } : null;
}

export function storeAudit(sys: Sys, subjectType: string, subjectId: string, contentHash: string, a: AuditResult): number {
  return Number(
    sys.db.run('INSERT INTO audits (subject_type, subject_id, content_hash, tier, trust, license, findings, permissions, summary, critical, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', subjectType, subjectId, contentHash, a.tier, a.trust, j(a.licence), j(a.findings), j(a.permissions), a.summary, a.critical, nowIso()).lastInsertRowid,
  );
}
export function storeScore(sys: Sys, subjectId: string, s: Scorecard) {
  sys.db.run('INSERT INTO scores (subject_id, total, dimensions, unknowns, weights, created_at) VALUES (?,?,?,?,?,?)', subjectId, s.total, j(s.dimensions), j(s.unknowns), j(s.weights), nowIso());
}

function sentences(text: string, re: RegExp): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => re.test(s)).map((s) => s.trim().slice(0, 240)).slice(0, 5);
}

function buildRecord(sys: Sys, id: string, cand: CandidateRow, files: FetchedFile[], pkg: Pick<FetchedPackage, 'provenance' | 'skipped'>, audit: AuditResult, score: Scorecard, deps: Deps): CapabilityRecord {
  const fm = audit.frontmatter;
  const name = typeof fm.name === 'string' && fm.name ? fm.name : cand.name;
  const description = typeof fm.description === 'string' && fm.description ? fm.description : cand.description;
  const entry = files.find((f) => f.path === audit.entryFile);
  const tags = [...new Set([...cand.topics, ...toList(fm.tags), ...toList(fm.keywords)].map((t) => t.toLowerCase()))].slice(0, 20);
  const kind = cand.kind as CapabilityRecord['kind'];
  return {
    id,
    schemaVersion: 1,
    name,
    description,
    kind,
    domain: inferDomain(`${name} ${description} ${tags.join(' ')}`),
    category: kind,
    tags,
    supportedTasks: [],
    activation: sentences(description, /\b(use (this |it )?(skill |agent )?(when|for|to)|when (the )?user|whenever|triggers?)\b/i),
    exclusion: sentences(`${description} ${entry ? parseFrontmatter(entry.content).body.slice(0, 4000) : ''}`, /\b(do not use|don't use|not for|avoid (using|when)|out of scope)\b/i),
    inputs: [],
    outputs: [],
    platforms: deps.adapters.list().filter((a) => a.supportedKinds.includes(kind)).map((a) => a.id),
    dependencies: toList(fm.dependencies ?? fm.compatibility),
    permissions: audit.permissions,
    networkRequired: !!audit.permissions.network,
    filesystemRequired: audit.executables.length > 0,
    executables: audit.executables,
    publisher: cand.publisher ?? '',
    repository: cand.repo ? `https://github.com/${cand.repo}` : cand.url ?? '',
    release: cand.upstreamVersion ?? '',
    commit: cand.ref ?? '',
    license: audit.licence,
    provenance: { sourceId: cand.sourceId, url: pkg.provenance.url, fetchedAt: nowIso(), verified: pkg.provenance.verified, method: pkg.provenance.method },
    verification: pkg.provenance.verified && audit.licence.compatible === 'yes' && audit.unreviewed === 0 ? 'verified' : pkg.provenance.verified ? 'partial' : 'unverified',
    security: { tier: audit.tier, trust: audit.trust, critical: audit.critical, findings: audit.findings.length },
    quality: { total: score.total, dimensions: score.dimensions, unknowns: score.unknowns },
    contextCost: entry ? estimateTokens(entry.content) : 0,
    benchmarks: [],
    weaknesses: [...score.unknowns.map((u) => `no evidence for ${u}`), ...pkg.skipped.map((s) => `${s.path}: ${s.reason}`)].slice(0, 12),
    conflicts: [],
    alternatives: cand.overlap.map((o) => o.id),
    installLocations: [],
    updateStatus: 'current',
    lastAuditAt: nowIso(),
    entryFile: audit.entryFile,
    fileCount: files.length,
  };
}

/** Deterministic functional checks. They are real tests with recorded results, not a benchmark. */
export function runFunctionalTests(sys: Sys, deps: Deps, cap: CapabilityRow, files: FetchedFile[]) {
  const checks: { id: string; passed: boolean; detail: string }[] = [];
  const adapter = deps.adapters.list().find((a) => a.supportedKinds.includes(cap.kind as any) && a.status !== 'UNSUPPORTED');
  if (!adapter) checks.push({ id: 'host-materialize', passed: false, detail: `no host adapter supports kind "${cap.kind}"` });
  else {
    const tmpRoot = path.join(sys.paths.cache, 'functional', `${slug(cap.id)}-${Date.now()}`);
    try {
      const target = adapter.targetFor(cap as any, 'sandbox', tmpRoot);
      adapter.materialize(cap.record, files, target);
      const v = adapter.verify(cap.record, target);
      checks.push({ id: 'host-materialize', passed: v.ok, detail: `${adapter.id}: ${v.detail}` });
      adapter.remove(target);
      checks.push({ id: 'host-remove', passed: !adapter.ops.exists(target), detail: 'staged copy removed cleanly (rollback path)' });
    } catch (e: any) {
      checks.push({ id: 'host-materialize', passed: false, detail: e.message });
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
  // Activation self-test: its own description must retrieve it near the top of the registry.
  const q = tokenize(`${cap.name.replace(/[-_]/g, ' ')} ${cap.description}`).slice(0, 8).join(' ');
  const pos = q ? listCapabilities(sys, { q, limit: 5 }).items.findIndex((c) => c.id === cap.id) : -1;
  checks.push({ id: 'activation-self', passed: pos >= 0, detail: pos >= 0 ? `retrieved at position ${pos + 1} for its own description terms` : 'not retrieved in the top 5 for its own description terms' });
  if (cap.snapshotPath) {
    let ok = false;
    try {
      ok = snapshotProvider(sys).read(cap.id)?.contentHash === cap.contentHash;
    } catch {
      ok = false;
    }
    checks.push({ id: 'snapshot-integrity', passed: ok, detail: ok ? 'canonical snapshot re-read and hash verified' : 'snapshot hash mismatch' });
  }
  const passed = checks.filter((c) => c.passed).length;
  const summary = { passed, total: checks.length, detail: checks.map((c) => `${c.id}:${c.passed ? 'pass' : 'FAIL'}`).join(' ') };
  sys.db.run('INSERT INTO eval_runs (subject_id, suite, runner, status, results, summary, created_at) VALUES (?,?,?,?,?,?,?)', cap.id, 'functional', 'deterministic', 'completed', j(checks), j(summary), nowIso());
  return { ...summary, checks };
}

export async function evaluateCandidate(sys: Sys, deps: Deps, candidateId: string, opts: { ref?: string } = {}): Promise<EvaluationReport> {
  const cand = getCandidate(sys, candidateId);
  if (!cand) throw new AcquisitionError('not-found', `No candidate "${candidateId}"`);
  if (cand.sourceId === 'local-claude') throw new AcquisitionError('invalid', 'Local inventory items are indexed with `synaptome inventory`, not acquired');
  const settings = sys.settings();
  const connector = deps.connectors.get(cand.sourceId);

  // 1. DOWNLOAD into QUARANTINE. Content is data from here on: never executed, never obeyed.
  const pkg = await connector.fetchPackage({ externalId: cand.externalId, repo: cand.repo, ref: opts.ref ?? cand.ref, path: cand.path, raw: cand.raw });
  if (!pkg.files.length) throw new AcquisitionError('failed', `Source returned no readable files for ${cand.name}`);
  const contentHash = hashFiles(pkg.files);
  const normHash = normalizedHash(pkg.files);
  const qPath = path.join(sys.paths.quarantine, cand.id, contentHash.slice(0, 16));
  if (!fs.existsSync(qPath)) {
    writeTree(qPath, pkg.files);
    fs.writeFileSync(path.join(qPath, '.quarantine.json'), JSON.stringify({ candidateId: cand.id, source: cand.sourceId, provenance: pkg.provenance, skipped: pkg.skipped, contentHash, quarantinedAt: nowIso() }, null, 2));
  }
  const fileList = pkg.files.map((f) => ({ path: f.path, size: f.size, sha256: sha256(f.content) }));
  const twin = sys.db.get<any>("SELECT id, capability_id FROM candidates WHERE id != ? AND content_hash = ? AND state = 'registered' LIMIT 1", cand.id, contentHash);
  const near = sys.db.all<any>('SELECT id, name FROM candidates WHERE id != ? AND norm_hash = ? AND content_hash != ? LIMIT 5', cand.id, normHash, contentHash);
  const overlap = [...cand.overlap, ...near.filter((n) => !cand.overlap.some((o) => o.id === n.id)).map((n) => ({ id: n.id, name: n.name, similarity: 0.98, basis: 'identical after whitespace/case normalisation' }))];
  sys.db.run('UPDATE candidates SET state=?, files=?, content_hash=?, norm_hash=?, quarantine_path=?, ref=COALESCE(?, ref), overlap=?, duplicate_of=COALESCE(?, duplicate_of) WHERE id=?', 'quarantined', j(fileList), contentHash, normHash, qPath, pkg.ref ?? opts.ref ?? null, j(overlap), twin?.id ?? null, cand.id);
  emit(sys.db, 'candidate.quarantined', cand.id, { name: cand.name, files: pkg.files.length, skipped: pkg.skipped.length });

  // 2. AUDIT
  const audit = auditPackage({ kind: cand.kind as any, files: pkg.files, skipped: pkg.skipped, declaredLicence: pkg.license ?? { spdx: cand.licenseSpdx, evidence: cand.licenseEvidence }, publisher: cand.publisher, provenanceVerified: pkg.provenance.verified, settings });
  storeAudit(sys, 'candidate', cand.id, contentHash, audit);
  const fmName = typeof audit.frontmatter.name === 'string' && audit.frontmatter.name ? audit.frontmatter.name : cand.name;
  const fmDesc = typeof audit.frontmatter.description === 'string' && audit.frontmatter.description ? audit.frontmatter.description : cand.description;
  sys.db.run('UPDATE candidates SET state=?, name=?, description=?, license_spdx=?, license_evidence=? WHERE id=?', 'audited', fmName, fmDesc, audit.licence.spdx || null, audit.licence.evidence, cand.id);
  emit(sys.db, 'audit.completed', cand.id, { name: fmName, tier: audit.tier, critical: audit.critical, high: audit.high, licence: audit.licence.spdx || 'unknown' });

  const base: EvaluationReport = {
    candidateId: cand.id, capabilityId: null, state: 'audited', tier: audit.tier, trust: audit.trust, score: null, unknowns: [],
    findings: { critical: audit.critical, high: audit.high, total: audit.findings.length }, licence: audit.licence, duplicateOf: twin?.id ?? null, gate: null, autoInstalled: [], summary: audit.summary,
  };

  // Tier C never enters the registry. It stays in quarantine for human review.
  if (audit.tier === 'C') {
    sys.db.run("UPDATE candidates SET state='blocked', recommended_action='blocked' WHERE id=?", cand.id);
    emit(sys.db, 'security.blocked', cand.id, { name: fmName, reasons: audit.findings.filter((f) => f.severity === 'critical').map((f) => f.message).slice(0, 5) });
    return { ...base, state: 'blocked', summary: `BLOCKED — ${audit.summary}` };
  }
  if (twin) {
    sys.db.run("UPDATE candidates SET recommended_action='skip-duplicate' WHERE id=?", cand.id);
    return { ...base, capabilityId: twin.capability_id, summary: `Exact duplicate of ${twin.id}; not registered twice. ${audit.summary}` };
  }

  // 3. REGISTER in the canonical registry (status "registered" = known, NOT approved, NOT installed).
  const fresh = getCandidate(sys, cand.id)!;
  let capId = fresh.capabilityId ?? `${slug(fresh.publisher ?? fresh.sourceId)}.${slug(fmName)}`;
  const clash = getCapability(sys, capId);
  if (!fresh.capabilityId && clash && clash.candidateId !== cand.id) capId = `${capId}-${shortHash(cand.id, 4)}`;
  const adapterOk = deps.adapters.list().some((a) => a.supportedKinds.includes(cand.kind as any) && a.status !== 'UNSUPPORTED');
  const prelim = scorePackage({ kind: cand.kind as any, files: pkg.files, audit, provenanceVerified: pkg.provenance.verified, pushedAt: cand.pushedAt, hostCompatible: adapterOk, settings });
  const snap = writeSnapshot(sys, capId, pkg.files);
  const entry = pkg.files.find((f) => f.path === audit.entryFile);
  let cap = upsertCapability(sys, buildRecord(sys, capId, fresh, pkg.files, pkg, audit, prelim, deps), { status: 'registered', origin: 'discovered', candidateId: cand.id, ...snap, version: cand.upstreamVersion ?? cand.ref ?? null, body: entry?.content ?? '' });
  sys.db.run("UPDATE candidates SET state='registered', capability_id=?, update_available=0 WHERE id=?", capId, cand.id);
  storeDependencies(sys, capId, pkg.files, audit.frontmatter);

  // 4. TEST, then SCORE with the test evidence included.
  const functional = runFunctionalTests(sys, deps, cap, pkg.files);
  const score = scorePackage({ kind: cand.kind as any, files: pkg.files, audit, provenanceVerified: pkg.provenance.verified, pushedAt: cand.pushedAt, hostCompatible: adapterOk, functional, settings });
  storeScore(sys, capId, score);
  cap = upsertCapability(sys, { ...cap.record, quality: { total: score.total, dimensions: score.dimensions, unknowns: score.unknowns }, weaknesses: [...score.unknowns.map((u) => `no evidence for ${u}`), ...pkg.skipped.map((s) => `${s.path}: ${s.reason}`)].slice(0, 12) });
  for (const o of overlap) {
    const other = sys.db.get<{ capability_id: string | null }>('SELECT capability_id FROM candidates WHERE id=?', o.id)?.capability_id;
    if (other && other !== capId) relate(sys, capId, 'overlaps', other, o.similarity, o.basis);
  }
  emit(sys.db, 'candidate.registered', cand.id, { capabilityId: capId, score: score.total, tier: audit.tier });

  // 5. GATE: auto-promote only when every condition passes with evidence.
  const policy = promotionPolicy(sys, deps);
  const host = settings.hosts.targets[0] ?? 'claude-code';
  const gate = policy.evaluate(capId, host) as GateOutcome;
  recordGate(sys, capId, host, gate, 'policy');
  const autoInstalled: string[] = [];
  if (gate.decision === 'auto-promote') {
    transitionCapability(sys, capId, 'approved', { reason: `promotion gate passed every check (score ${score.total})`, by: 'policy', payload: { score: score.total } });
    if (settings.policy.autoInstall === 'sandbox') {
      for (const h of settings.hosts.targets) {
        try {
          autoInstalled.push(install(sys, deps, capId, { host: h, scope: 'sandbox', by: 'policy' }).id);
        } catch (e: any) {
          emit(sys.db, 'install.failed', capId, { host: h, scope: 'sandbox', error: e.message });
        }
      }
    }
  }
  return { ...base, capabilityId: capId, state: 'registered', score: score.total, unknowns: score.unknowns, gate, autoInstalled, summary: `${audit.summary} Score ${score.total}. Gate: ${gate.decision}.` };
}

/** Processes the evaluation queue in rank order. */
export async function evaluateQueue(sys: Sys, deps: Deps, limit = 5): Promise<(EvaluationReport | { candidateId: string; error: string })[]> {
  const ids = sys.db.all<{ id: string }>("SELECT id FROM candidates WHERE state='queued' AND source_id != 'local-claude' ORDER BY rank DESC, first_seen_at ASC LIMIT ?", limit).map((r) => r.id);
  const out: (EvaluationReport | { candidateId: string; error: string })[] = [];
  for (const id of ids) {
    try {
      out.push(await evaluateCandidate(sys, deps, id));
    } catch (e: any) {
      sys.db.run("UPDATE candidates SET recommended_action='retry' WHERE id=?", id);
      emit(sys.db, 'candidate.evaluation-failed', id, { error: e.message });
      out.push({ candidateId: id, error: e.message });
      if (/rate limit/i.test(e.message)) break;
    }
  }
  return out;
}

/* =====================================================================
 * PROMOTION GATE (PermissionPolicy). The score is one condition of many.
 * 'unknown' is never a pass.
 * ===================================================================== */

export interface GateOutcome {
  checks: GateCheck[];
  passed: boolean;
  decision: 'auto-promote' | 'needs-approval' | 'blocked';
  blockers: string[];
  /** The policy rule that decided, or the default. */
  rule?: { id: string | null; effect: string; explanation: string };
}

export function promotionPolicy(sys: Sys, deps: Deps): PermissionPolicy {
  return {
    id: 'tiered-promotion-gate',
    evaluate(capabilityId: string, host: string): GateOutcome {
      const cap = getCapability(sys, capabilityId);
      if (!cap) throw new AcquisitionError('not-found', `No capability "${capabilityId}"`);
      const settings = sys.settings();
      const rec = cap.record;
      const audit = latestAudit(sys, cap);
      const score = sys.db.get<any>('SELECT * FROM scores WHERE subject_id=? ORDER BY id DESC LIMIT 1', cap.id);
      const functional = sys.db.get<any>("SELECT * FROM eval_runs WHERE subject_id=? AND suite='functional' ORDER BY id DESC LIMIT 1", cap.id);
      const checks: GateCheck[] = [];
      const add = (id: string, label: string, result: GateCheck['result'], evidence: string) => checks.push({ id, label, result, evidence });
      const blockers: string[] = [];

      const pol = settings.policy;
      const denied = pol.denyPublishers.map((p) => p.toLowerCase()).includes(rec.publisher.toLowerCase()) || pol.denyNamePatterns.some((p) => { try { return new RegExp(p, 'i').test(rec.name); } catch { return false; } });
      add('deny-rules', 'Not matched by an explicit deny rule', denied ? 'fail' : 'pass', denied ? `publisher "${rec.publisher}" or name "${rec.name}" is denied` : 'no deny rule matches');
      if (denied) blockers.push('deny rule');

      if (!score) add('score', `Quality score ≥ ${pol.autoInstallThreshold}`, 'unknown', 'no score recorded');
      else add('score', `Quality score ≥ ${pol.autoInstallThreshold}`, score.total >= pol.autoInstallThreshold ? 'pass' : 'fail', `score ${score.total}; unknown dimensions: ${pj<string[]>(score.unknowns, []).join(', ') || 'none'}`);

      add('provenance', 'Verified provenance', rec.provenance.verified ? 'pass' : 'fail', rec.provenance.verified ? `${rec.provenance.method} — ${rec.provenance.url}` : `not verifiable (${rec.provenance.method || 'no method recorded'})`);
      // A new owner of the upstream must be accepted by a person once before anything from it is promoted automatically.
      const moved = cap.candidateId ? (getCandidate(sys, cap.candidateId)?.signals.publisherChange as any) : undefined;
      if (moved && !moved.acknowledgedAt) add('publisher', 'Publisher unchanged since last approval', 'fail', `upstream moved from ${moved.from.repo ?? moved.from.publisher} to ${moved.to.repo ?? moved.to.publisher}; approval by a person required`);
      else add('publisher', 'Publisher unchanged since last approval', 'pass', moved ? `owner change to ${moved.to.repo ?? moved.to.publisher} accepted ${String(moved.acknowledgedAt).slice(0, 10)}` : 'no change of owner recorded');

      const lic = rec.license.compatible;
      add('licence', 'Compatible licence', lic === 'yes' ? 'pass' : lic === 'no' ? 'fail' : 'unknown', `${rec.license.spdx || 'unknown'} — ${rec.license.evidence}`);
      if (lic === 'no' && !(rec as any).licenceAccepted) blockers.push(`licence ${rec.license.spdx}`);

      if (!audit) add('security', 'No unresolved critical or high security findings', 'unknown', 'no audit recorded');
      else {
        const sev = audit.findings.filter((f: any) => (f.severity === 'critical' || f.severity === 'high') && f.category !== 'licence');
        add('security', 'No unresolved critical or high security findings', sev.length ? 'fail' : 'pass', sev.length ? sev.slice(0, 3).map((f: any) => `${f.severity}: ${f.message} (${f.file}:${f.line})`).join('; ') : `audit #${audit.id}: none`);
        if (audit.critical > 0) blockers.push('critical security finding');
      }

      add('tier', 'Declarative only (Tier A)', rec.security.tier === 'A' ? 'pass' : 'fail', rec.security.tier === 'A' ? 'no executables, hooks, MCP, network or install steps' : rec.security.tier === 'B' ? `Tier B: ${rec.executables.length} executable file(s); permissions ${truePerms(rec.permissions).join(', ') || 'none'}` : 'Tier C');
      if (rec.security.tier === 'C') blockers.push('Tier C');

      const unrev = audit ? audit.findings.filter((f: any) => f.category === 'unreviewed') : null;
      add('reviewed', 'All package content reviewed', unrev == null ? 'unknown' : unrev.length ? 'unknown' : 'pass', unrev == null ? 'no audit recorded' : unrev.length ? `${unrev.length} item(s) not reviewed: ${unrev.slice(0, 3).map((f: any) => f.file).join(', ')}` : 'every file was read by the audit');

      // Permission escalation relative to what is currently installed on this host.
      const prevInstall = sys.db.get<any>("SELECT content_hash FROM installations WHERE capability_id=? AND host=? AND status='installed' ORDER BY created_at DESC LIMIT 1", cap.id, host);
      const prevAudit = prevInstall && prevInstall.content_hash !== cap.contentHash ? sys.db.get<any>('SELECT permissions FROM audits WHERE content_hash=? ORDER BY id DESC LIMIT 1', prevInstall.content_hash) : null;
      const now = truePerms(rec.permissions);
      if (prevAudit) {
        const before = truePerms(pj(prevAudit.permissions, {}));
        const added = now.filter((p) => !before.includes(p));
        add('permissions', 'No permission escalation', added.length ? 'fail' : 'pass', added.length ? `new permissions vs installed version: ${added.join(', ')}` : 'no new permissions vs installed version');
      } else add('permissions', 'No permission escalation', now.length ? 'fail' : 'pass', now.length ? `requests: ${now.join(', ')}` : 'requests no permissions beyond reading its own files');

      // Conflicts with what the host already has.
      let adapter;
      try {
        adapter = deps.adapters.get(host);
      } catch {
        adapter = undefined;
      }
      if (!adapter || !adapter.supportedKinds.includes(cap.kind as any) || adapter.status === 'UNSUPPORTED') add('platform', 'Compatible target platform', 'fail', adapter ? `${adapter.title} adapter does not support kind "${cap.kind}"` : `no adapter for host "${host}"`);
      else add('platform', 'Compatible target platform', 'pass', `${adapter.title} adapter (${adapter.status}) supports ${cap.kind}`);
      if (adapter && adapter.supportedKinds.includes(cap.kind as any)) {
        let conflict = '';
        try {
          const real = adapter.targetFor(cap as any, 'real', sys.paths.sandboxHosts);
          if (adapter.ops.exists(real) && !ownsTarget(adapter, real, cap.id)) conflict = `${real} already exists and is not managed by Synaptome for this capability`;
          else if (adapter.preflight) {
            const files = snapshotProvider(sys).read(cap.id)?.files;
            if (files) conflict = adapter.preflight(cap.record, files, real) ?? '';
          }
        } catch {
          /* real installs unsupported for this adapter: no host-level conflict possible */
        }
        const sameName = sys.db.get<any>("SELECT c.id FROM capabilities c JOIN installations i ON i.capability_id=c.id AND i.status='installed' AND i.host=? WHERE c.name=? AND c.id != ? LIMIT 1", host, cap.name, cap.id);
        if (!conflict && sameName) conflict = `capability ${sameName.id} with the same name is already installed for ${host}`;
        add('conflict', 'No conflicting installed capability', conflict ? 'fail' : 'pass', conflict || 'no installed capability shares its name or target');
      } else add('conflict', 'No conflicting installed capability', 'unknown', 'cannot check without a supporting adapter');

      if (!functional) add('functional', 'Functional tests passed', 'unknown', 'no functional test run recorded');
      else {
        const s = pj<any>(functional.summary, {});
        add('functional', 'Functional tests passed', s.passed === s.total && s.total > 0 ? 'pass' : 'fail', `${s.passed}/${s.total}: ${s.detail}`);
      }

      let rollback = false;
      try {
        rollback = !!cap.snapshotPath && snapshotProvider(sys).read(cap.id)?.contentHash === cap.contentHash;
      } catch {
        rollback = false;
      }
      add('rollback', 'Known rollback path', rollback ? 'pass' : 'fail', rollback ? 'immutable snapshot verified; installs are marker-guarded and removable' : 'no verifiable snapshot');

      // Executable content is only ever tested dynamically inside strong isolation; until that has happened the
      // check cannot pass, whatever else is true.
      const executable = (rec.executables?.length ?? 0) > 0 || ['mcp-server', 'hook', 'tool', 'extension', 'connector'].includes(cap.kind);
      const dyn = dynamicTestCheck(executable, probeIsolation());
      add('dynamic-test', 'Executable content tested in isolation', dyn.result, dyn.evidence);

      // Policy rules decide last. They can block or require approval; allow-auto still needs every check to pass.
      const source = cap.candidateId ? sys.db.get<{ source_id: string }>('SELECT source_id FROM candidates WHERE id = ?', cap.candidateId)?.source_id ?? null : null;
      const rule = decideByRules(settings, policyFacts(cap, source));
      add('policy', 'Policy rules', rule.effect === 'deny' ? 'fail' : rule.effect === 'require-approval' ? 'unknown' : 'pass', rule.explanation);
      if (rule.effect === 'deny') blockers.push(`policy ${rule.rule?.id ?? 'default'}`);

      const passed = checks.every((c) => c.result === 'pass');
      const decision = blockers.length ? 'blocked' : passed ? 'auto-promote' : 'needs-approval';
      return { checks, passed, decision, blockers, rule: { id: rule.rule?.id ?? null, effect: rule.effect, explanation: rule.explanation } };
    },
  };
}

const truePerms = (p: Record<string, boolean>) => PERMISSIONS.filter((k) => p?.[k]);
const ownsTarget = (adapter: HostAdapter, target: string, capabilityId: string) => adapter.ops.owner(target) === capabilityId;
export function recordGate(sys: Sys, capId: string, host: string, g: GateOutcome, by: string) {
  sys.db.run('INSERT INTO gate_results (capability_id, host, checks, passed, decision, decided_by, created_at) VALUES (?,?,?,?,?,?,?)', capId, host, j({ checks: g.checks, blockers: g.blockers }), g.passed, g.decision, by, nowIso());
  emit(sys.db, 'gate.evaluated', capId, { decision: g.decision, failed: g.checks.filter((c) => c.result !== 'pass').map((c) => `${c.id}:${c.result}`) });
}
export function latestGate(sys: Sys, capId: string): (GateOutcome & { decidedBy: string; at: string; host: string }) | null {
  const r = sys.db.get<any>('SELECT * FROM gate_results WHERE capability_id=? ORDER BY id DESC LIMIT 1', capId);
  if (!r) return null;
  const c = pj<any>(r.checks, { checks: [], blockers: [] });
  return { checks: c.checks, blockers: c.blockers, passed: !!r.passed, decision: r.decision, decidedBy: r.decided_by, at: r.created_at, host: r.host };
}

/* ---------- human decisions ---------- */

export function approve(sys: Sys, deps: Deps, capabilityId: string, opts: { host?: string; acceptLicence?: string; by?: string } = {}): GateOutcome {
  const cap = getCapability(sys, capabilityId);
  if (!cap) throw new AcquisitionError('not-found', `No capability "${capabilityId}"`);
  if (cap.origin === 'host-inventory') throw new AcquisitionError('invalid', 'Inventory entries are already on the host; there is nothing to approve');
  const host = opts.host ?? sys.settings().hosts.targets[0] ?? 'claude-code';
  if (opts.acceptLicence) {
    upsertCapability(sys, { ...cap.record, licenceAccepted: { reason: opts.acceptLicence, at: nowIso(), by: opts.by ?? 'user' } });
    emit(sys.db, 'licence.accepted', capabilityId, { reason: opts.acceptLicence });
  }
  const gate = promotionPolicy(sys, deps).evaluate(capabilityId, host) as GateOutcome;
  recordGate(sys, capabilityId, host, gate, opts.by ?? 'user');
  if (gate.decision === 'blocked') throw new AcquisitionError('blocked', `Cannot approve ${capabilityId}: ${gate.blockers.join('; ')}`, gate.blockers.some((b) => b.startsWith('licence')) ? 'a licence outside the allow list needs an explicit --accept-licence "<reason>" (local use only)' : 'critical findings and deny rules cannot be overridden');
  const lic = cap.record.license.compatible;
  if (lic === 'unknown' && !opts.acceptLicence && !(cap.record as any).licenceAccepted) throw new AcquisitionError('blocked', `Licence of ${capabilityId} is unknown`, 'approve with --accept-licence "<reason>" to record that you accept this for local use');
  const unresolved = gate.checks.filter((c) => c.result !== 'pass').map((c) => c.id);
  // A person approving now accepts the new owner: record it, and follow the repository under its new name.
  const cand = cap.candidateId ? getCandidate(sys, cap.candidateId) : null;
  const moved = cand?.signals.publisherChange as any;
  if (cand && moved && !moved.acknowledgedAt) {
    sys.db.run('UPDATE candidates SET publisher=?, repo=?, signals=? WHERE id=?', moved.to.publisher ?? cand.publisher, moved.to.repo ?? cand.repo, j({ ...cand.signals, publisherChange: { ...moved, acknowledgedAt: nowIso(), acknowledgedBy: opts.by ?? 'user' } }), cand.id);
    emit(sys.db, 'publisher.accepted', capabilityId, { from: moved.from, to: moved.to });
  }
  transitionCapability(sys, capabilityId, 'approved', {
    reason: unresolved.length ? `approved by a person with unresolved checks: ${unresolved.join(', ')}` : 'approved by a person; every gate check passed',
    by: opts.by ?? 'user',
    payload: { unresolved },
    extraSql: "trust = CASE WHEN trust = 'UNKNOWN' THEN 'REVIEWED_COMMUNITY' ELSE trust END",
  });
  return gate;
}

export function reject(sys: Sys, capabilityId: string, reason: string) {
  const cap = getCapability(sys, capabilityId);
  if (!cap) throw new AcquisitionError('not-found', `No capability "${capabilityId}"`);
  if (sys.db.get("SELECT 1 FROM installations WHERE capability_id=? AND status='installed' AND scope != 'external'", capabilityId)) throw new AcquisitionError('conflict', `${capabilityId} is installed; uninstall or roll back first`);
  transitionCapability(sys, capabilityId, 'rejected', { reason: reason || 'rejected', by: 'user' });
  if (cap.candidateId) sys.db.run("UPDATE candidates SET state='rejected', recommended_action='rejected' WHERE id=?", cap.candidateId);
}

/* =====================================================================
 * INSTALLATION (per host). Approved != installed.
 * ===================================================================== */

export interface InstallationRow {
  id: string;
  capabilityId: string;
  host: string;
  scope: 'sandbox' | 'real' | 'external';
  targetPath: string;
  version: string | null;
  contentHash: string;
  status: 'installed' | 'rolled_back' | 'uninstalled' | 'failed' | 'superseded';
  previousId: string | null;
  backupPath: string | null;
  verified: boolean;
  verifyDetail: string | null;
  /** Fingerprint of the installed directory (every file, marker included) taken right after install. */
  treeHash: string | null;
  createdAt: string;
  updatedAt: string;
  name?: string;
}
const mapInst = (r: any): InstallationRow => ({ id: r.id, capabilityId: r.capability_id, host: r.host, scope: r.scope, targetPath: r.target_path, version: r.version, contentHash: r.content_hash, status: r.status, previousId: r.previous_id, backupPath: r.backup_path, verified: !!r.verified, verifyDetail: r.verify_detail, treeHash: r.tree_hash ?? null, createdAt: r.created_at, updatedAt: r.updated_at, name: r.name });

export function listInstallations(sys: Sys, f: { managedOnly?: boolean; status?: string; limit?: number } = {}): InstallationRow[] {
  const where = [f.managedOnly ? "i.scope != 'external'" : '1', f.status ? 'i.status = ?' : '1'].join(' AND ');
  return sys.db.all<any>(`SELECT i.*, c.name FROM installations i LEFT JOIN capabilities c ON c.id = i.capability_id WHERE ${where} ORDER BY i.created_at DESC LIMIT ?`, ...(f.status ? [f.status] : []), f.limit ?? 200).map(mapInst);
}
export function getInstallation(sys: Sys, id: string): InstallationRow | null {
  const r = sys.db.get<any>('SELECT i.*, c.name FROM installations i LEFT JOIN capabilities c ON c.id = i.capability_id WHERE i.id=?', id);
  return r ? mapInst(r) : null;
}

export { treeDigest };

/** Copies a target's current state into a backup folder and records the copy's own fingerprint beside it. */
function takeBackup(adapter: HostAdapter, target: string, dir: string) {
  adapter.ops.backup(target, dir);
  fs.writeFileSync(`${dir}.sha256`, treeDigest(dir) ?? '');
}
/** A backup is usable when its recorded fingerprint still matches (older backups: when it matches the previous install). */
function backupIntact(dir: string, legacyExpected: string | null): boolean {
  if (!fs.existsSync(dir)) return false;
  if (fs.existsSync(`${dir}.sha256`)) return fs.readFileSync(`${dir}.sha256`, 'utf8') === treeDigest(dir);
  return !legacyExpected || treeDigest(dir) === legacyExpected;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function lockIsStale(file: string): boolean {
  try {
    const { pid, at } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - Date.parse(at) > 10 * 60_000) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (e: any) {
      return e.code === 'ESRCH';
    }
  } catch {
    // unreadable: either being written this instant, or left half-written by a crash
    try {
      return Date.now() - fs.statSync(file).mtimeMs > 5_000;
    } catch {
      return false;
    }
  }
}

/**
 * Serialises every change to one host directory across processes (CLI, dashboard, TUI, MCP server, scheduler).
 * A lock whose owner has exited is taken over. The unique index on live installations is the second line of defence.
 */
export function withHostLock<T>(sys: Sys, target: string, fn: () => T, waitMs = 20_000): T {
  const dir = path.join(sys.paths.home, 'locks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${shortHash(path.resolve(target).toLowerCase(), 16)}.lock`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, target, at: nowIso() }), { flag: 'wx' });
      break;
    } catch (e: any) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
      if (e.code === 'EEXIST' && lockIsStale(file)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new AcquisitionError('busy', `Another process is changing ${target}`, 'retry when it has finished');
      sleepSync(20 + Math.floor(Math.random() * 40));
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Resolves a recorded version of a capability (full content hash or a prefix of at least 8 characters). */
function recordedVersion(sys: Sys, capabilityId: string, hashOrPrefix: string): { contentHash: string; snapshotPath: string; version: string | null } {
  if (!/^[0-9a-f]{8,}$/i.test(hashOrPrefix)) throw new AcquisitionError('invalid', `"${hashOrPrefix}" is not a content hash (at least 8 hexadecimal characters)`);
  const rows = sys.db.all<any>('SELECT content_hash, snapshot_path, version FROM capability_versions WHERE capability_id=? AND content_hash LIKE ?', capabilityId, `${hashOrPrefix.toLowerCase()}%`);
  if (!rows.length) throw new AcquisitionError('not-found', `No recorded version ${hashOrPrefix} of ${capabilityId}`, `list its versions with: synaptome inspect ${capabilityId}`);
  if (rows.length > 1) throw new AcquisitionError('invalid', `${hashOrPrefix} matches ${rows.length} versions of ${capabilityId}; give more characters`);
  return { contentHash: rows[0].content_hash, snapshotPath: rows[0].snapshot_path, version: rows[0].version };
}
function readVersionFiles(v: { contentHash: string; snapshotPath: string }): FetchedFile[] | null {
  if (!v.snapshotPath || !fs.existsSync(v.snapshotPath)) return null;
  const files = readTree(v.snapshotPath);
  return hashFiles(files) === v.contentHash ? files : null;
}

export function install(sys: Sys, deps: Deps, capabilityId: string, opts: { host: string; scope: 'sandbox' | 'real'; confirmReal?: boolean; by?: string; contentHash?: string }): InstallationRow {
  const cap = getCapability(sys, capabilityId);
  if (!cap) throw new AcquisitionError('not-found', `No capability "${capabilityId}"`);
  if (cap.status !== 'approved') throw new AcquisitionError('not-approved', `${capabilityId} is "${cap.status}", not approved`, `review it with: synaptome inspect ${capabilityId}   then: synaptome approve ${capabilityId}`);
  let adapter: ReturnType<AdapterRegistry['get']>;
  try {
    adapter = deps.adapters.get(opts.host);
  } catch (e: any) {
    throw new AcquisitionError('unsupported', e.message);
  }
  if (!adapter.supportedKinds.includes(cap.kind as any)) throw new AcquisitionError('unsupported', `${adapter.title} adapter cannot install kind "${cap.kind}"`);
  const current = snapshotProvider(sys).read(capabilityId);
  if (!current) throw new AcquisitionError('failed', `No canonical snapshot for ${capabilityId}`);
  let pkg: { files: FetchedFile[]; contentHash: string } = current;
  let version = cap.version;
  let downgradeFrom: string | null = null;
  if (opts.contentHash && !current.contentHash.startsWith(opts.contentHash.toLowerCase())) {
    // An earlier version: only one that Synaptome itself installed and verified before, i.e. one that passed the gate then.
    const v = recordedVersion(sys, capabilityId, opts.contentHash);
    if (!sys.db.get("SELECT 1 FROM installations WHERE capability_id=? AND content_hash=? AND verified=1 AND scope != 'external' LIMIT 1", capabilityId, v.contentHash)) {
      throw new AcquisitionError('not-approved', `Version ${v.contentHash.slice(0, 12)} of ${capabilityId} was never installed and verified, so it never passed the gate`, 'only versions that were installed before can be restored');
    }
    const files = readVersionFiles(v);
    if (!files) throw new AcquisitionError('failed', `The stored copy of version ${v.contentHash.slice(0, 12)} is missing or fails its integrity check`);
    pkg = { files, contentHash: v.contentHash };
    version = v.version;
    downgradeFrom = current.contentHash;
  }
  const settings = sys.settings();

  if (opts.scope === 'real') {
    if (!opts.confirmReal) throw new AcquisitionError('needs-confirmation', 'Installing into a real host directory needs explicit confirmation', 'repeat with --real --yes');
    if (!adapter.detect().present) throw new AcquisitionError('unsupported', `${adapter.title} was not detected on this machine`);
    const staged = sys.db.get<any>("SELECT id FROM installations WHERE capability_id=? AND host=? AND scope='sandbox' AND content_hash=? AND verified=1 LIMIT 1", capabilityId, opts.host, pkg.contentHash);
    if (!staged) throw new AcquisitionError('not-staged', 'This exact version has not passed a staged (sandbox) install for this host', `run first: synaptome install ${capabilityId} --host ${opts.host}`);
    const others = sys.db.get<{ n: number }>("SELECT COUNT(DISTINCT capability_id) n FROM installations WHERE scope='real' AND status='installed' AND capability_id != ?", capabilityId)!.n;
    if (others >= settings.hosts.realInstallBudget) throw new AcquisitionError('budget', `Real-install budget reached (${others}/${settings.hosts.realInstallBudget})`, 'raise hosts.realInstallBudget deliberately with: synaptome config set hosts.realInstallBudget <n>');
  }

  let target: string;
  try {
    target = adapter.targetFor(cap as any, opts.scope, sys.paths.sandboxHosts);
  } catch (e: any) {
    throw new AcquisitionError('unsupported', e.message);
  }
  if (opts.scope === 'real' && adapter.status === 'EXPERIMENTAL') throw new AcquisitionError('unsupported', `${adapter.title} adapter is EXPERIMENTAL; real installs are disabled`);
  const ops = adapter.ops;
  return withHostLock(sys, target, () => {
    // Read the state again inside the lock: another process may have just changed it.
    const prev = sys.db.get<any>("SELECT * FROM installations WHERE capability_id=? AND host=? AND scope=? AND status='installed' ORDER BY created_at DESC LIMIT 1", capabilityId, opts.host, opts.scope);
    if (prev && prev.content_hash === pkg.contentHash && ops.exists(target)) return mapInst(prev); // idempotent

    const id = `i-${shortHash(`${capabilityId}|${opts.host}|${opts.scope}|${pkg.contentHash}|${Date.now()}|${process.pid}|${Math.random()}`, 10)}`;
    const existed = ops.exists(target);
    const why = adapter.preflight?.(cap.record, pkg.files, target);
    if (why) throw new AcquisitionError('conflict', `Cannot install ${capabilityId} at ${target}: ${why}`);
    if (existed && !ownsTarget(adapter, target, capabilityId)) throw new AcquisitionError('conflict', `${target} already exists and was not installed by Synaptome for this capability`, 'Synaptome never overwrites existing host content');
    let backupPath: string | null = null;
    if (existed) {
      // Whatever is there now is copied first, tracked or not, so a failure or a rollback can put it back exactly.
      backupPath = path.join(sys.paths.backups, 'installs', `${id}-replaced`);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      takeBackup(adapter, target, backupPath);
    }
    const now = nowIso();
    let removed = false;
    try {
      if (existed) {
        adapter.remove(target);
        removed = true;
      }
      adapter.materialize(cap.record, pkg.files, target);
      const v = adapter.verify(cap.record, target);
      if (!v.ok) throw new Error(`verification failed: ${v.detail}`);
      const treeHash = ops.fingerprint(target);
      sys.db.tx(() => {
        if (prev) sys.db.run("UPDATE installations SET status='superseded', updated_at=? WHERE id=?", now, prev.id);
        sys.db.run('INSERT INTO installations (id, capability_id, host, scope, target_path, version, content_hash, status, previous_id, backup_path, verified, verify_detail, tree_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, capabilityId, opts.host, opts.scope, target, version, pkg.contentHash, 'installed', prev?.id ?? null, backupPath, 1, v.detail, treeHash, now, now);
      });
      emit(sys.db, 'install.completed', capabilityId, { installationId: id, host: opts.host, scope: opts.scope, target, by: opts.by ?? 'user', upgradeFrom: prev?.id ?? null, downgradeFrom });
      return getInstallation(sys, id)!;
    } catch (e: any) {
      // Leave the host exactly as it was. Anything at the target now was written by this attempt,
      // because the previous content was removed (or never existed) before materialising.
      let restoreProblem = '';
      try {
        if (ops.exists(target) && (removed || !existed)) ops.discard(target);
        if (backupPath && removed) ops.restore(backupPath, target);
      } catch (re: any) {
        restoreProblem = `; restoring the previous files failed (${re.message}), they are kept at ${backupPath}`;
      }
      sys.db.run('INSERT INTO installations (id, capability_id, host, scope, target_path, version, content_hash, status, previous_id, backup_path, verified, verify_detail, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, capabilityId, opts.host, opts.scope, target, version, pkg.contentHash, 'failed', prev?.id ?? null, backupPath, 0, `${e.message}${restoreProblem}`, now, now);
      emit(sys.db, 'install.failed', capabilityId, { installationId: id, host: opts.host, scope: opts.scope, error: e.message, restoreProblem: restoreProblem || null });
      throw new AcquisitionError('failed', `Install failed and was reverted: ${e.message}${restoreProblem}`);
    }
  });
}

/** Installs an earlier version that Synaptome installed and verified before. Same guardrails as install. */
export const downgrade = (sys: Sys, deps: Deps, capabilityId: string, opts: { host: string; scope: 'sandbox' | 'real'; contentHash: string; confirmReal?: boolean; by?: string }) => {
  if (!opts.contentHash) throw new AcquisitionError('invalid', 'Name the version to return to by its content hash', `list versions with: synaptome inspect ${capabilityId}`);
  return install(sys, deps, capabilityId, opts);
};

export interface RemovalResult extends InstallationRow {
  restored: string | null;
  restoredFrom: 'backup' | 'snapshot' | null;
  /** Where edited files were copied before removal (only with force). */
  preserved: string | null;
}

function removeInstall(sys: Sys, deps: Deps, installationId: string, mode: 'rolled_back' | 'uninstalled', opts: { force?: boolean } = {}): RemovalResult {
  const first = getInstallation(sys, installationId);
  if (!first) throw new AcquisitionError('not-found', `No installation "${installationId}"`, 'list ids with: synaptome installs');
  if (first.scope === 'external') throw new AcquisitionError('invalid', 'This entry was already on the host before Synaptome; Synaptome does not remove content it did not install');
  const adapter = deps.adapters.get(first.host);
  return withHostLock(sys, first.targetPath, () => {
    const inst = getInstallation(sys, installationId)!;
    if (inst.status !== 'installed') throw new AcquisitionError('invalid', `Installation ${installationId} is "${inst.status}", not installed`);
    const target = inst.targetPath;
    const verb = mode === 'rolled_back' ? 'rolling back' : 'uninstalling';

    // 1. Never discard changes made after install without being told to, and even then keep a copy.
    const ops = adapter.ops;
    const actual = ops.fingerprint(target);
    if (actual && !ownsTarget(adapter, target, inst.capabilityId)) throw new AcquisitionError('conflict', `${target} no longer carries Synaptome's record for ${inst.capabilityId}`, 'Synaptome does not remove content it cannot prove it installed');
    let preserved: string | null = null;
    // Installations made before fingerprints existed are checked against their recorded content instead.
    const legacyPayload = inst.treeHash ? null : ops.payloadHash(target);
    const edited = !!actual && (inst.treeHash ? actual !== inst.treeHash : legacyPayload !== null && legacyPayload !== inst.contentHash);
    if (edited) {
      if (!opts.force) {
        throw new AcquisitionError('modified', `${target} was changed after Synaptome installed it; nothing was removed`, `copy your changes elsewhere, or repeat with --force: the changed files are then copied under ${path.join(sys.paths.backups, 'installs')} before ${verb}`);
      }
      preserved = path.join(sys.paths.backups, 'installs', `${inst.id}-edited-${Date.now()}`);
      fs.mkdirSync(path.dirname(preserved), { recursive: true });
      ops.backup(target, preserved);
    }

    // 2. Decide what to put back before removing anything.
    const prev = inst.previousId ? sys.db.get<any>('SELECT * FROM installations WHERE id=?', inst.previousId) : null;
    let source: { kind: 'backup'; dir: string } | { kind: 'snapshot'; files: FetchedFile[] } | null = null;
    if (mode === 'rolled_back' && inst.backupPath) {
      if (backupIntact(inst.backupPath, prev?.tree_hash ?? null)) source = { kind: 'backup', dir: inst.backupPath };
      else if (prev) {
        const v = sys.db.get<any>('SELECT content_hash, snapshot_path FROM capability_versions WHERE capability_id=? AND content_hash=?', inst.capabilityId, prev.content_hash);
        const files = v ? readVersionFiles({ contentHash: v.content_hash, snapshotPath: v.snapshot_path }) : null;
        if (files) source = { kind: 'snapshot', files };
      }
      if (!source) throw new AcquisitionError('failed', `Cannot roll back ${inst.id}: the copy of what it replaced is missing or damaged; nothing was changed`, `remove it instead with: synaptome uninstall ${inst.id}`);
    }

    // 3. Remove, then restore.
    if (actual) adapter.remove(target);
    const now = nowIso();
    let restored: string | null = null;
    if (source) {
      if (source.kind === 'backup') ops.restore(source.dir, target);
      else adapter.materialize(getCapability(sys, inst.capabilityId)!.record, source.files, target);
      if (prev) restored = prev.id;
    }
    const restoredTree = restored ? ops.fingerprint(target) : null;
    sys.db.tx(() => {
      sys.db.run('UPDATE installations SET status=?, updated_at=? WHERE id=?', mode, now, installationId);
      if (restored) sys.db.run("UPDATE installations SET status='installed', tree_hash=?, updated_at=? WHERE id=?", restoredTree, now, restored);
    });
    emit(sys.db, mode === 'rolled_back' ? 'install.rolled-back' : 'install.uninstalled', inst.capabilityId, { installationId, host: inst.host, scope: inst.scope, target, restored, restoredFrom: source?.kind ?? null, preserved });
    return { ...getInstallation(sys, installationId)!, restored, restoredFrom: source?.kind ?? null, preserved };
  });
}
/* ---------- integrity of installed content (repair) ---------- */

export interface InstallCheck {
  id: string;
  capabilityId: string;
  host: string;
  scope: string;
  target: string;
  /** ok: matches what was installed; missing: gone from the host; modified: changed after install; not-ours: no longer carries our record. */
  state: 'ok' | 'missing' | 'modified' | 'not-ours';
  detail: string;
}

/** Compares every live managed installation with the fingerprint taken right after it was installed. Reads only. */
export function checkInstallations(sys: Sys, deps: Deps): InstallCheck[] {
  return listInstallations(sys, { managedOnly: true, status: 'installed', limit: 10_000 }).map((i) => {
    const base = { id: i.id, capabilityId: i.capabilityId, host: i.host, scope: i.scope, target: i.targetPath };
    let adapter;
    try {
      adapter = deps.adapters.get(i.host);
    } catch {
      return { ...base, state: 'not-ours' as const, detail: `no adapter for host "${i.host}"` };
    }
    const actual = adapter.ops.fingerprint(i.targetPath);
    if (!actual) return { ...base, state: 'missing' as const, detail: 'the installed files are gone from the host' };
    if (!ownsTarget(adapter, i.targetPath, i.capabilityId)) return { ...base, state: 'not-ours' as const, detail: 'the target no longer carries Synaptome\'s record; left alone' };
    if (i.treeHash && actual !== i.treeHash) return { ...base, state: 'modified' as const, detail: 'changed after install; left alone (your edits are never overwritten)' };
    return { ...base, state: 'ok' as const, detail: 'matches the installed fingerprint' };
  });
}

/**
 * Puts back an installation whose files were deleted from the host, from the exact version that was installed (its
 * stored snapshot, integrity-checked). Only for state "missing": modified or foreign content is never touched.
 */
export function restoreMissingInstall(sys: Sys, deps: Deps, installationId: string): InstallCheck {
  const inst = getInstallation(sys, installationId);
  if (!inst || inst.status !== 'installed' || inst.scope === 'external') throw new AcquisitionError('invalid', `${installationId} is not a live managed installation`);
  const adapter = deps.adapters.get(inst.host);
  return withHostLock(sys, inst.targetPath, () => {
    if (adapter.ops.fingerprint(inst.targetPath)) throw new AcquisitionError('conflict', `${inst.targetPath} exists; only missing installations are restored`);
    const v = sys.db.get<any>('SELECT content_hash, snapshot_path FROM capability_versions WHERE capability_id=? AND content_hash=?', inst.capabilityId, inst.contentHash);
    let current: { files: FetchedFile[]; contentHash: string } | null = null;
    try {
      current = snapshotProvider(sys).read(inst.capabilityId);
    } catch {
      /* damaged snapshot: treated as missing */
    }
    const files = (v ? readVersionFiles({ contentHash: v.content_hash, snapshotPath: v.snapshot_path }) : null) ?? (current?.contentHash === inst.contentHash ? current.files : null);
    if (!files) throw new AcquisitionError('failed', `The stored copy of ${inst.capabilityId} version ${inst.contentHash.slice(0, 12)} is missing or damaged; nothing was written`);
    const cap = getCapability(sys, inst.capabilityId);
    if (!cap) throw new AcquisitionError('not-found', `No capability "${inst.capabilityId}"`);
    adapter.materialize(cap.record, files, inst.targetPath);
    const ver = adapter.verify(cap.record, inst.targetPath);
    if (!ver.ok) {
      adapter.ops.discard(inst.targetPath);
      throw new AcquisitionError('failed', `Restored files failed verification (${ver.detail}); removed again`);
    }
    const tree = adapter.ops.fingerprint(inst.targetPath);
    sys.db.run('UPDATE installations SET tree_hash=?, verify_detail=?, updated_at=? WHERE id=?', tree, `restored by repair: ${ver.detail}`, nowIso(), inst.id);
    emit(sys.db, 'install.repaired', inst.capabilityId, { installationId: inst.id, host: inst.host, scope: inst.scope, target: inst.targetPath });
    return { id: inst.id, capabilityId: inst.capabilityId, host: inst.host, scope: inst.scope, target: inst.targetPath, state: 'ok', detail: 'restored from the stored version' };
  });
}

/** Returns the host to its state before this installation (restores what it replaced, if anything). */
export const rollback =(sys: Sys, deps: Deps, installationId: string, opts: { force?: boolean } = {}) => removeInstall(sys, deps, installationId, 'rolled_back', opts);
export const uninstall = (sys: Sys, deps: Deps, installationId: string, opts: { force?: boolean } = {}) => removeInstall(sys, deps, installationId, 'uninstalled', opts);

/* ---------- update inspection (never applies anything) ---------- */

export interface UpdateInspection {
  candidateId: string;
  capabilityId: string | null;
  fromRef: string | null;
  toRef: string | null;
  files: { added: string[]; removed: string[]; changed: string[] };
  permissionsAdded: string[];
  newExecutables: string[];
  tier: { from: string; to: string };
  licence: { from: string; to: string };
  critical: number;
  verdict: 'eligible-for-re-evaluation' | 'requires-approval' | 'reject';
  reasons: string[];
}

export async function inspectUpdate(sys: Sys, deps: Deps, candidateId: string): Promise<UpdateInspection> {
  const cand = getCandidate(sys, candidateId);
  if (!cand) throw new AcquisitionError('not-found', `No candidate "${candidateId}"`);
  const toRef = (cand.signals.upstreamRef as string) || null;
  if (!cand.updateAvailable || !toRef) throw new AcquisitionError('invalid', `No upstream update recorded for ${candidateId}`, 'run: synaptome update check');
  const pkg = await deps.connectors.get(cand.sourceId).fetchPackage({ externalId: cand.externalId, repo: cand.repo, ref: toRef, path: cand.path, raw: cand.raw });
  const stage = path.join(sys.paths.quarantine, cand.id, `update-${hashFiles(pkg.files).slice(0, 16)}`);
  if (!fs.existsSync(stage)) writeTree(stage, pkg.files);
  const settings = sys.settings();
  const audit = auditPackage({ kind: cand.kind as any, files: pkg.files, skipped: pkg.skipped, declaredLicence: pkg.license, publisher: cand.publisher, provenanceVerified: pkg.provenance.verified, settings });
  storeAudit(sys, 'update', cand.id, hashFiles(pkg.files), audit);
  const old = new Map(cand.files.map((f) => [f.path, f.sha256]));
  const neu = new Map(pkg.files.map((f) => [f.path, sha256(f.content)]));
  const prevAudit = sys.db.get<any>('SELECT * FROM audits WHERE subject_id=? AND content_hash=? ORDER BY id DESC LIMIT 1', cand.id, cand.contentHash);
  const prevPerms = truePerms(pj(prevAudit?.permissions, {}));
  const prevLic = pj<any>(prevAudit?.license, {}).spdx ?? '';
  const res: UpdateInspection = {
    candidateId, capabilityId: cand.capabilityId, fromRef: cand.ref, toRef,
    files: { added: [...neu.keys()].filter((p) => !old.has(p)), removed: [...old.keys()].filter((p) => !neu.has(p)), changed: [...neu.keys()].filter((p) => old.has(p) && old.get(p) !== neu.get(p)) },
    permissionsAdded: truePerms(audit.permissions).filter((p) => !prevPerms.includes(p)),
    newExecutables: audit.executables.filter((e) => !old.has(e)),
    tier: { from: prevAudit?.tier ?? '?', to: audit.tier },
    licence: { from: prevLic, to: audit.licence.spdx },
    critical: audit.critical,
    verdict: 'eligible-for-re-evaluation',
    reasons: [],
  };
  if (audit.critical) (res.verdict = 'reject'), res.reasons.push(`${audit.critical} critical finding(s) in the new version`);
  if (res.permissionsAdded.length) res.reasons.push(`permission expansion: ${res.permissionsAdded.join(', ')}`);
  if (res.newExecutables.length) res.reasons.push(`new executable file(s): ${res.newExecutables.join(', ')}`);
  if (res.tier.to > res.tier.from) res.reasons.push(`risk tier ${res.tier.from} -> ${res.tier.to}`);
  if (res.licence.from !== res.licence.to) res.reasons.push(`licence changed: ${res.licence.from || 'unknown'} -> ${res.licence.to || 'unknown'}`);
  const moved = cand.signals.publisherChange as { from: { publisher?: string; repo?: string }; to: { publisher?: string; repo?: string } } | undefined;
  if (moved) res.reasons.push(`publisher changed: ${moved.from.repo ?? moved.from.publisher} -> ${moved.to.repo ?? moved.to.publisher}`);
  if (res.verdict !== 'reject' && res.reasons.length) res.verdict = 'requires-approval';
  emit(sys.db, 'update.inspected', cand.id, { verdict: res.verdict, reasons: res.reasons, toRef });
  // Changes a person must see before anything moves: licence, permissions, new code, critical findings.
  if (res.verdict === 'reject' || res.licence.from !== res.licence.to || res.permissionsAdded.length || res.newExecutables.length) {
    notify(sys, {
      level: res.verdict === 'reject' ? 'warning' : 'action',
      kind: 'capability.update-risk',
      subject: cand.capabilityId ?? cand.id,
      title: `${res.verdict === 'reject' ? 'Update rejected' : 'Update needs review'}: ${cand.name}`,
      body: res.reasons.join('; '),
      dedupeKey: `update-risk:${cand.id}:${toRef}`,
    });
  }
  return res;
}

/** Re-runs the whole acquisition pipeline at the new upstream ref. The capability returns to "registered" (unapproved) unless the gate auto-promotes it; the previous snapshot stays in capability_versions. */
export async function applyUpdate(sys: Sys, deps: Deps, candidateId: string): Promise<EvaluationReport> {
  const insp = await inspectUpdate(sys, deps, candidateId);
  if (insp.verdict === 'reject') throw new AcquisitionError('blocked', `Update rejected: ${insp.reasons.join('; ')}`);
  if (insp.capabilityId && getCapability(sys, insp.capabilityId)?.status === 'approved') {
    transitionCapability(sys, insp.capabilityId, 'registered', { reason: `upstream changed (${insp.toRef ?? 'new ref'}); re-audit and re-approval required`, by: 'update' });
  }
  return evaluateCandidate(sys, deps, candidateId, { ref: insp.toRef ?? undefined });
}

/* =====================================================================
 * HOST INVENTORY: index what is already installed (read-only).
 * ===================================================================== */

export async function ingestInventory(sys: Sys, deps: Deps, opts: { limit?: number } = {}) {
  syncSources(sys, deps.connectors);
  const connector = deps.connectors.get('local-claude');
  const report = await scan(sys, connector, { mode: 'broad', limit: 5000, origin: 'cli' });
  const settings = sys.settings();
  const rows = sys.db.all<any>("SELECT id FROM candidates WHERE source_id='local-claude' ORDER BY name LIMIT ?", opts.limit ?? 5000);
  const out = { scanned: report.found, indexed: 0, unchanged: 0, failed: 0, tiers: { A: 0, B: 0, C: 0 } as Record<string, number>, flagged: [] as { id: string; name: string; reasons: string[] }[] };
  for (const { id } of rows) {
    const cand = getCandidate(sys, id)!;
    const known = cand.capabilityId ? getCapability(sys, cand.capabilityId) : null;
    if (known && known.version === cand.upstreamVersion) {
      out.unchanged++;
      out.tiers[known.tier]++;
      continue;
    }
    try {
      const pkg = await connector.fetchPackage({ externalId: cand.externalId });
      const audit = auditPackage({ kind: 'skill', files: pkg.files, skipped: pkg.skipped, publisher: cand.publisher, provenanceVerified: false, settings });
      const contentHash = hashFiles(pkg.files);
      storeAudit(sys, 'inventory', cand.id, contentHash, audit);
      const score = scorePackage({ kind: 'skill', files: pkg.files, audit, provenanceVerified: false, pushedAt: null, hostCompatible: true, settings });
      const origin = String(cand.signals.origin ?? 'personal');
      const fmName = typeof audit.frontmatter.name === 'string' && audit.frontmatter.name ? audit.frontmatter.name : cand.name;
      const capId = cand.capabilityId ?? uniqueId(sys, `${origin.startsWith('plugin:') ? slug(origin.slice(7).split('@')[0]) : 'local'}.${slug(fmName)}`, cand.id);
      const rec = buildRecord(sys, capId, cand, pkg.files, pkg, audit, score, deps);
      rec.installLocations = [cand.externalId];
      rec.platforms = ['claude-code'];
      const entry = pkg.files.find((f) => f.path === audit.entryFile);
      upsertCapability(sys, rec, { status: audit.tier === 'C' ? 'blocked' : 'registered', origin: 'host-inventory', candidateId: cand.id, contentHash, version: cand.upstreamVersion, body: entry?.content ?? '' });
      storeScore(sys, capId, score);
      sys.db.run("UPDATE candidates SET state='registered', capability_id=?, content_hash=?, files=? WHERE id=?", capId, contentHash, j(pkg.files.map((f) => ({ path: f.path, size: f.size, sha256: sha256(f.content) }))), cand.id);
      const instId = `x-${shortHash(cand.externalId, 10)}`;
      sys.db.run("INSERT INTO installations (id, capability_id, host, scope, target_path, version, content_hash, status, verified, verify_detail, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content_hash=excluded.content_hash, updated_at=excluded.updated_at", instId, capId, 'claude-code', 'external', cand.externalId, cand.upstreamVersion, contentHash, 'installed', 0, `pre-existing (${origin}); not managed by Synaptome`, nowIso(), nowIso());
      out.indexed++;
      out.tiers[audit.tier]++;
      if (audit.tier === 'C') out.flagged.push({ id: capId, name: fmName, reasons: audit.findings.filter((f) => f.severity === 'critical').map((f) => `${f.message} (${f.file}:${f.line})`).slice(0, 3) });
    } catch (e: any) {
      out.failed++;
    }
  }
  emit(sys.db, 'inventory.indexed', 'local-claude', { indexed: out.indexed, unchanged: out.unchanged, flagged: out.flagged.length });
  return out;
}
function uniqueId(sys: Sys, base: string, candidateId: string) {
  const hit = getCapability(sys, base);
  return hit && hit.candidateId !== candidateId ? `${base}-${shortHash(candidateId, 4)}` : base;
}

/* ---------- content access for inspection and activation ---------- */

/** Returns the entry file (and file list) of a capability from its snapshot, or from its host location for inventory entries. */
export function readCapabilityEntry(sys: Sys, capabilityId: string): { path: string; content: string; files: string[]; base: string } | null {
  const cap = getCapability(sys, capabilityId);
  if (!cap) return null;
  const entryName = cap.record.entryFile || 'SKILL.md';
  if (cap.snapshotPath) {
    const pkg = snapshotProvider(sys).read(capabilityId);
    const e = pkg?.files.find((f) => f.path === entryName);
    return e && pkg ? { path: e.path, content: e.content, files: pkg.files.map((f) => f.path), base: cap.snapshotPath } : null;
  }
  const dir = cap.record.installLocations[0];
  if (!dir || !fs.existsSync(path.join(dir, entryName))) return null;
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4 || files.length > 200) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
      else files.push(path.relative(dir, path.join(d, e.name)).replace(/\\/g, '/'));
    }
  };
  walk(dir, 0);
  return { path: entryName, content: fs.readFileSync(path.join(dir, entryName), 'utf8'), files, base: dir };
}

export function capabilityDossier(sys: Sys, capabilityId: string) {
  const cap = getCapability(sys, capabilityId);
  if (!cap) return null;
  const audit = latestAudit(sys, cap);
  const score = sys.db.get<any>('SELECT * FROM scores WHERE subject_id=? ORDER BY id DESC LIMIT 1', cap.id);
  return {
    capability: cap,
    audit: audit ? { id: audit.id, tier: audit.tier, trust: audit.trust, summary: audit.summary, licence: audit.license, permissions: audit.permissions, findings: audit.findings, at: audit.created_at } : null,
    score: score ? { total: score.total, dimensions: pj(score.dimensions, {}), unknowns: pj(score.unknowns, []), at: score.created_at } : null,
    gate: latestGate(sys, cap.id),
    installations: sys.db.all<any>('SELECT * FROM installations WHERE capability_id=? ORDER BY created_at DESC', cap.id).map(mapInst),
    versions: sys.db.all<any>('SELECT content_hash, version, ref, created_at FROM capability_versions WHERE capability_id=? ORDER BY created_at DESC', cap.id),
    evals: sys.db.all<any>('SELECT id, suite, runner, status, summary, created_at FROM eval_runs WHERE subject_id=? ORDER BY id DESC LIMIT 10', cap.id).map((e) => ({ ...e, summary: pj(e.summary, {}) })),
    relations: sys.db.all<any>('SELECT src, rel, dst, weight, evidence FROM relations WHERE src=? OR dst=?', cap.id, cap.id),
  };
}
