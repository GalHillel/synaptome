import type { Api } from '@synaptome/service';
import { type ViewDef, type Action, type Item, type Line, UNICODE, mark, dim, mid, strong, H, P, KV, BLANK } from '../kit';

/**
 * Network: the capability graph as text. Domains form a tree (expand one to list its capabilities); a capability's
 * inspector lists its links (declared relations and "used together" evidence from routing), and its actions jump to
 * a linked capability. Same data as the Web graph (`graph.get`), so the two never disagree.
 */

interface Node { id: string; name: string; domain: string; kind: string; status: string; quality: number | null }
interface Edge { src: string; dst: string; rel: string; weight: number }
interface Graph { nodes: Node[]; edges: Edge[]; byId: Map<string, Node>; adj: Map<string, { other: string; rel: string; weight: number }[]> }
interface State { expanded: Set<string>; focus: string | null; graph: Graph | null }
interface Link { rel: string; weight: number; node: Node }

const OPEN = UNICODE ? '▾' : '-';
const CLOSED = UNICODE ? '▸' : '+';
const states = new WeakMap<object, State>();
const stateOf = (api: Api) => {
  let s = states.get(api.sys);
  if (!s) states.set(api.sys, (s = { expanded: new Set(), focus: null, graph: null }));
  return s;
};

async function loadGraph(api: Api): Promise<Graph> {
  const g = await api.call('graph.get');
  const byId = new Map<string, Node>(g.nodes.map((n: Node) => [n.id, n]));
  const adj = new Map<string, { other: string; rel: string; weight: number }[]>();
  const push = (a: string, b: string, e: Edge) => (adj.get(a) ?? adj.set(a, []).get(a)!).push({ other: b, rel: e.rel, weight: e.weight });
  for (const e of g.edges as Edge[]) (push(e.src, e.dst, e), push(e.dst, e.src, e));
  for (const l of adj.values()) l.sort((x, y) => y.weight - x.weight || x.other.localeCompare(y.other));
  return { nodes: g.nodes, edges: g.edges, byId, adj };
}

const degree = (g: Graph, id: string) => g.adj.get(id)?.length ?? 0;

export const view: ViewDef = {
  id: 'network', title: 'Network', filterHint: 'filter by capability or domain name', empty: 'The graph is empty: no capabilities are registered yet.',
  columns: [{ title: 'Domain / capability', width: 0 }, { title: 'Status', width: 17 }, { title: 'Links', width: 6, right: true }, { title: 'Kind', width: 10, optional: true }],
  async load(api, f) {
    const st = stateOf(api);
    const g = (st.graph = await loadGraph(api));
    const q = f.toLowerCase();
    const domains = new Map<string, Node[]>();
    for (const n of g.nodes) (domains.get(n.domain) ?? domains.set(n.domain, []).get(n.domain)!).push(n);
    const rows: Item[] = [];
    for (const [d, list] of [...domains].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
      const hits = q ? list.filter((n) => `${n.name} ${n.id} ${d}`.toLowerCase().includes(q)) : list;
      if (!hits.length) continue;
      // A filter opens every domain that has a match, so the matches are visible without extra keys.
      const open = !!q || st.expanded.has(d);
      const links = list.reduce((n, x) => n + degree(g, x.id), 0);
      rows.push({ id: `d:${d}`, raw: { type: 'domain', domain: d, nodes: list, links }, cells: [strong(`${open ? OPEN : CLOSED} ${d}`), dim(`${list.length} capabilit${list.length === 1 ? 'y' : 'ies'}`), String(links), dim('domain')] });
      if (open)
        for (const n of hits.sort((a, b) => degree(g, b.id) - degree(g, a.id) || a.name.localeCompare(b.name))) {
          const links: Link[] = (g.adj.get(n.id) ?? []).map((l) => ({ rel: l.rel, weight: l.weight, node: g.byId.get(l.other)! }));
          rows.push({ id: `c:${n.id}`, raw: { type: 'node', ...n, links }, cells: [{ t: `    ${n.name}` }, mark(n.status), String(links.length), mid(n.kind)] });
        }
    }
    return rows;
  },
  takeFocus(api) {
    const st = stateOf(api);
    const f = st.focus;
    st.focus = null;
    return f;
  },
  async inspect(api, item) {
    const g = stateOf(api).graph ?? (await loadGraph(api));
    if (item.raw.type === 'domain') {
      const { domain, nodes } = item.raw as { domain: string; nodes: Node[] };
      const inDomain = new Set(nodes.map((n) => n.id));
      const toDomain = new Map<string, number>();
      let internal = 0;
      for (const n of nodes) for (const l of g.adj.get(n.id) ?? []) {
        const o = g.byId.get(l.other);
        if (!o) continue;
        if (inDomain.has(o.id)) internal += l.weight / 2;
        else toDomain.set(o.domain, (toDomain.get(o.domain) ?? 0) + l.weight);
      }
      const byStatus = nodes.reduce<Record<string, number>>((m, n) => ((m[n.status] = (m[n.status] ?? 0) + 1), m), {});
      return [
        [strong(domain)], P(`${nodes.length} capabilit${nodes.length === 1 ? 'y' : 'ies'}`, 'dim'), BLANK,
        ...Object.entries(byStatus).map(([s, n]) => [mark(s), { t: `  ${n}`, c: 'mid' }] as Line),
        BLANK, KV('links inside', Math.round(internal)),
        BLANK, H('Linked domains'),
        ...([...toDomain].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([d, w]) => P(`${String(Math.round(w)).padStart(4)}  ${d}`, 'mid')) as Line[]),
        ...(toDomain.size ? [] : [P('No links to other domains.', 'mid')]),
      ];
    }
    const n: Node & { links: Link[] } = item.raw;
    const byRel = new Map<string, Link[]>();
    for (const l of n.links) (byRel.get(l.rel) ?? byRel.set(l.rel, []).get(l.rel)!).push(l);
    return [
      [strong(n.name)], P(n.id, 'dim'), BLANK, [mark(n.status), { t: `   ${n.kind} in ${n.domain}`, c: 'mid' }], KV('quality', n.quality ?? 'not scored'),
      BLANK, H(`Links ${n.links.length}`),
      ...(n.links.length ? [] : [P('No declared relations and never chosen together with another capability.', 'mid')]),
      ...[...byRel].flatMap(([rel, ls]) => [[{ t: rel, c: 'accent' }, { t: `  ${ls.length}`, c: 'dim' }] as Line, ...ls.slice(0, 20).map((l) => [{ t: `  ${String(l.weight).padStart(3)}  `, c: 'dim' }, { t: l.node.name }, { t: l.node.domain === n.domain ? '' : `  (${l.node.domain})`, c: 'dim' }] as Line)]),
      ...(n.links.length ? [BLANK, P('a: jump to a linked capability', 'dim')] : []),
    ];
  },
  actions(item) {
    if (!item) return [];
    if (item.raw.type === 'domain') {
      const d = item.raw.domain as string;
      return [{ label: 'Expand or collapse', hint: d, run: async (api) => { const st = stateOf(api); if (st.expanded.has(d)) st.expanded.delete(d); else st.expanded.add(d); st.focus = item.id; return `${d} ${st.expanded.has(d) ? 'expanded' : 'collapsed'}`; } }];
    }
    const n: Node & { links: Link[] } = item.raw;
    const jumps: Action[] = n.links.slice(0, 30).map((l) => ({
      label: `Go to ${l.node.name}`, hint: `${l.rel}${l.node.domain === n.domain ? '' : `, ${l.node.domain}`}`,
      run: async (api) => { const st = stateOf(api); st.expanded.add(l.node.domain); st.focus = `c:${l.node.id}`; return `at ${l.node.name}`; },
    }));
    return [...jumps, { label: 'Collapse this domain', hint: n.domain, run: async (api) => { const st = stateOf(api); st.expanded.delete(n.domain); st.focus = `d:${n.domain}`; return `${n.domain} collapsed`; } }];
  },
};
