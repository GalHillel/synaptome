import type { Api } from '@synaptome/service';
import { type ViewDef, type Seg, dim, mid, H, P, KV, BLANK } from '../kit';

export const view: ViewDef = {
  id: 'logs', title: 'Logs', filterHint: 'filter by event type prefix, e.g. scan. install. route.', empty: 'No events match.',
  columns: [{ title: '#', width: 5, right: true }, { title: 'Time', width: 8 }, { title: 'Event', width: 26 }, { title: 'Via', width: 5, optional: true }, { title: 'Subject', width: 0 }],
  async load(api, f) {
    const ev = await api.call('system.events', { limit: 300, type: f || undefined });
    return ev.map((e: any) => ({ id: String(e.id), raw: e, cells: [dim(e.id), mid(e.ts.slice(11, 19)), { t: e.type, c: /fail|blocked|rejected/.test(e.type) ? 'warn' : 'fg' } as Seg, mid(e.origin ?? ''), mid(e.subject ?? '')] }));
  },
  inspect: async (_api, item) => [H(item.raw.type), KV('id', item.raw.id), KV('time', item.raw.ts), KV('via', item.raw.origin), KV('subject', item.raw.subject), BLANK, H('Payload'), ...JSON.stringify(item.raw.payload ?? {}, null, 2).split('\n').map((l) => P(l, 'mid'))],
  actions: () => [],
};
