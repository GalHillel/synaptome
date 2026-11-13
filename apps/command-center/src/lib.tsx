import { type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/* ---------- API client: every screen talks to the same command surface as the CLI and TUI ---------- */

const TOKEN = typeof document === 'undefined' ? '' : (document.querySelector('meta[name="synaptome-token"]')?.getAttribute('content') ?? '');

export class CallError extends Error {
  constructor(message: string, public code: string, public hint?: string) {
    super(message);
  }
}

export async function call<T = any>(name: string, args: unknown = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/call/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-synaptome-token': TOKEN }, body: JSON.stringify(args) });
  } catch {
    throw new CallError('The local Synaptome service is not reachable', 'offline', 'Start it again with: synaptome dashboard');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) throw new CallError(body?.error?.message ?? `Request failed (${res.status})`, body?.error?.code ?? 'error', body?.error?.hint);
  return body.data as T;
}

/* ---------- live events ---------- */

const RELOAD_FLAG = 'synaptome-reloaded-for-token';
const session = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) sessionStorage.removeItem(k);
      else sessionStorage.setItem(k, v);
    } catch {
      /* storage unavailable: the page simply does not auto-reload */
    }
  },
};

/**
 * Subscribes to the shared event stream. It is a fetch stream, not an EventSource, so the session token can
 * travel in a header like every other request and never in the URL. Reconnects with the last seen event id.
 * Returns a function that closes the stream.
 */
export function openEventStream(handlers: { onEvent(e: LiveEvent): void; onStatus(online: boolean): void; onAuthLost?(): void }): () => void {
  let closed = false;
  let lastId = '';
  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Reconnect with exponential backoff (2 s doubling to 30 s), reset after a successful connection, so a page left
  // open while the service is stopped does not hammer the port.
  let failures = 0;
  const retryIn = () => Math.min(30_000, 2000 * 2 ** Math.min(failures, 4));

  const connect = async () => {
    if (closed) return;
    ctrl = new AbortController();
    try {
      const headers: Record<string, string> = { accept: 'text/event-stream', 'x-synaptome-token': TOKEN };
      if (lastId) headers['last-event-id'] = lastId;
      const res = await fetch('/api/events/stream', { headers, signal: ctrl.signal, cache: 'no-store' });
      if (res.status === 401) {
        // The service was restarted and this page still holds the previous start's token. Reload once to get the new one.
        handlers.onStatus(false);
        if (!session.get(RELOAD_FLAG)) {
          session.set(RELOAD_FLAG, '1');
          location.reload();
        } else handlers.onAuthLost?.(); // a reload did not help: stop and tell the person, do not retry forever
        return;
      }
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      session.set(RELOAD_FLAG, null);
      failures = 0;
      handlers.onStatus(true);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          let id = '';
          let name = '';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('id:')) id = line.slice(3).trim();
            else if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (name !== 'synaptome' || !data) continue;
          if (id) lastId = id;
          try {
            handlers.onEvent(JSON.parse(data) as LiveEvent);
          } catch {
            /* a malformed event is skipped, the stream continues */
          }
        }
      }
    } catch {
      /* network error or abort: handled below */
    }
    if (closed) return;
    handlers.onStatus(false);
    timer = setTimeout(connect, retryIn());
    failures++;
  };

  void connect();
  return () => {
    closed = true;
    ctrl?.abort();
    clearTimeout(timer);
  };
}

/* ---------- app context ---------- */

export type Selection = { type: 'capability' | 'candidate' | 'decision' | 'forge' | 'run' | 'source' | 'evalset'; id: string } | null;
export interface LiveEvent {
  id: number;
  ts: string;
  type: string;
  subject: string | null;
  origin: string | null;
  payload: any;
}
export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  consequences?: string[];
  confirmLabel: string;
  danger?: boolean;
  input?: { label: string; placeholder?: string; required?: boolean };
}
export interface AppContext {
  rev: number;
  events: LiveEvent[];
  online: boolean;
  view: string;
  params: Record<string, string>;
  go(view: string, params?: Record<string, string>): void;
  selection: Selection;
  open(sel: Selection): void;
  toast(message: string, detail?: string, error?: boolean): void;
  confirm(o: ConfirmOptions): Promise<false | { input: string }>;
  /** Runs an action, reports the result, and returns it (or undefined on failure). */
  run<T = any>(name: string, args: unknown, ok: string | ((r: T) => string)): Promise<T | undefined>;
}
export const Ctx = createContext<AppContext>(null as any);
export const useApp = () => useContext(Ctx);

/** Fetches a query and refetches whenever live events arrive. Keeps the previous data on screen while reloading. */
export function useQuery<T = any>(name: string | null, args: unknown = {}, opts: { live?: boolean } = {}) {
  const { rev } = useApp();
  const [state, setState] = useState<{ data?: T; error?: CallError; loading: boolean }>({ loading: !!name });
  const [tick, setTick] = useState(0);
  const key = name ? `${name}:${JSON.stringify(args)}` : '';
  const liveRev = opts.live === false ? 0 : rev;
  useEffect(() => {
    if (!name) return;
    let dead = false;
    setState((s) => ({ ...s, loading: true }));
    call<T>(name, args)
      .then((data) => !dead && setState({ data, loading: false }))
      .catch((error) => !dead && setState((s) => ({ data: s.data, error, loading: false })));
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, liveRev, tick]);
  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) };
}

export function useDebounced<T>(value: T, ms = 220): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/* ---------- primitives ---------- */

const MARKS: Record<string, [glyph: string, tone: string, label?: string]> = {
  approved: ['●', 'ok'], registered: ['◐', 'info'], blocked: ['✕', 'danger'], rejected: ['⊘', 'idle'], deprecated: ['⊘', 'idle'],
  discovered: ['○', 'idle'], queued: ['◔', 'info'], quarantined: ['◍', 'warn'], audited: ['◑', 'info'],
  installed: ['■', 'ok'], rolled_back: ['↺', 'idle', 'rolled back'], uninstalled: ['□', 'idle'], failed: ['✕', 'danger'], superseded: ['↑', 'idle'],
  healthy: ['●', 'ok'], unavailable: ['✕', 'danger'], degraded: ['▲', 'warn'], unknown: ['?', 'idle'],
  completed: ['●', 'ok'], skipped: ['–', 'idle'], running: ['◔', 'info'],
  pass: ['✓', 'ok'], fail: ['✕', 'danger'], ok: ['●', 'ok'], warn: ['▲', 'warn'],
  promoted: ['●', 'ok'], held: ['▲', 'warn'], draft: ['○', 'idle'], checked: ['◐', 'info'], evaluated: ['◑', 'info'], 'eval-blocked': ['▲', 'warn', 'evaluation blocked'],
  'auto-promote': ['●', 'ok'], 'needs-approval': ['◐', 'warn', 'needs approval'], success: ['●', 'ok'], partial: ['◐', 'warn'],
  succeeded: ['✓', 'ok'], waiting: ['▲', 'warn', 'waiting for you'], pending: ['○', 'idle'], cancelled: ['○', 'idle'],
  VERIFIED: ['●', 'ok'], PARTIALLY_VERIFIED: ['◐', 'warn', 'partially verified'], EXPERIMENTAL: ['◔', 'warn', 'experimental'], UNSUPPORTED: ['○', 'idle', 'unsupported'],
  OFFICIAL_VERIFIED: ['●', 'ok', 'official, verified'], VERIFIED_PUBLISHER: ['●', 'ok', 'verified publisher'], REVIEWED_COMMUNITY: ['◐', 'info', 'reviewed'], UNKNOWN: ['?', 'idle', 'unknown'], QUARANTINED: ['◍', 'warn', 'quarantined'], BLOCKED: ['✕', 'danger', 'blocked'],
};
/** Status as glyph + word. Colour reinforces it but is never the only signal. */
export function Mark({ s, label }: { s: string | null | undefined; label?: string }) {
  const m = MARKS[s ?? ''] ?? ['·', 'idle'];
  return (
    <span className={`mark ${m[1]}`}>
      <b aria-hidden="true">{m[0]}</b>
      {label ?? m[2] ?? String(s ?? '—').replace(/_/g, ' ')}
    </span>
  );
}
export const Tier = ({ t }: { t: string }) => (
  <span className={`tag ${t}`} title={{ A: 'Tier A: declarative only', B: 'Tier B: executable or networked; needs approval', C: 'Tier C: high risk; blocked' }[t]}>
    {t}
  </span>
);
export function Quality({ q }: { q: number | null | undefined }) {
  if (q == null) return <span className="faint">not scored</span>;
  return (
    <span className="meter num" title={`quality score ${q} of 100`}>
      {q.toFixed(0)}
      <i style={{ ['--v' as any]: `${Math.max(0, Math.min(100, q))}%` }} />
    </span>
  );
}
export const when = (iso?: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
export function ago(iso?: string | null) {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function Button({ onClick, children, kind = '', disabled, title }: { onClick: () => unknown | Promise<unknown>; children: ReactNode; kind?: string; disabled?: boolean; title?: string }) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  return (
    <button
      type="button"
      className={`btn ${kind}`}
      disabled={disabled || busy}
      aria-busy={busy}
      title={title}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          if (alive.current) setBusy(false);
        }
      }}
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

export interface Col<R> {
  key: string;
  title: string;
  width?: string;
  cls?: string;
  render(row: R): ReactNode;
}
/** Dense table with keyboard movement (j/k or arrows) and Enter to open. */
export function DataTable<R>({ rows, cols, rowKey, selected, onOpen, label }: { rows: R[]; cols: Col<R>[]; rowKey(r: R): string; selected?: string | null; onOpen?(r: R): void; label: string }) {
  const move = (e: React.KeyboardEvent<HTMLTableRowElement>, r: R) => {
    const el = e.currentTarget;
    if (e.key === 'j' || e.key === 'ArrowDown') (e.preventDefault(), (el.nextElementSibling as HTMLElement | null)?.focus());
    else if (e.key === 'k' || e.key === 'ArrowUp') (e.preventDefault(), (el.previousElementSibling as HTMLElement | null)?.focus());
    else if (e.key === 'Enter' && onOpen) (e.preventDefault(), onOpen(r));
  };
  return (
    <div className="tblwrap">
    <table className={`tbl ${onOpen ? '' : 'static'}`} aria-label={label}>
      <colgroup>
        {cols.map((c) => (
          <col key={c.key} style={{ width: c.width }} className={c.cls?.includes('hide-sm') ? 'hide-sm' : undefined} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c.key} scope="col" className={c.cls}>
              {c.title || <span className="sr-only">Actions</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={rowKey(r)} tabIndex={onOpen ? 0 : undefined} aria-current={selected === rowKey(r) ? 'true' : undefined} onClick={onOpen ? () => onOpen(r) : undefined} onKeyDown={onOpen ? (e) => move(e, r) : undefined}>
            {cols.map((c) => (
              <td key={c.key} className={c.cls}>
                {c.render(r)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

export const Skeleton = ({ rows = 6 }: { rows?: number }) => (
  <div role="status" aria-label="Loading">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="skeleton" />
    ))}
  </div>
);
export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="empty">
    <strong>{title}</strong>
    {children}
  </div>
);
export function Failure({ error, retry }: { error: CallError; retry?: () => void }) {
  return (
    <div className="note danger" role="alert">
      <strong>{error.code === 'offline' ? 'Service offline' : 'Could not load'}</strong> — {error.message}
      {error.hint ? <div className="muted">{error.hint}</div> : null}
      {retry ? (
        <div style={{ marginTop: 8 }}>
          <button className="btn" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}
/** Standard query wrapper: skeleton, failure with retry, or content. */
export function Loaded<T>({ q, children, rows }: { q: { data?: T; error?: CallError; loading: boolean; reload(): void }; children(data: T): ReactNode; rows?: number }) {
  if (q.data === undefined && q.error) return <Failure error={q.error} retry={q.reload} />;
  if (q.data === undefined) return <Skeleton rows={rows} />;
  return (
    <>
      {q.error ? <Failure error={q.error} retry={q.reload} /> : null}
      {children(q.data)}
    </>
  );
}
export const KV = ({ items }: { items: [string, ReactNode][] }) => (
  <dl className="kv">
    {items.map(([k, v]) => (
      <div key={k} style={{ display: 'contents' }}>
        <dt>{k}</dt>
        <dd>{v === '' || v == null ? <span className="faint">—</span> : v}</dd>
      </div>
    ))}
  </dl>
);
export function PageHeader({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header>
      <h1>{title}</h1>
      {children ? <p>{children}</p> : null}
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}
