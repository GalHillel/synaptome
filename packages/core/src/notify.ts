import { type Sys, emit, nowIso } from './db';

export type NotificationLevel = 'info' | 'notice' | 'warning' | 'action';

export interface Notification {
  id: number;
  ts: string;
  level: NotificationLevel;
  kind: string;
  subject: string | null;
  title: string;
  body: string | null;
  readAt: string | null;
}

/**
 * Records something a person should look at. `dedupeKey` keeps one open notification per condition: raising the
 * same condition again while it is unread does nothing, so a failing source does not produce one entry per scan.
 * Returns the new id, or null when an unread notification with the same key exists.
 */
export function notify(sys: Sys, n: { level: NotificationLevel; kind: string; title: string; subject?: string | null; body?: string | null; dedupeKey?: string }): number | null {
  if (n.dedupeKey) {
    const open = sys.db.get<{ id: number }>('SELECT id FROM notifications WHERE dedupe_key = ? AND read_at IS NULL', n.dedupeKey);
    if (open) return null;
    // A read notification with the same key is retired so the condition can be raised again.
    sys.db.run('UPDATE notifications SET dedupe_key = NULL WHERE dedupe_key = ? AND read_at IS NOT NULL', n.dedupeKey);
  }
  const id = Number(sys.db.run('INSERT INTO notifications (ts, level, kind, subject, title, body, dedupe_key) VALUES (?,?,?,?,?,?,?)', nowIso(), n.level, n.kind, n.subject ?? null, n.title, n.body ?? null, n.dedupeKey ?? null).lastInsertRowid);
  emit(sys.db, 'notification.raised', String(id), { level: n.level, kind: n.kind, subject: n.subject ?? null, title: n.title });
  return id;
}

export function listNotifications(sys: Sys, opts: { unreadOnly?: boolean; limit?: number } = {}): Notification[] {
  return sys.db
    .all<any>(`SELECT * FROM notifications ${opts.unreadOnly ? 'WHERE read_at IS NULL' : ''} ORDER BY id DESC LIMIT ?`, opts.limit ?? 100)
    .map((r) => ({ id: r.id, ts: r.ts, level: r.level, kind: r.kind, subject: r.subject, title: r.title, body: r.body, readAt: r.read_at }));
}

/** Marks one notification, or all of them when `id` is omitted, as read. Returns how many changed. */
export function markNotificationsRead(sys: Sys, id?: number): number {
  const r = id == null ? sys.db.run('UPDATE notifications SET read_at = ? WHERE read_at IS NULL', nowIso()) : sys.db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL', nowIso(), id);
  return Number(r.changes);
}
