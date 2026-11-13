import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEGACY, PRODUCT, env } from './identity';

/* ---------- small shared helpers ---------- */

export const nowIso = () => new Date().toISOString();
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const shortHash = (s: string, n = 10) => sha256(s).slice(0, n);
export const j = (v: unknown) => JSON.stringify(v ?? null);
export function pj<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || s === '') return fallback;
  try {
    const v = JSON.parse(s);
    return v === null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unnamed';

/* ---------- home and paths ---------- */

export interface Paths {
  home: string;
  db: string;
  store: string; // canonical immutable snapshots
  quarantine: string; // untrusted downloads
  sandboxHosts: string; // staged host directories used before any real install
  forge: string; // forge drafts
  backups: string;
  cache: string;
}

export function resolveHome(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const fromEnv = env('HOME');
  if (fromEnv) return path.resolve(fromEnv);
  return defaultHome(PRODUCT.dataDir);
}

/** Platform default data directory for a given product directory name. */
export function defaultHome(dataDir: string): string {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, dataDir);
  return path.join(os.homedir(), `.${dataDir}`);
}

/** True when the directory holds data written under the previous product name and has not been migrated. */
export function isLegacyHome(home: string): boolean {
  return fs.existsSync(path.join(home, LEGACY.dbFile)) && !fs.existsSync(path.join(home, PRODUCT.dbFile));
}

export function pathsFor(home: string): Paths {
  return {
    home,
    db: path.join(home, PRODUCT.dbFile),
    store: path.join(home, 'store'),
    quarantine: path.join(home, 'quarantine'),
    sandboxHosts: path.join(home, 'sandbox-hosts'),
    forge: path.join(home, 'forge'),
    backups: path.join(home, 'backups'),
    cache: path.join(home, 'cache'),
  };
}

/* ---------- database ---------- */

type P = string | number | bigint | null | Uint8Array;
const norm = (v: unknown): P => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v as P;
};

export class Db {
  raw: DatabaseSync;
  constructor(public file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  }
  run(sql: string, ...params: unknown[]) {
    return this.raw.prepare(sql).run(...params.map(norm));
  }
  get<T = any>(sql: string, ...params: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...params.map(norm)) as T | undefined;
  }
  all<T = any>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...params.map(norm)) as T[];
  }
  /** Runs `fn` in one transaction. Nested calls join the outer transaction instead of failing. */
  tx<T>(fn: () => T): T {
    if (this.raw.isTransaction) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }
  close() {
    this.raw.close();
  }
}

interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Index words for a capability's tags column, rebuilt from its stored record: tags, domain, category, kind, supported tasks and trigger statements. */
const FTS_TAGS_FROM_RECORD = `trim(
  coalesce((SELECT group_concat(value, ' ') FROM json_each(c.record, '$.tags')), '') || ' ' ||
  coalesce(c.domain, '') || ' ' || coalesce(c.category, '') || ' ' || c.kind || ' ' ||
  coalesce((SELECT group_concat(value, ' ') FROM json_each(c.record, '$.supportedTasks')), '') || ' ' ||
  coalesce((SELECT group_concat(value, ' ') FROM json_each(c.record, '$.activation') WHERE lower(ltrim(value)) NOT LIKE 'requires:%' AND lower(ltrim(value)) NOT LIKE 'never:%'), '')
)`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial lifecycle schema',
    sql: `
-- DISCOVERY -------------------------------------------------------------
CREATE TABLE sources (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, official INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1, cursor TEXT, health TEXT NOT NULL DEFAULT 'unknown',
  health_detail TEXT, rate TEXT, last_scan_at TEXT, last_ok_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, mode TEXT NOT NULL, query TEXT,
  origin TEXT NOT NULL DEFAULT 'cli', started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
  found INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0, error TEXT, notes TEXT, rate TEXT
);
CREATE TABLE candidates (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL, kind TEXT NOT NULL,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', url TEXT, repo TEXT, ref TEXT, path TEXT,
  publisher TEXT, license_spdx TEXT, license_evidence TEXT, stars INTEGER, pushed_at TEXT, topics TEXT,
  upstream_version TEXT, signals TEXT, raw TEXT,
  state TEXT NOT NULL DEFAULT 'discovered', rank REAL NOT NULL DEFAULT 0, rank_reasons TEXT,
  recommended_action TEXT, files TEXT, content_hash TEXT, norm_hash TEXT, quarantine_path TEXT,
  duplicate_of TEXT, overlap TEXT, capability_id TEXT, update_available INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, first_scan_id INTEGER, last_scan_id INTEGER,
  UNIQUE (source_id, external_id)
);
CREATE INDEX candidates_state ON candidates(state);
CREATE INDEX candidates_hash ON candidates(content_hash);

-- ACQUISITION -----------------------------------------------------------
CREATE TABLE audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
  content_hash TEXT, tier TEXT NOT NULL, trust TEXT NOT NULL, license TEXT, findings TEXT NOT NULL,
  permissions TEXT, summary TEXT, critical INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX audits_subject ON audits(subject_id);
CREATE TABLE scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT, subject_id TEXT NOT NULL, total REAL, dimensions TEXT NOT NULL,
  unknowns TEXT NOT NULL, weights TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX scores_subject ON scores(subject_id);
CREATE TABLE capabilities (
  id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
  kind TEXT NOT NULL, domain TEXT, category TEXT, tags TEXT, publisher TEXT, origin TEXT NOT NULL DEFAULT 'discovered',
  status TEXT NOT NULL DEFAULT 'registered', trust TEXT NOT NULL DEFAULT 'UNKNOWN', tier TEXT NOT NULL DEFAULT 'C',
  quality REAL, context_cost INTEGER, version TEXT, content_hash TEXT, snapshot_path TEXT, candidate_id TEXT,
  record TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE capabilities_fts USING fts5(id UNINDEXED, name, description, tags, body, tokenize='porter unicode61');
CREATE TABLE capability_versions (
  capability_id TEXT NOT NULL, content_hash TEXT NOT NULL, version TEXT, snapshot_path TEXT NOT NULL,
  ref TEXT, created_at TEXT NOT NULL, PRIMARY KEY (capability_id, content_hash)
);
CREATE TABLE gate_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT, capability_id TEXT NOT NULL, host TEXT, checks TEXT NOT NULL,
  passed INTEGER NOT NULL, decision TEXT NOT NULL, decided_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE relations (
  src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1, evidence TEXT,
  created_at TEXT NOT NULL, PRIMARY KEY (src, rel, dst)
);

-- INSTALLATION ----------------------------------------------------------
CREATE TABLE installations (
  id TEXT PRIMARY KEY, capability_id TEXT NOT NULL, host TEXT NOT NULL, scope TEXT NOT NULL,
  target_path TEXT NOT NULL, version TEXT, content_hash TEXT NOT NULL, status TEXT NOT NULL,
  previous_id TEXT, backup_path TEXT, verified INTEGER NOT NULL DEFAULT 0, verify_detail TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- ACTIVATION ------------------------------------------------------------
CREATE TABLE route_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, origin TEXT NOT NULL, strategy TEXT NOT NULL,
  analysis TEXT NOT NULL, selected TEXT NOT NULL, excluded TEXT NOT NULL, gaps TEXT NOT NULL,
  plan TEXT, created_at TEXT NOT NULL
);
CREATE TABLE activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id INTEGER, capability_id TEXT NOT NULL, host TEXT NOT NULL,
  reason TEXT, served_bytes INTEGER, served_at TEXT NOT NULL, outcome TEXT, outcome_detail TEXT, outcome_at TEXT
);

-- FORGE / EVALUATION ----------------------------------------------------
CREATE TABLE gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT NOT NULL UNIQUE, domain TEXT, hits INTEGER NOT NULL DEFAULT 1,
  sample_task TEXT, status TEXT NOT NULL DEFAULT 'open', first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
);
CREATE TABLE forge_candidates (
  id TEXT PRIMARY KEY, gap TEXT, name TEXT NOT NULL, state TEXT NOT NULL, path TEXT NOT NULL,
  record TEXT NOT NULL, decision TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE eval_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, subject_id TEXT NOT NULL, suite TEXT NOT NULL, runner TEXT NOT NULL,
  status TEXT NOT NULL, results TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL
);

-- SYSTEM ----------------------------------------------------------------
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, type TEXT NOT NULL, subject TEXT, origin TEXT, payload TEXT
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
`,
  },
  {
    version: 2,
    name: 'lifecycle transitions, dependencies, source health and budgets, notifications, trigger statements indexed',
    sql: `
-- Every capability status change, with its reason and actor (enforced by packages/core/src/lifecycle.ts).
CREATE TABLE capability_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, capability_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
  reason TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX capability_transitions_cap ON capability_transitions (capability_id, id);
INSERT INTO capability_transitions (capability_id, from_status, to_status, reason, actor, at)
  SELECT id, NULL, status, 'state at schema v2 (history before this point is in the events table)', 'migration', updated_at FROM capabilities;

-- What a capability needs: another capability, a package, a tool on PATH, or a runtime.
CREATE TABLE dependencies (
  capability_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('capability','package','tool','runtime','service')),
  name TEXT NOT NULL, spec TEXT, required INTEGER NOT NULL DEFAULT 1, evidence TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (capability_id, kind, name)
);

-- Source health history, failure backoff and request budgets.
ALTER TABLE sources ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN backoff_until TEXT;
ALTER TABLE sources ADD COLUMN budget TEXT;
ALTER TABLE sources ADD COLUMN terms TEXT;
CREATE TABLE source_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, at TEXT NOT NULL, ok INTEGER NOT NULL,
  detail TEXT, latency_ms INTEGER, requests INTEGER
);
CREATE INDEX source_checks_source ON source_checks (source_id, id);

-- Things a person should look at: updates, licence or publisher changes, failing sources, new gaps.
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, level TEXT NOT NULL CHECK (level IN ('info','notice','warning','action')),
  kind TEXT NOT NULL, subject TEXT, title TEXT NOT NULL, body TEXT, dedupe_key TEXT UNIQUE, read_at TEXT
);

-- (v3 adds indexes; see below)
-- Trigger statements become searchable for capabilities registered before they were indexed.
UPDATE capabilities_fts SET tags = (SELECT ${FTS_TAGS_FROM_RECORD} FROM capabilities c WHERE c.id = capabilities_fts.id)
  WHERE id IN (SELECT id FROM capabilities);
`,
  },
  {
    version: 3,
    name: 'indexes for registry filters, sorting and installation lookups at scale',
    sql: `
CREATE INDEX IF NOT EXISTS capabilities_status_quality ON capabilities (status, quality DESC);
CREATE INDEX IF NOT EXISTS capabilities_quality ON capabilities (quality DESC);
CREATE INDEX IF NOT EXISTS capabilities_name_nocase ON capabilities (name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS capabilities_updated ON capabilities (updated_at DESC);
CREATE INDEX IF NOT EXISTS capabilities_kind ON capabilities (kind);
CREATE INDEX IF NOT EXISTS capabilities_domain ON capabilities (domain);
CREATE INDEX IF NOT EXISTS capabilities_origin_status ON capabilities (origin, status);
CREATE INDEX IF NOT EXISTS capabilities_candidate ON capabilities (candidate_id);
CREATE INDEX IF NOT EXISTS installations_capability ON installations (capability_id, status);
CREATE INDEX IF NOT EXISTS candidates_source ON candidates (source_id);
CREATE INDEX IF NOT EXISTS activations_capability ON activations (capability_id);
CREATE INDEX IF NOT EXISTS events_type ON events (type, id);
CREATE INDEX IF NOT EXISTS scan_runs_source_mode ON scan_runs (source_id, mode, started_at);
`,
  },
  {
    version: 4,
    name: 'installed tree fingerprint, so rollback and uninstall can tell when installed files were edited afterwards',
    sql: `
ALTER TABLE installations ADD COLUMN tree_hash TEXT;
-- At most one live installation per host directory, whatever the processes involved do.
CREATE UNIQUE INDEX IF NOT EXISTS installations_one_live_per_target ON installations (host, scope, target_path) WHERE status = 'installed';
`,
  },
  {
    version: 5,
    name: 'workflow runs and step runs (each completed step output is the checkpoint a resumed run continues from)',
    sql: `
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT,
  definition TEXT NOT NULL,          -- the exact definition this run executes, frozen at start
  inputs TEXT NOT NULL,
  granted TEXT NOT NULL DEFAULT '[]', -- permissions granted when the run was started
  status TEXT NOT NULL,              -- queued | running | waiting | succeeded | failed | cancelled
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  owner_pid INTEGER,
  heartbeat_at TEXT,
  started_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE step_runs (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_id TEXT NOT NULL,
  status TEXT NOT NULL,              -- pending | running | waiting | succeeded | failed | skipped | cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  input TEXT,
  output TEXT,
  error TEXT,
  log TEXT NOT NULL DEFAULT '[]',
  approval TEXT,                     -- who approved or rejected, when, and why
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, step_id)
);
CREATE INDEX workflow_runs_status ON workflow_runs (status, updated_at);
CREATE INDEX workflow_runs_workflow ON workflow_runs (workflow_id, created_at);
`,
  },
  {
    version: 6,
    name: 'model provider checks: a provider is VERIFIED only by a recorded successful live call',
    sql: `
CREATE TABLE provider_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  model TEXT,
  ok INTEGER NOT NULL,
  detail TEXT NOT NULL,
  ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX provider_checks_provider ON provider_checks (provider_id, id);
`,
  },
  {
    version: 7,
    name: 'agent calls (the trace and the budget ledger of every model call an agent makes) and the per-run blackboard',
    sql: `
CREATE TABLE agent_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT,
  ok INTEGER NOT NULL,
  error TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  ms INTEGER,
  prompt_chars INTEGER,
  output_chars INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX agent_calls_run ON agent_calls (run_id, id);
CREATE TABLE blackboard (
  run_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  step_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, key)
);
`,
  },
  {
    version: 8,
    name: 'evaluation sets: cases with a train/held-out split and recorded authorship',
    sql: `
CREATE TABLE eval_sets (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE eval_cases (
  set_id TEXT NOT NULL REFERENCES eval_sets(id),
  id TEXT NOT NULL,
  split TEXT NOT NULL,      -- train | heldout
  kind TEXT NOT NULL,       -- positive | negative (activation) | behaviour (graded answer)
  prompt TEXT NOT NULL,
  must TEXT NOT NULL DEFAULT '[]',
  must_not TEXT NOT NULL DEFAULT '[]',
  author TEXT NOT NULL,     -- who wrote it: a person, a workspace file, or a model run
  created_at TEXT NOT NULL,
  PRIMARY KEY (set_id, id)
);
CREATE INDEX eval_cases_split ON eval_cases (set_id, split, kind);
`,
  },
  {
    version: 9,
    name: 'full-text rows keyed by the capability row id (an id lookup in FTS5 scanned the whole index on every write)',
    // Each capability's search row gets rowid = capabilities.rowid, so a write finds it directly. The indexed text
    // (including the entry body, which is kept only here) is carried over unchanged.
    sql: `
CREATE TEMP TABLE fts_carry AS SELECT id, name, description, tags, body FROM capabilities_fts;
DELETE FROM capabilities_fts;
INSERT INTO capabilities_fts (rowid, id, name, description, tags, body)
  SELECT c.rowid, t.id, t.name, t.description, t.tags, t.body FROM fts_carry t JOIN capabilities c ON c.id = t.id;
DROP TABLE fts_carry;
`,
  },
];

export function migrate(db: Db, backupsDir?: string): { applied: number[]; current: number } {
  db.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set(db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version));
  // A database written by a newer version is never opened by an older one: its tables may mean something this code
  // does not know. (After `upgrade --rollback`, the database is the pre-upgrade copy, or the schema did not change.)
  const known = Math.max(...MIGRATIONS.map((m) => m.version));
  const newest = Math.max(0, ...done);
  if (newest > known) throw new Error(`${db.file} has database schema version ${newest}, written by a newer ${PRODUCT.name}; this version knows up to ${known}. Run the newer version, or use its "${PRODUCT.bin} upgrade --rollback" to return this home to the earlier version.`);
  const pending = MIGRATIONS.filter((m) => !done.has(m.version));
  if (pending.length && done.size && backupsDir && fs.existsSync(db.file)) {
    fs.mkdirSync(backupsDir, { recursive: true });
    db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(db.file, path.join(backupsDir, `${PRODUCT.bin}-pre-v${pending[0].version}-${Date.now()}.db`));
  }
  for (const m of pending) {
    db.tx(() => {
      db.raw.exec(m.sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)', m.version, m.name, nowIso());
    });
  }
  const current = db.get<{ v: number }>('SELECT MAX(version) v FROM schema_migrations')?.v ?? 0;
  return { applied: pending.map((m) => m.version), current };
}

/* ---------- events (append-only) ---------- */

export interface EventRow {
  id: number;
  ts: string;
  type: string;
  subject: string | null;
  origin: string | null;
  payload: any;
}

/** Watchers in this process, nudged after every emit. A nudge only says "read again": an event written inside a
 * transaction that later rolls back is never announced, because watchers read committed rows. */
const nudges = new Set<() => void>();
let nudgeQueued = false;
function nudgeWatchers() {
  if (!nudges.size || nudgeQueued) return;
  nudgeQueued = true;
  setImmediate(() => {
    nudgeQueued = false;
    for (const n of [...nudges]) n();
  });
}

export function emit(db: Db, type: string, subject?: string | null, payload?: unknown, origin?: string): number {
  const r = db.run('INSERT INTO events (ts, type, subject, origin, payload) VALUES (?,?,?,?,?)', nowIso(), type, subject ?? null, origin ?? currentOrigin, j(payload));
  nudgeWatchers();
  return Number(r.lastInsertRowid);
}

/**
 * Delivers new events as they are committed. Events written by this process arrive on the next turn of the event
 * loop; events written by other processes (CLI, dashboard, workbench, scheduler) are noticed through SQLite's
 * `data_version`, which changes only when another connection commits, so the idle cost is one pragma read per
 * interval and the events table is queried only when something changed. Returns a function that stops watching.
 */
export function watchEvents(db: Db, onEvents: (rows: EventRow[]) => void, opts: { after?: number; intervalMs?: number } = {}): () => void {
  let last = opts.after ?? db.get<{ m: number }>('SELECT COALESCE(MAX(id),0) AS m FROM events')!.m;
  let version = -1;
  let stopped = false;
  const read = () => {
    if (stopped) return;
    try {
      for (;;) {
        const rows = eventsSince(db, last, 200);
        if (!rows.length) break;
        last = rows[rows.length - 1].id;
        onEvents(rows);
        if (rows.length < 200 || stopped) break;
      }
    } catch {
      /* the database is closing or busy: the next nudge or interval tries again */
    }
  };
  const check = () => {
    try {
      const v = db.get<{ data_version: number }>('PRAGMA data_version')!.data_version;
      if (v !== version) (version = v), read();
    } catch {
      /* closed */
    }
  };
  nudges.add(read);
  const timer = opts.intervalMs === 0 ? null : setInterval(check, opts.intervalMs ?? 250);
  timer?.unref?.();
  read();
  return () => {
    stopped = true;
    nudges.delete(read);
    if (timer) clearInterval(timer);
  };
}
export function eventsSince(db: Db, afterId = 0, limit = 500): EventRow[] {
  return db
    .all<any>('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?', afterId, limit)
    .map((r) => ({ ...r, payload: pj(r.payload, null) }));
}
export function recentEvents(db: Db, limit = 100, typePrefix?: string): EventRow[] {
  const rows = typePrefix
    ? db.all<any>('SELECT * FROM events WHERE type LIKE ? ORDER BY id DESC LIMIT ?', typePrefix + '%', limit)
    : db.all<any>('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit);
  return rows.map((r) => ({ ...r, payload: pj(r.payload, null) }));
}

let currentOrigin = 'cli';
export const setOrigin = (o: string) => {
  currentOrigin = o;
};
export const getOrigin = () => currentOrigin;

/* ---------- settings ---------- */

export const DEFAULT_SETTINGS = {
  providers: {
    /** Order of preference when a task does not name a provider. */
    preferred: ['claude-code-headless', 'anthropic', 'openai', 'gemini', 'ollama'] as string[],
    /** "any": remote providers may receive task text; "local-only": only providers running on this machine. */
    privacy: 'any' as 'any' | 'local-only',
    /** Providers the owner has switched off. */
    disabled: [] as string[],
    /** Model per provider. Providers without a known default need one here before they can be used. */
    models: { anthropic: 'claude-sonnet-5-5' } as Record<string, string>,
    /** Base URLs for OpenAI-compatible servers. */
    endpoints: { openai: 'https://api.openai.com/v1', ollama: 'http://127.0.0.1:11434/v1' } as Record<string, string>,
    /** Optional prices in USD per million tokens, { input, output }; cost is reported as unknown without them. */
    prices: {} as Record<string, { input: number; output: number }>,
  },
  workflow: {
    /** Steps that run commands are off until the owner turns them on, and then only for programs named here. */
    shell: { enabled: false, allow: [] as string[] },
    /** Steps that ask for these permissions wait for a person's approval before they run. */
    approvalRequiredFor: ['installation', 'configuration', 'publishing', 'delete', 'credentials', 'shell'] as string[],
    maxParallel: 4,
    defaultTimeoutMs: 5 * 60_000,
  },
  policy: {
    autoInstallThreshold: 88,
    /** 'off' | 'sandbox' (auto-install only into staged host dirs) — real host installs are never automatic. */
    autoInstall: 'sandbox' as 'off' | 'sandbox',
    weights: {
      usefulness: 15,
      technical: 15,
      security: 20,
      effectiveness: 15,
      compatibility: 10,
      maintenance: 10,
      documentation: 5,
      contextEfficiency: 5,
      provenance: 5,
    },
    allowedLicenses: ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'CC0-1.0', 'Unlicense', 'MPL-2.0', 'CC-BY-4.0'],
    denyPublishers: [] as string[],
    denyNamePatterns: [] as string[],
    /**
     * Ordered rules; the first that matches decides. Effects: 'deny' blocks; 'require-approval' stops automatic
     * promotion; 'allow-auto' permits automatic promotion only when every built-in check passes (rules can tighten
     * the gate, never loosen it). Match fields: kind, tier, trust, licence, permission, publisher, source, origin,
     * namePattern; each accepts a value or a list.
     */
    rules: [] as { id: string; when: Record<string, string | string[]>; effect: 'deny' | 'require-approval' | 'allow-auto'; reason?: string }[],
    /** What happens when no rule matches and every check passes. */
    defaultEffect: 'allow-auto' as 'allow-auto' | 'require-approval',
    officialPublishers: ['anthropics', 'modelcontextprotocol', 'openai', 'google-gemini', 'vercel', 'vercel-labs', 'microsoft', 'github'],
  },
  discovery: {
    disabledSources: [] as string[],
    /** Curated lists (GitHub owner/name) whose README links are walked by the curated-lists source. */
    curatedLists: ['punkpeye/awesome-mcp-servers', 'hesreallyhim/awesome-claude-code', 'ComposioHQ/awesome-claude-skills', 'VoltAgent/awesome-claude-code-subagents'] as string[],
    /** Cadence per job: hourly, daily, weekly or off. Runs only while `synaptome scheduler run` is running. */
    schedule: { incremental: 'daily', broad: 'weekly', updates: 'daily', gaps: 'daily' },
    maxPerQuery: 15,
    preferredCategories: [] as string[],
    excludedCategories: [] as string[],
    minQualityToRecommend: 60,
  },
  hosts: {
    /** Number of capabilities that may be installed into the user's real host directories. */
    realInstallBudget: 1,
    targets: ['claude-code'],
    /** Project whose .mcp.json receives MCP server entries on a real install. Empty: real MCP installs are refused. User-scope config is never written. */
    claudeProject: '' as string,
  },
  routing: {
    strategy: 'lexical-graph-v2' as 'lexical-graph-v1' | 'lexical-graph-v2',
    /** Selections below this confidence are not made. An empty result is a valid result. */
    minConfidence: 0.55,
    maxCapabilities: 4,
    /** Estimated tokens of full capability content one decision may lead a host to load. */
    contextBudgetTokens: 12000,
    /** What the prompt hook may add to a host's context: summaries only, hard-capped. */
    hook: { maxTokens: 800, maxTokensPerCapability: 300 },
  },
  /**
   * `mouse`: the Terminal Workbench reports clicks and the wheel (off by default: it takes over the terminal's own text selection).
   * `onboarded`: set the first time either interface opens; until then both open on Get started.
   */
  ui: { theme: 'auto' as 'auto' | 'light' | 'dark', accent: 'bronze', mouse: false, onboarded: false },
};
export type Settings = typeof DEFAULT_SETTINGS;

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
function deepMerge<T>(base: T, over: any): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
  const out: any = { ...base };
  for (const k of Object.keys(over)) out[k] = k in (base as any) ? deepMerge((base as any)[k], over[k]) : over[k];
  return out;
}

export function getSettings(db: Db): Settings {
  let s: any = structuredClone(DEFAULT_SETTINGS);
  for (const row of db.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
    s = deepMerge(s, setPath({}, row.key, pj(row.value, undefined)));
  }
  return s;
}
function setPath(obj: any, key: string, value: unknown) {
  const parts = key.split('.');
  let o = obj;
  parts.forEach((p, i) => {
    if (i === parts.length - 1) o[p] = value;
    else o = o[p] ??= {};
  });
  return obj;
}
export function getPath(obj: any, key: string): unknown {
  return key.split('.').reduce((o, p) => (o == null ? undefined : o[p]), obj);
}
/** Sets one dotted key. Only keys that exist in DEFAULT_SETTINGS are accepted. */
export function setSetting(db: Db, key: string, value: unknown) {
  const def = getPath(DEFAULT_SETTINGS, key);
  if (def === undefined) throw new Error(`Unknown setting "${key}"`);
  if (typeof def !== typeof value || Array.isArray(def) !== Array.isArray(value)) {
    throw new Error(`Setting "${key}" expects ${Array.isArray(def) ? 'array' : typeof def}`);
  }
  db.run('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', key, j(value), nowIso());
  emit(db, 'settings.changed', key, { value });
}

/* ---------- system handle ---------- */

export interface Sys {
  home: string;
  paths: Paths;
  db: Db;
  settings(): Settings;
  close(): void;
}

export function openSystem(explicitHome?: string): Sys {
  const home = resolveHome(explicitHome);
  const paths = pathsFor(home);
  // Never write into a directory that still holds un-migrated data from the previous product name.
  if (isLegacyHome(home)) throw new Error(`${home} holds ${LEGACY.name} data that has not been migrated. Run: ${PRODUCT.bin} migrate --from "${home}" --to <new home>  (the original is never modified)`);
  for (const d of [home, paths.store, paths.quarantine, paths.sandboxHosts, paths.forge, paths.backups, paths.cache]) fs.mkdirSync(d, { recursive: true });
  const db = new Db(paths.db);
  try {
    migrate(db, paths.backups);
  } catch (e) {
    db.close(); // a refused or failed open leaves no handle on the file
    throw e;
  }
  return { home, paths, db, settings: () => getSettings(db), close: () => db.close() };
}
