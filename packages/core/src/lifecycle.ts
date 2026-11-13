import { type Sys, emit, nowIso } from './db';
import type { CapabilityStatus } from './schema';

/**
 * The capability lifecycle as an enforced state machine. Every status change goes through `transitionCapability`:
 * it refuses transitions that are not allowed, requires a reason, records who did it, and emits one event.
 *
 *   registered ──approve──> approved ──(update arrives, revision)──> registered
 *        │                     │
 *        ├──reject──> rejected ├──reject──> rejected ──reconsider──> registered
 *        ├──block───> blocked  ├──block───> blocked  ──re-audit────> registered
 *        └──deprecate─> deprecated <──deprecate──┘   deprecated ──reinstate──> registered
 *
 * Nothing goes straight from rejected, blocked or deprecated to approved: it must be registered again, which means it
 * passes the audit and the promotion gate again.
 */
export const TRANSITIONS: Record<CapabilityStatus, readonly CapabilityStatus[]> = {
  registered: ['approved', 'rejected', 'blocked', 'deprecated'],
  approved: ['registered', 'rejected', 'blocked', 'deprecated'],
  rejected: ['registered'],
  blocked: ['registered'],
  deprecated: ['registered'],
};

export class LifecycleError extends Error {
  constructor(message: string, public code: 'not-found' | 'not-allowed' | 'invalid') {
    super(message);
    this.name = 'LifecycleError';
  }
}

export const canTransition = (from: CapabilityStatus, to: CapabilityStatus) => from === to || TRANSITIONS[from]?.includes(to) === true;

export interface TransitionRecord {
  id: number;
  capabilityId: string;
  from: CapabilityStatus | null;
  to: CapabilityStatus;
  reason: string;
  by: string;
  at: string;
}

/** Writes the transition row. Callers that change `status` themselves (inside a larger update) use this directly. */
export function recordTransition(sys: Sys, capabilityId: string, from: CapabilityStatus | null, to: CapabilityStatus, reason: string, by: string): number {
  return Number(sys.db.run('INSERT INTO capability_transitions (capability_id, from_status, to_status, reason, actor, at) VALUES (?,?,?,?,?,?)', capabilityId, from, to, reason, by, nowIso()).lastInsertRowid);
}

/**
 * Moves a capability to `to`. A transition to the current status is a no-op and returns null.
 * `extraSql` adds column assignments to the same UPDATE (for example trust when a person approves).
 */
export function transitionCapability(
  sys: Sys,
  capabilityId: string,
  to: CapabilityStatus,
  opts: { reason: string; by: string; payload?: Record<string, unknown>; extraSql?: string },
): TransitionRecord | null {
  if (!opts.reason?.trim()) throw new LifecycleError('A reason is required for every lifecycle change', 'invalid');
  return sys.db.tx(() => {
    const row = sys.db.get<{ status: CapabilityStatus }>('SELECT status FROM capabilities WHERE id = ?', capabilityId);
    if (!row) throw new LifecycleError(`No capability "${capabilityId}"`, 'not-found');
    const from = row.status;
    if (from === to) return null;
    if (!canTransition(from, to)) throw new LifecycleError(`${capabilityId} cannot go from ${from} to ${to}; allowed from ${from}: ${TRANSITIONS[from].join(', ') || 'none'}`, 'not-allowed');
    const at = nowIso();
    sys.db.run(`UPDATE capabilities SET status = ?, updated_at = ?${opts.extraSql ? `, ${opts.extraSql}` : ''} WHERE id = ?`, to, at, capabilityId);
    const id = recordTransition(sys, capabilityId, from, to, opts.reason.trim(), opts.by);
    emit(sys.db, `capability.${to}`, capabilityId, { from, reason: opts.reason.trim(), by: opts.by, ...(opts.payload ?? {}) });
    return { id, capabilityId, from, to, reason: opts.reason.trim(), by: opts.by, at };
  });
}

export function capabilityHistory(sys: Sys, capabilityId: string): TransitionRecord[] {
  return sys.db
    .all<any>('SELECT * FROM capability_transitions WHERE capability_id = ? ORDER BY id', capabilityId)
    .map((r) => ({ id: r.id, capabilityId: r.capability_id, from: r.from_status, to: r.to_status, reason: r.reason, by: r.actor, at: r.at }));
}
