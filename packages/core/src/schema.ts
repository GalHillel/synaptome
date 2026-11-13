import { z } from 'zod';

export const SCHEMA_VERSION = 1;

export const KINDS = [
  'skill', 'agent', 'subagent', 'mcp-server', 'tool', 'hook', 'workflow', 'plugin', 'extension',
  'prompt', 'template', 'knowledge', 'model', 'memory-provider', 'eval-suite', 'connector',
] as const;
export type Kind = (typeof KINDS)[number];

export const TRUST = ['OFFICIAL_VERIFIED', 'VERIFIED_PUBLISHER', 'REVIEWED_COMMUNITY', 'EXPERIMENTAL', 'UNKNOWN', 'QUARANTINED', 'BLOCKED'] as const;
export type Trust = (typeof TRUST)[number];

/** A = declarative, auto-eligible. B = executable/network, needs approval. C = high risk, blocked. */
export const TIERS = ['A', 'B', 'C'] as const;
export type Tier = (typeof TIERS)[number];

/** Discovery + acquisition states of a candidate. */
export const CANDIDATE_STATES = ['discovered', 'queued', 'quarantined', 'audited', 'registered', 'rejected', 'blocked'] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];

/** Registry status of a canonical capability. Approved is NOT installed; installed is NOT activated. */
export const CAPABILITY_STATUS = ['registered', 'approved', 'rejected', 'blocked', 'deprecated'] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUS)[number];

export const ADAPTER_STATUS = ['VERIFIED', 'PARTIALLY_VERIFIED', 'EXPERIMENTAL', 'UNSUPPORTED'] as const;
export type AdapterStatus = (typeof ADAPTER_STATUS)[number];

export const PERMISSIONS = ['read', 'write', 'delete', 'shell', 'network', 'browser', 'credentials', 'installation', 'configuration', 'publishing', 'api'] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type PermissionSet = Record<Permission, boolean>;
export const noPermissions = (): PermissionSet => Object.fromEntries(PERMISSIONS.map((p) => [p, false])) as PermissionSet;

const strs = z.array(z.string()).default([]);

/** Unified capability metadata (spec §5.2). Versioned via schemaVersion; unknown keys are preserved. */
export const CapabilityRecord = z
  .object({
    id: z.string(),
    schemaVersion: z.number().default(SCHEMA_VERSION),
    name: z.string(),
    description: z.string().default(''),
    kind: z.enum(KINDS),
    domain: z.string().default('general'),
    category: z.string().default(''),
    tags: strs,
    supportedTasks: strs,
    activation: strs,
    exclusion: strs,
    inputs: strs,
    outputs: strs,
    platforms: strs,
    dependencies: strs,
    permissions: z.record(z.string(), z.boolean()).default(noPermissions()),
    networkRequired: z.boolean().default(false),
    filesystemRequired: z.boolean().default(false),
    executables: strs,
    publisher: z.string().default(''),
    repository: z.string().default(''),
    release: z.string().default(''),
    commit: z.string().default(''),
    license: z
      .object({ spdx: z.string().default(''), evidence: z.string().default(''), compatible: z.enum(['yes', 'no', 'unknown']).default('unknown') })
      .prefault({}),
    provenance: z
      .object({
        sourceId: z.string().default(''),
        url: z.string().default(''),
        fetchedAt: z.string().default(''),
        verified: z.boolean().default(false),
        method: z.string().default(''),
      })
      .prefault({}),
    verification: z.enum(['verified', 'partial', 'unverified']).default('unverified'),
    security: z
      .object({ tier: z.enum(TIERS).default('C'), trust: z.enum(TRUST).default('UNKNOWN'), critical: z.number().default(0), findings: z.number().default(0) })
      .prefault({}),
    quality: z
      .object({ total: z.number().nullable().default(null), dimensions: z.record(z.string(), z.any()).default({}), unknowns: strs })
      .prefault({}),
    contextCost: z.number().default(0),
    benchmarks: z.array(z.any()).default([]),
    weaknesses: strs,
    conflicts: strs,
    alternatives: strs,
    installLocations: strs,
    updateStatus: z.enum(['current', 'update-available', 'unknown']).default('unknown'),
    lastAuditAt: z.string().default(''),
    entryFile: z.string().default(''),
    fileCount: z.number().default(0),
  })
  .passthrough();
export type CapabilityRecord = z.infer<typeof CapabilityRecord>;

/* =====================================================================
 * Extension interfaces. Each one has at least one real implementation
 * and test in this repository; see docs/ARCHITECTURE.md.
 * ===================================================================== */

export interface RateState {
  limit?: number;
  remaining?: number;
  resetAt?: string;
  note?: string;
}

export interface CandidateDraft {
  externalId: string;
  kind: Kind;
  name: string;
  description: string;
  url?: string;
  repo?: string;
  ref?: string;
  path?: string;
  publisher?: string;
  licenseSpdx?: string;
  licenseEvidence?: string;
  stars?: number;
  pushedAt?: string;
  topics?: string[];
  upstreamVersion?: string;
  signals?: Record<string, string | number | boolean>;
  raw?: unknown;
}

export interface FetchedFile {
  path: string;
  content: string;
  size: number;
  binary?: boolean;
}
export interface FetchedPackage {
  files: FetchedFile[];
  ref?: string;
  license?: { spdx?: string; evidence?: string };
  skipped: { path: string; reason: string }[];
  provenance: { url: string; method: string; verified: boolean };
}

export interface SearchRequest {
  mode: 'broad' | 'incremental' | 'need';
  query?: string;
  limit: number;
  cursor?: any;
}
export interface SearchResult {
  drafts: CandidateDraft[];
  cursor?: any;
  rate?: RateState;
  notes?: string[];
  /** HTTP requests this search made, when the connector counts them; used for request budgets. */
  requests?: number;
  /** Set when the search stopped before it was done (e.g. a rate limit); the reason. The scan is then reported as partial. */
  stoppedEarly?: string;
}

/** Whether a source's terms of use and robots.txt allow automated access, and on what basis. */
export interface SourceTerms {
  allowed: boolean;
  basis: string;
  checkedAt?: string;
}

/** A discovery source. Registered in the connector registry; core never imports a concrete connector. */
export interface DiscoveryConnector {
  id: string;
  kind: string;
  title: string;
  description: string;
  official: boolean;
  /** Declared access policy. A source whose terms disallow automated access is never queried. */
  terms?: SourceTerms;
  health(): Promise<{ ok: boolean; detail: string; authenticated: boolean; rate?: RateState }>;
  search(req: SearchRequest): Promise<SearchResult>;
  fetchPackage(c: { externalId: string; repo?: string | null; ref?: string | null; path?: string | null; raw?: any }): Promise<FetchedPackage>;
  /** `publisher` and `repo` report who holds the upstream now, so a transfer to a new owner is noticed even when content did not change. */
  checkUpdate?(c: { externalId: string; repo?: string | null; ref?: string | null; path?: string | null; upstreamVersion?: string | null; raw?: any }): Promise<{ changed: boolean; ref?: string; version?: string; detail?: string; publisher?: string; repo?: string }>;
}

/** Provides package contents for a canonical capability (snapshot store, forge output, ...). */
export interface CapabilityProvider {
  id: string;
  read(capabilityId: string): { files: FetchedFile[]; contentHash: string } | null;
}

export interface HostDetection {
  present: boolean;
  detail: string;
  root?: string;
  version?: string;
}
/**
 * Operations on one install target, whatever its shape: a directory (skills), a single file with a sidecar
 * marker (agents, commands) or one entry inside a shared configuration file (MCP servers).
 * The install lifecycle (lock, backup, verify, fingerprint, rollback) is written against these only.
 */
export interface TargetOps {
  exists(target: string): boolean;
  /** Capability id that Synaptome recorded as owner of this target; null when Synaptome did not install it. */
  owner(target: string): string | null;
  /** Fingerprint of everything that belongs to the target, Synaptome's own records included; null when absent. */
  fingerprint(target: string): string | null;
  /** Hash of the capability files as installed, comparable to the snapshot content hash; null when not comparable. */
  payloadHash(target: string): string | null;
  /** Copies the target's current state into `dir` (which does not exist yet). */
  backup(target: string, dir: string): void;
  /** Makes the target exactly what `backup` captured. */
  restore(dir: string, target: string): void;
  /** Removes whatever is at the target without an ownership check. Used only for what a failed attempt just wrote. */
  discard(target: string): void;
}

/** Translates a canonical capability into a host's native form. */
export interface HostAdapter {
  id: string;
  title: string;
  status: AdapterStatus;
  statusEvidence: string;
  supportedKinds: Kind[];
  detect(): HostDetection;
  /** Absolute location the capability would occupy for this scope (a directory, a file, or "file#entry"). */
  targetFor(cap: { id: string; name: string; kind: Kind }, scope: 'sandbox' | 'real', sandboxRoot: string): string;
  materialize(cap: CapabilityRecord, files: FetchedFile[], target: string): void;
  verify(cap: CapabilityRecord, target: string): { ok: boolean; detail: string };
  remove(target: string): void;
  ops: TargetOps;
  /** A reason the capability cannot be placed at this target (host-level conflict or unusable package), else null. */
  preflight?(cap: CapabilityRecord, files: FetchedFile[], target: string): string | null;
}

export interface TaskAnalysis {
  task: string;
  terms: string[];
  domains: { id: string; score: number; matched: string[] }[];
  complexity: 'trivial' | 'small' | 'medium' | 'large';
  sensitivity: 'normal' | 'elevated';
  stages: string[];
  /** Set by strategies that gate on intent: why a prompt was or was not treated as a task. */
  intent?: { kind: string; reason: string };
}
export interface RouteSelection {
  capabilityId: string;
  name: string;
  kind: Kind;
  role: string;
  score: number;
  reasons: string[];
  installed: boolean;
  /** 0..1. Present for strategies that compute it; selections below the configured floor are never returned. */
  confidence?: number;
  /** The task terms that justified the selection. */
  evidence?: string[];
}
export interface RouteDecision {
  id?: number;
  task: string;
  strategy: string;
  analysis: TaskAnalysis;
  selected: RouteSelection[];
  excluded: { capabilityId: string; name: string; reason: string }[];
  gaps: { domain: string; term: string; reason: string }[];
  plan: { step: number; stage: string; capabilityIds: string[]; verify: string }[];
  /** Cost of the decision: routing time, candidates considered, and what a host was sent. */
  metrics?: { ms: number; candidates: number; qualified: number; injectedTokens?: number; injectedBytes?: number; offered?: string[]; hookMs?: number };
}
export interface RoutingStrategy {
  id: string;
  route(task: string, opts?: { host?: string; max?: number }): RouteDecision;
}

/** Turns a routing decision into work. Only a plan-only executor exists in milestone 1. */
export interface WorkflowExecutor {
  id: string;
  execute(decision: RouteDecision): Promise<{ status: 'planned' | 'completed' | 'failed'; trace: unknown[] }>;
}

export interface ModelProvider {
  id: string;
  title: string;
  availability(): Promise<{ available: boolean; authenticated: boolean; detail: string }>;
  complete(req: { prompt: string; system?: string; cwd?: string; timeoutMs?: number; extraArgs?: string[]; maxTokens?: number }): Promise<{ ok: boolean; text: string; error?: string; raw?: unknown; ms: number; usage?: { inputTokens: number; outputTokens: number } }>;
}

export interface EvalCase {
  id: string;
  prompt: string;
  /** Deterministic graders: every `must` regex has to match, no `mustNot` regex may match. */
  must: string[];
  mustNot?: string[];
}
export interface EvalCaseResult {
  caseId: string;
  variant: string;
  passed: boolean;
  detail: string;
  ms?: number;
}
export interface EvaluationRunner {
  id: string;
  run(input: { cases: EvalCase[]; variants: { id: string; system?: string }[] }): Promise<{ status: 'completed' | 'blocked'; blocker?: string; results: EvalCaseResult[] }>;
}

export interface GateCheck {
  id: string;
  label: string;
  /** 'unknown' never counts as a pass. */
  result: 'pass' | 'fail' | 'unknown';
  evidence: string;
}
export interface PermissionPolicy {
  id: string;
  evaluate(capabilityId: string, host: string): { checks: GateCheck[]; passed: boolean; decision: 'auto-promote' | 'needs-approval' | 'blocked' };
}
