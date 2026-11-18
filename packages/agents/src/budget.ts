import { type Sys, nowIso, pj } from '@synaptome/core';
import { costOf } from '@synaptome/providers';

/**
 * Budget reservations for billable calls (plan NG, M1, W6). Checking recorded spend before a call is not enough when
 * steps run in parallel: two steps both see room for one call and together exceed the budget. So every billable call
 * first reserves its worst case inside one write transaction (`BEGIN IMMEDIATE`, atomic across connections and
 * processes), and the reservation succeeds only if
 *
 *   actual spend + open reservations + abandoned estimates + this estimate  ≤  budget
 *
 * for the token and the USD budget. Afterwards the reservation is settled with the actual usage, released when no call
 * was made, or abandoned when the outcome is unknown (cancelled or timed out without usage, or its process died), and an
 * abandoned reservation keeps counting at its estimate: an unknown cost is never treated as zero.
 *
 * Worst case: input ≈ prompt characters / 3 (conservative), output = the call's max_tokens; for agentic providers
 * (headless Claude Code, whose use is not bounded by max_tokens) the `workflow.agenticCallTokens` setting. With a USD
 * budget and no configured price the call is refused (unknown cost never counts as within budget).
 */

const AGENTIC = new Set(['claude-code-headless']);
/** This process, recognisable after a crash: pid plus start time. */
const HOLDER = `${process.pid}:${Math.round(Date.now() - process.uptime() * 1000)}`;

export interface Budget { tokens?: number; usd?: number; ms?: number }
export interface Estimate { tokens: number; usd: number | null }
export interface Reservation { id: number; estimate: Estimate }

export function budgetOf(sys: Sys, runId: string): Budget | null {
  return pj<any>(sys.db.get<any>('SELECT definition FROM workflow_runs WHERE id=?', runId)?.definition, {}).budget ?? null;
}

export function estimateCall(sys: Sys, providerId: string, promptChars: number, maxTokens: number): Estimate {
  const input = Math.ceil(promptChars / 3);
  const tokens = AGENTIC.has(providerId) ? Math.max(input + maxTokens, (sys.settings() as any).workflow?.agenticCallTokens ?? 200_000) : input + maxTokens;
  const usd = AGENTIC.has(providerId) ? costOf(sys, providerId, { inputTokens: tokens - maxTokens, outputTokens: maxTokens }) : costOf(sys, providerId, { inputTokens: input, outputTokens: maxTokens });
  return { tokens, usd };
}

/** Whether a holder ("pid:start") is a live process (an unknown or reused pid counts as alive: never abandon a live call). */
function holderAlive(holder: string): boolean {
  if (holder === HOLDER) return true;
  const pid = Number(holder.split(':')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** Committed spend of a run: actual (recorded calls) + open reservations + abandoned estimates. */
export function committed(sys: Sys, runId: string): { tokens: number; usd: number | null; held: number; abandoned: number } {
  const calls = sys.db.get<any>('SELECT COUNT(*) n, COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)),0) tokens, SUM(cost_usd) usd, COUNT(cost_usd) priced FROM agent_calls WHERE run_id=?', runId)!;
  const res = sys.db.get<any>("SELECT COALESCE(SUM(CASE WHEN status='held' THEN est_tokens END),0) heldTokens, COALESCE(SUM(CASE WHEN status='abandoned' THEN est_tokens END),0) abTokens, SUM(CASE WHEN status IN ('held','abandoned') THEN est_usd END) usd, COUNT(CASE WHEN status IN ('held','abandoned') THEN 1 END) n, COUNT(CASE WHEN status IN ('held','abandoned') AND est_usd IS NOT NULL THEN 1 END) priced FROM budget_reservations WHERE run_id=?", runId)!;
  const callsUsd = !calls.n ? 0 : calls.priced === calls.n ? calls.usd : null;
  const resUsd = !res.n ? 0 : res.priced === res.n ? res.usd : null;
  return { tokens: calls.tokens + res.heldTokens + res.abTokens, usd: callsUsd === null || resUsd === null ? null : callsUsd + resUsd, held: res.heldTokens, abandoned: res.abTokens };
}

export class BudgetRefused extends Error {}

/**
 * Atomically reserves the worst case of one call, or throws BudgetRefused with the reason. Reservations left by a
 * process that no longer exists are marked abandoned first (they keep counting at their estimate).
 */
export function reserve(sys: Sys, runId: string, stepId: string, est: Estimate): Reservation | null {
  const b = budgetOf(sys, runId);
  // Committed on its own, so a refusal below (which rolls back its transaction) never undoes the recovery.
  sys.db.tx(() => {
    for (const r of sys.db.all<{ id: number; holder: string }>("SELECT id, holder FROM budget_reservations WHERE run_id=? AND status='held'", runId)) {
      if (!holderAlive(r.holder)) sys.db.run("UPDATE budget_reservations SET status='abandoned', reason='its process ended before the call was settled', updated_at=? WHERE id=? AND status='held'", nowIso(), r.id);
    }
  });
  let id = 0;
  sys.db.tx(() => {
    if (b) {
      if (b.ms) {
        const run = sys.db.get<{ created_at: string }>('SELECT created_at FROM workflow_runs WHERE id=?', runId);
        const ms = run ? Date.now() - Date.parse(run.created_at) : 0;
        if (ms >= b.ms) throw new BudgetRefused(`time budget used: ${Math.round(ms / 1000)} s of ${Math.round(b.ms / 1000)} s`);
      }
      const c = committed(sys, runId);
      if (b.tokens && c.tokens + est.tokens > b.tokens) throw new BudgetRefused(`token budget: ${c.tokens} committed (including ${c.held} reserved by running calls and ${c.abandoned} counted for calls of unknown cost) + ${est.tokens} for this call > ${b.tokens}`);
      if (b.usd) {
        if (est.usd === null || c.usd === null) throw new BudgetRefused('a USD budget is set but the cost is unknown (no price configured for the provider)');
        if (c.usd + est.usd > b.usd + 1e-12) throw new BudgetRefused(`USD budget: ${c.usd.toFixed(4)} committed + ${est.usd.toFixed(4)} for this call > ${b.usd}`);
      }
    }
    id = Number(sys.db.run("INSERT INTO budget_reservations (run_id, step_id, holder, est_tokens, est_usd, status, created_at, updated_at) VALUES (?,?,?,?,?,'held',?,?)", runId, stepId, HOLDER, est.tokens, est.usd, nowIso(), nowIso()).lastInsertRowid);
  });
  return { id, estimate: est };
}

/** The call happened and reported its usage: the actual cost replaces the reservation (recorded in agent_calls). */
export function settle(sys: Sys, r: Reservation, actual: { tokens: number; usd: number | null }) {
  sys.db.run("UPDATE budget_reservations SET status='settled', actual_tokens=?, actual_usd=?, updated_at=? WHERE id=? AND status='held'", actual.tokens, actual.usd, nowIso(), r.id);
}
/** No call was made: the reservation is returned. */
export function release(sys: Sys, r: Reservation, reason: string) {
  sys.db.run("UPDATE budget_reservations SET status='released', reason=?, updated_at=? WHERE id=? AND status='held'", reason, nowIso(), r.id);
}
/** A call may have been made but its cost is unknown: it keeps counting at its estimate. */
export function abandon(sys: Sys, r: Reservation, reason: string) {
  sys.db.run("UPDATE budget_reservations SET status='abandoned', reason=?, updated_at=? WHERE id=? AND status='held'", reason, nowIso(), r.id);
}

export function reservations(sys: Sys, runId: string) {
  return sys.db.all<any>('SELECT id, step_id stepId, status, est_tokens estTokens, est_usd estUsd, actual_tokens actualTokens, actual_usd actualUsd, reason FROM budget_reservations WHERE run_id=? ORDER BY id', runId);
}
