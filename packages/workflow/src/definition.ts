import { z } from 'zod';
import { PERMISSIONS } from '@synaptome/core';

/**
 * Workflow definitions are data. Nothing in a definition is evaluated as code: values flow between steps only through
 * `${inputs.name}` and `${steps.<id>.output.<path>}` references, conditions are comparisons, and every step states
 * the permissions it needs.
 */
export const STEP_KINDS = ['noop', 'api-call', 'model', 'approval', 'shell', 'agent'] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export type Permission = (typeof PERMISSIONS)[number];
const VALUE_TYPES = ['string', 'number', 'boolean', 'object', 'array'] as const;

const Perm = z.enum(PERMISSIONS);
export const StepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, 'step ids are lowercase letters, digits and hyphens'),
  title: z.string().optional(),
  kind: z.enum(STEP_KINDS),
  needs: z.array(z.string()).default([]),
  with: z.record(z.string(), z.unknown()).default({}),
  when: z.object({ path: z.string(), equals: z.unknown().optional(), notEquals: z.unknown().optional(), in: z.array(z.unknown()).optional() }).optional(),
  /** Output contract, checked after every successful attempt. */
  output: z.object({ required: z.array(z.string()).default([]), types: z.record(z.string(), z.enum(VALUE_TYPES)).default({}) }).optional(),
  permissions: z.array(Perm).default([]),
  retry: z.object({ max: z.number().int().min(0).max(10), backoffMs: z.number().int().min(0).max(600_000).default(1000) }).optional(),
  timeoutMs: z.number().int().positive().max(24 * 3_600_000).optional(),
  /** What a resumed run does with this step if the process died while it was running. */
  onInterrupt: z.enum(['retry', 'fail']).default('retry'),
  continueOnError: z.boolean().default(false),
  /** By default a step is skipped when a step it needs was skipped; "run" treats a skipped need as satisfied. */
  ifNeedsSkipped: z.enum(['skip', 'run']).default('skip'),
});
export const WorkflowSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]{0,80}$/),
  version: z.string().default('1'),
  title: z.string().min(1),
  description: z.string().default(''),
  inputs: z.record(z.string(), z.object({ type: z.enum(VALUE_TYPES), required: z.boolean().default(true), description: z.string().default(''), default: z.unknown().optional() })).default({}),
  /** The most a run of this workflow can be granted; every step's permissions must be among them. */
  permissions: z.array(Perm).default([]),
  /** Limits for the whole run, enforced by runners that spend them (agent steps): tokens, US dollars (when prices are known), wall time. */
  budget: z.object({ tokens: z.number().int().positive().optional(), usd: z.number().positive().optional(), ms: z.number().int().positive().optional() }).optional(),
  steps: z.array(StepSchema).min(1),
});
export type WorkflowDefinition = z.infer<typeof WorkflowSchema>;
export type StepDefinition = z.infer<typeof StepSchema>;

const REF = /\$\{([^}]+)\}/g;
const refsIn = (v: unknown): string[] => [...JSON.stringify(v ?? null).matchAll(REF)].map((m) => m[1].trim());

/** Every step a step depends on, directly or not. */
export function ancestors(def: WorkflowDefinition, stepId: string): Set<string> {
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const out = new Set<string>();
  const visit = (id: string) => {
    for (const n of byId.get(id)?.needs ?? []) {
      if (out.has(n)) continue;
      out.add(n);
      visit(n);
    }
  };
  visit(stepId);
  return out;
}

/** Steps in an order where every step comes after the steps it needs; throws on a cycle. */
export function topoOrder(def: Pick<WorkflowDefinition, 'steps'>): string[] {
  const indeg = new Map(def.steps.map((s) => [s.id, s.needs.length]));
  const order: string[] = [];
  const ready = def.steps.filter((s) => !s.needs.length).map((s) => s.id);
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const s of def.steps) {
      if (!s.needs.includes(id)) continue;
      indeg.set(s.id, indeg.get(s.id)! - 1);
      if (indeg.get(s.id) === 0) ready.push(s.id);
    }
  }
  if (order.length !== def.steps.length) throw new Error(`steps form a cycle: ${def.steps.filter((s) => !order.includes(s.id)).map((s) => s.id).join(', ')}`);
  return order;
}

export function validateWorkflow(raw: unknown): { ok: true; def: WorkflowDefinition } | { ok: false; errors: string[] } {
  const parsed = WorkflowSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'workflow'}: ${i.message}`) };
  const def = parsed.data;
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const s of def.steps) {
    if (ids.has(s.id)) errors.push(`step "${s.id}" is defined twice`);
    ids.add(s.id);
  }
  for (const s of def.steps) {
    for (const n of s.needs) if (!ids.has(n)) errors.push(`step "${s.id}" needs unknown step "${n}"`);
    for (const p of s.permissions) if (!def.permissions.includes(p)) errors.push(`step "${s.id}" asks for "${p}", which the workflow does not declare`);
    if (s.kind === 'shell' && !s.permissions.includes('shell')) errors.push(`step "${s.id}" runs a command but does not declare the "shell" permission`);
    if ((s.kind === 'agent' || s.kind === 'model') && !s.permissions.includes('api')) errors.push(`step "${s.id}" calls a model but does not declare the "api" permission`);
  }
  if (errors.length) return { ok: false, errors };
  try {
    topoOrder(def);
  } catch (e: any) {
    return { ok: false, errors: [e.message] };
  }
  for (const s of def.steps) {
    const up = ancestors(def, s.id);
    for (const ref of [...refsIn(s.with), ...(s.when ? [s.when.path] : [])]) {
      const [root, name] = ref.split('.');
      if (root === 'inputs') {
        if (!(name in def.inputs)) errors.push(`step "${s.id}" refers to undeclared input "${name}"`);
      } else if (root === 'steps') {
        if (!up.has(name)) errors.push(`step "${s.id}" refers to step "${name}", which it does not (directly or indirectly) need`);
      } else errors.push(`step "${s.id}" has an unknown reference "\${${ref}}" (only inputs.* and steps.* exist)`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, def };
}

const typeOf = (v: unknown) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

export function validateInputs(def: WorkflowDefinition, given: Record<string, unknown> = {}): { values: Record<string, unknown>; errors: string[] } {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const [name, spec] of Object.entries(def.inputs)) {
    const v = given[name] ?? spec.default;
    if (v === undefined) {
      if (spec.required) errors.push(`input "${name}" is required`);
      continue;
    }
    if (typeOf(v) !== spec.type) errors.push(`input "${name}" must be ${spec.type}, got ${typeOf(v)}`);
    values[name] = v;
  }
  for (const k of Object.keys(given)) if (!(k in def.inputs)) errors.push(`unknown input "${k}"`);
  return { values, errors };
}

export interface Scope {
  inputs: Record<string, unknown>;
  steps: Record<string, { output: unknown; status: string }>;
}

export function lookup(scope: Scope, ref: string): unknown {
  let cur: any = scope;
  for (const part of ref.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Replaces references. A string that is exactly one reference takes the referenced value as is (any type). */
export function resolveTemplates(value: unknown, scope: Scope): unknown {
  if (typeof value === 'string') {
    const whole = value.match(/^\$\{([^}]+)\}$/);
    if (whole) return lookup(scope, whole[1].trim());
    return value.replace(REF, (_, ref) => {
      const v = lookup(scope, String(ref).trim());
      return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, scope));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplates(v, scope)]));
  return value;
}

export function evalWhen(when: NonNullable<StepDefinition['when']>, scope: Scope): boolean {
  const v = lookup(scope, when.path);
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (when.equals !== undefined && !eq(v, when.equals)) return false;
  if (when.notEquals !== undefined && eq(v, when.notEquals)) return false;
  if (when.in && !when.in.some((x) => eq(v, x))) return false;
  return true;
}

export function checkContract(output: unknown, contract: StepDefinition['output']): string[] {
  if (!contract) return [];
  if ((contract.required.length || Object.keys(contract.types).length) && typeOf(output) !== 'object') return [`output must be an object, got ${typeOf(output)}`];
  const errors: string[] = [];
  const o = output as Record<string, unknown>;
  for (const k of contract.required) if (o[k] === undefined) errors.push(`output is missing "${k}"`);
  for (const [k, t] of Object.entries(contract.types)) if (o[k] !== undefined && typeOf(o[k]) !== t) errors.push(`output "${k}" must be ${t}, got ${typeOf(o[k])}`);
  return errors;
}
