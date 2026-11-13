import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CapabilityRow, Settings } from '@synaptome/core';

/* =====================================================================
 * Policy rules as data. They can tighten the built-in promotion gate, never loosen it.
 * ===================================================================== */

export type PolicyRule = Settings['policy']['rules'][number];
export interface RuleMatch {
  rule: PolicyRule | null;
  effect: 'deny' | 'require-approval' | 'allow-auto';
  explanation: string;
}

const list = (v: string | string[] | undefined) => (v == null ? [] : Array.isArray(v) ? v : [v]).map((x) => String(x).toLowerCase());

/** Facts a rule can match on, taken from the registry record. */
export function policyFacts(cap: CapabilityRow, source: string | null) {
  const perms = Object.entries(cap.record.permissions ?? {}).filter(([, v]) => v).map(([k]) => k);
  return {
    kind: cap.kind,
    tier: cap.tier,
    trust: cap.trust,
    licence: cap.record.license?.spdx || 'unknown',
    permission: perms,
    publisher: cap.record.publisher || cap.publisher || '',
    source: source ?? '',
    origin: cap.origin,
    name: cap.name,
  };
}

export function ruleMatches(rule: PolicyRule, facts: ReturnType<typeof policyFacts>): boolean {
  const w = rule.when ?? {};
  for (const [key, raw] of Object.entries(w)) {
    const want = list(raw as any);
    if (!want.length) continue;
    if (key === 'namePattern') {
      if (!want.some((p) => safeRegex(p)?.test(facts.name))) return false;
    } else if (key === 'permission') {
      if (!facts.permission.some((p) => want.includes(p.toLowerCase()))) return false;
    } else if (key in facts) {
      if (!want.includes(String((facts as any)[key]).toLowerCase())) return false;
    } else return false; // an unknown field never matches: a typo must not widen a rule
  }
  return true;
}

export function decideByRules(settings: Settings, facts: ReturnType<typeof policyFacts>): RuleMatch {
  for (const rule of settings.policy.rules ?? []) {
    if (ruleMatches(rule, facts)) return { rule, effect: rule.effect, explanation: `rule "${rule.id}" (${rule.effect})${rule.reason ? `: ${rule.reason}` : ''}` };
  }
  const d = settings.policy.defaultEffect ?? 'allow-auto';
  return { rule: null, effect: d, explanation: `no rule matched; default ${d}` };
}

/** Validates rules before they are saved: known fields, known effects, unique ids, valid patterns. */
export function validateRules(rules: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(rules)) return ['rules must be a list'];
  const ids = new Set<string>();
  const fields = new Set(['kind', 'tier', 'trust', 'licence', 'permission', 'publisher', 'source', 'origin', 'namePattern']);
  rules.forEach((r: any, i) => {
    const at = `rule ${i + 1}${r?.id ? ` (${r.id})` : ''}`;
    if (!r || typeof r !== 'object') return void errors.push(`${at}: not an object`);
    if (typeof r.id !== 'string' || !r.id) errors.push(`${at}: id is required`);
    else if (ids.has(r.id)) errors.push(`${at}: duplicate id`);
    else ids.add(r.id);
    if (!['deny', 'require-approval', 'allow-auto'].includes(r.effect)) errors.push(`${at}: effect must be deny, require-approval or allow-auto`);
    if (!r.when || typeof r.when !== 'object' || !Object.keys(r.when).length) errors.push(`${at}: "when" must name at least one field`);
    for (const k of Object.keys(r.when ?? {})) if (!fields.has(k)) errors.push(`${at}: unknown field "${k}"`);
    if (r.when?.namePattern) for (const p of list(r.when.namePattern)) if (!safeRegex(p)) errors.push(`${at}: namePattern "${p}" is not a valid regular expression`);
  });
  return errors;
}

function safeRegex(p: string): RegExp | null {
  try {
    return new RegExp(p, 'i');
  } catch {
    return null;
  }
}

/* =====================================================================
 * Isolation. Static analysis is the default for untrusted content. Executable content may be tested dynamically only
 * inside a strong boundary (a VM-backed sandbox or a container with no network and no host mounts). The Node.js
 * permission model, a child process or a stripped environment are never treated as isolation.
 * ===================================================================== */

export interface IsolationStatus {
  available: { id: 'windows-sandbox' | 'docker' | 'podman'; detail: string }[];
  /** Whether Synaptome can run a dynamic test inside one of them today. */
  dynamicTestsImplemented: boolean;
  checkedAt: string;
}

let cached: IsolationStatus | null = null;

/** Looks for isolation that is strong enough. Cached per process; `fresh` re-probes. Never runs untrusted code. */
export function probeIsolation(opts: { fresh?: boolean; run?: typeof spawnSync; exists?: (p: string) => boolean } = {}): IsolationStatus {
  if (cached && !opts.fresh && !opts.run) return cached;
  const run = opts.run ?? spawnSync;
  const exists = opts.exists ?? fs.existsSync;
  const available: IsolationStatus['available'] = [];
  if (process.platform === 'win32') {
    const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsSandbox.exe');
    if (exists(exe)) available.push({ id: 'windows-sandbox', detail: `${exe} is present (feature enabled)` });
  }
  for (const id of ['docker', 'podman'] as const) {
    const r = run(id, ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.status === 0 && String(r.stdout).trim()) available.push({ id, detail: `${id} server ${String(r.stdout).trim()}` });
  }
  const status = { available, dynamicTestsImplemented: false, checkedAt: new Date().toISOString() };
  if (!opts.run) cached = status;
  return status;
}

/** The gate check for packages that contain executable content. It is never a pass until a dynamic test has run. */
export function dynamicTestCheck(hasExecutableContent: boolean, iso: IsolationStatus) {
  if (!hasExecutableContent) return { result: 'pass' as const, evidence: 'no executable content; static analysis covers it' };
  const where = iso.available.map((a) => a.id).join(', ');
  if (!iso.available.length) return { result: 'unknown' as const, evidence: 'BLOCKED: executable content needs a dynamic test inside strong isolation, and no Windows Sandbox, Docker or Podman is available' };
  if (!iso.dynamicTestsImplemented) return { result: 'unknown' as const, evidence: `not run: isolation is available (${where}) but dynamic tests are not implemented yet; a person must review the code` };
  return { result: 'unknown' as const, evidence: `pending: run the dynamic test in ${where}` };
}
