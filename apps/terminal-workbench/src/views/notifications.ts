import { type ViewDef, type Action, mark, dim, mid, strong, when, P, KV, BLANK } from '../kit';

const levelMark = (level: string) => mark(level === 'action' ? 'waiting' : level === 'warning' ? 'warn' : 'ok', level);

/** Notifications: things that need a person, newest first. Each cause appears once however often it recurs. */
export const view: ViewDef = {
  id: 'notifications', title: 'Notifications', filterHint: 'filter by title or text', empty: 'Nothing needs you. Notifications appear when an approval is waiting or a source, update or publisher needs attention.',
  columns: [{ title: 'Notification', width: 0 }, { title: 'Level', width: 16 }, { title: 'When', width: 12, optional: true }, { title: 'Read', width: 6 }],
  async load(api, f) {
    const q = f.toLowerCase();
    return (await api.call('notifications.list', { all: true, limit: 100 }))
      .filter((n: any) => !q || `${n.title} ${n.body}`.toLowerCase().includes(q))
      .map((n: any) => ({ id: String(n.id), raw: n, cells: [n.readAt ? mid(n.title) : strong(n.title), levelMark(n.level), dim(when(n.ts)), n.readAt ? dim('yes') : { t: 'new', c: 'accent' as const, b: true }] }));
  },
  async inspect(_api, item) {
    const n = item.raw;
    return [[strong(n.title)], BLANK, [{ t: 'level         ', c: 'dim' }, levelMark(n.level)], KV('when', when(n.ts)), KV('read', n.readAt ? when(n.readAt) : 'not yet'), ...(n.kind ? [KV('kind', n.kind)] : []), ...(n.subject ? [KV('about', n.subject)] : []), BLANK, P(n.body ?? '', 'mid')];
  },
  actions(item, marked) {
    const a: Action[] = [];
    const targets = (marked.length ? marked : item ? [item] : []).filter((i) => !i.raw.readAt);
    if (targets.length) a.push({ label: targets.length > 1 ? `Mark ${targets.length} read` : 'Mark read', run: async (api) => { for (const t of targets) await api.call('notifications.read', { id: t.raw.id }); return `${targets.length} marked as read`; } });
    a.push({ label: 'Mark all read', run: async (api) => `${(await api.call('notifications.read', {})).marked} marked as read` });
    return a;
  },
};
