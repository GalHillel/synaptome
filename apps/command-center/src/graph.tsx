import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Empty, Loaded, PageHeader, useApp, useQuery } from './lib';

/* =====================================================================
 * Capability graph. Clusters by domain, nodes on a phyllotaxis spiral inside each cluster (deterministic, linear in
 * the number of nodes, so 10k stays responsive). Zoomed out it draws clusters only; zoomed in, nodes, edges and labels.
 * Edges: explicit relations and "used together" (selected for the same task by the router).
 * ===================================================================== */

export interface GNode { id: string; name: string; domain: string; kind: string; status: string; quality: number | null }
export interface GEdge { src: string; dst: string; rel: string; weight: number }
export interface Cluster { domain: string; x: number; y: number; r: number; count: number; approved: number }

const SPACING = 7;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Positions for every node and cluster. Pure and deterministic. */
export function layoutGraph(nodes: GNode[]): { clusters: Cluster[]; pos: Map<string, { x: number; y: number }> } {
  const groups = new Map<string, GNode[]>();
  for (const n of nodes) groups.set(n.domain || 'general', [...(groups.get(n.domain || 'general') ?? []), n]);
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const clusters: Cluster[] = [];
  const pos = new Map<string, { x: number; y: number }>();
  for (const [domain, members] of sorted) {
    const r = SPACING * Math.sqrt(members.length) + 18;
    // Place along an outward spiral at the first spot that does not overlap an earlier cluster.
    let x = 0;
    let y = 0;
    for (let t = 0; clusters.length; t += 0.35) {
      const d = 40 + t * 9;
      x = Math.cos(t) * d;
      y = Math.sin(t) * d;
      if (clusters.every((c) => Math.hypot(c.x - x, c.y - y) > c.r + r + 14)) break;
    }
    clusters.push({ domain, x, y, r, count: members.length, approved: members.filter((m) => m.status === 'approved').length });
    members
      .slice()
      .sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || a.id.localeCompare(b.id))
      .forEach((m, k) => pos.set(m.id, { x: x + Math.cos(k * GOLDEN) * SPACING * Math.sqrt(k + 0.5), y: y + Math.sin(k * GOLDEN) * SPACING * Math.sqrt(k + 0.5) }));
  }
  return { clusters, pos };
}

const STATUS_COLOR: Record<string, string> = { approved: '--accent', registered: '--ink-3', blocked: '--danger', deprecated: '--rule-strong', rejected: '--rule-strong' };

export function Graph() {
  const { open } = useApp();
  const [statuses, setStatuses] = useState<string[]>(['approved', 'registered']);
  const q = useQuery('graph.get', { statuses }, { live: false });
  const [table, setTable] = useState(false);
  const toggle = (s: string) => setStatuses((xs) => (xs.includes(s) ? xs.filter((x) => x !== s) : [...xs, s]));
  return (
    <>
      <PageHeader title="Capability Graph" actions={<Button kind="quiet" onClick={() => setTable((t) => !t)}>{table ? 'Show graph' : 'Show as table'}</Button>}>
        Capabilities grouped by domain. Lines join capabilities related to each other or chosen together for the same task. Scroll to zoom, drag to move, click to select.
      </PageHeader>
      <fieldset className="filters">
        <legend className="sr-only">Show capabilities that are</legend>
        {['approved', 'registered', 'blocked', 'deprecated'].map((s) => (
          <label key={s}><input type="checkbox" checked={statuses.includes(s)} onChange={() => toggle(s)} /> {s}</label>
        ))}
      </fieldset>
      <Loaded q={q} rows={8}>
        {(g: { nodes: GNode[]; edges: GEdge[] }) => (!g.nodes.length ? <Empty title="Nothing to draw">Choose at least one status above.</Empty> : table ? <GraphTable g={g} onOpen={(id) => open({ type: 'capability', id })} /> : <GraphCanvas g={g} onOpen={(id) => open({ type: 'capability', id })} />)}
      </Loaded>
    </>
  );
}

function GraphTable({ g, onOpen }: { g: { nodes: GNode[]; edges: GEdge[] }; onOpen(id: string): void }) {
  const { clusters } = useMemo(() => layoutGraph(g.nodes), [g]);
  return (
    <div className="graph-table">
      {clusters.map((c) => (
        <details key={c.domain}>
          <summary><span className="name">{c.domain}</span> <span className="num muted">{c.count} capabilities · {c.approved} approved</span></summary>
          <ul>
            {g.nodes.filter((n) => (n.domain || 'general') === c.domain).slice(0, 200).map((n) => (
              <li key={n.id}><button className="linkish" onClick={() => onOpen(n.id)}>{n.name}</button> <span className="faint">{n.kind} · {n.status}</span></li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

function GraphCanvas({ g, onOpen }: { g: { nodes: GNode[]; edges: GEdge[] }; onOpen(id: string): void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ scale: 0.9, tx: 0, ty: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [drawMs, setDrawMs] = useState(0);
  const { clusters, pos } = useMemo(() => layoutGraph(g.nodes), [g]);
  const byId = useMemo(() => new Map(g.nodes.map((n) => [n.id, n])), [g]);
  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of g.edges) {
      if (!m.has(e.src)) m.set(e.src, new Set());
      if (!m.has(e.dst)) m.set(e.dst, new Set());
      m.get(e.src)!.add(e.dst);
      m.get(e.dst)!.add(e.src);
    }
    return m;
  }, [g]);
  // Spatial grid for click hit-testing in constant time.
  const grid = useMemo(() => {
    const cell = 12;
    const m = new Map<string, string[]>();
    for (const [id, p] of pos) {
      const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
      m.set(k, [...(m.get(k) ?? []), id]);
    }
    return { cell, m };
  }, [pos]);
  const matches = useMemo(() => {
    const s = search.trim().toLowerCase();
    return s ? new Set(g.nodes.filter((n) => n.name.toLowerCase().includes(s) || n.id.toLowerCase().includes(s)).map((n) => n.id)) : null;
  }, [search, g]);

  // Centre on first render.
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    setView((v) => ({ ...v, tx: c.clientWidth / 2, ty: c.clientHeight / 2 }));
  }, []);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const t0 = performance.now();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const hgt = c.clientHeight;
    if (c.width !== w * dpr || c.height !== hgt * dpr) {
      c.width = w * dpr;
      c.height = hgt * dpr;
    }
    const ctx = c.getContext('2d')!;
    const css = getComputedStyle(c);
    const col = (v: string) => css.getPropertyValue(v).trim() || '#888';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    ctx.translate(view.tx, view.ty);
    ctx.scale(view.scale, view.scale);
    const detail = view.scale >= 0.35;
    // Only what is on screen is drawn, so cost follows what is visible, not the size of the registry.
    const pad = 20 / view.scale;
    const vx0 = -view.tx / view.scale - pad;
    const vy0 = -view.ty / view.scale - pad;
    const vx1 = (w - view.tx) / view.scale + pad;
    const vy1 = (hgt - view.ty) / view.scale + pad;
    const visible = (p: { x: number; y: number }) => p.x >= vx0 && p.x <= vx1 && p.y >= vy0 && p.y <= vy1;
    // clusters
    for (const cl of clusters) {
      ctx.beginPath();
      ctx.arc(cl.x, cl.y, cl.r, 0, Math.PI * 2);
      ctx.strokeStyle = col('--rule');
      ctx.lineWidth = 1 / view.scale;
      ctx.stroke();
      if (!detail) {
        ctx.fillStyle = col('--sunken');
        ctx.fill();
      }
    }
    if (detail) {
      // edges: all when zoomed in, otherwise only the selection's
      const focus = selected ? neighbours.get(selected) ?? new Set<string>() : null;
      ctx.lineWidth = 0.6 / view.scale;
      for (const e of g.edges) {
        const touching = selected && (e.src === selected || e.dst === selected);
        if (!touching && view.scale < 1.2) continue;
        const a = pos.get(e.src);
        const b = pos.get(e.dst);
        if (!a || !b || (!visible(a) && !visible(b))) continue;
        ctx.strokeStyle = touching ? col('--accent') : col('--rule-strong');
        ctx.globalAlpha = touching ? 0.9 : 0.35;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // nodes
      for (const n of g.nodes) {
        const p = pos.get(n.id)!;
        if (!visible(p)) continue;
        const dim =(matches && !matches.has(n.id)) || (focus && n.id !== selected && !focus.has(n.id));
        ctx.globalAlpha = dim ? 0.18 : 1;
        ctx.fillStyle = col(STATUS_COLOR[n.status] ?? '--ink-3');
        const r = (n.id === selected ? 4.5 : matches?.has(n.id) ? 3.5 : 2.4) / Math.sqrt(view.scale);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(r, 1.2 / view.scale), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // labels (screen-space size)
    ctx.fillStyle = col('--ink-2');
    ctx.font = `${11 / view.scale}px ${col('--font-ui')}`;
    ctx.textAlign = 'center';
    for (const cl of clusters) ctx.fillText(detail ? cl.domain : `${cl.domain} ${cl.count}`, cl.x, cl.y - cl.r - 4 / view.scale);
    if (view.scale >= 2.2 || selected || (matches && matches.size <= 40)) {
      ctx.fillStyle = col('--ink');
      for (const n of g.nodes) {
        if (!(view.scale >= 2.2 || n.id === selected || matches?.has(n.id))) continue;
        const p = pos.get(n.id)!;
        if (!visible(p)) continue;
        ctx.fillText(n.name, p.x, p.y - 6 / view.scale);
      }
    }
    setDrawMs(Number((performance.now() - t0).toFixed(1)));
  }, [view, selected, matches, clusters, pos, g, neighbours]);

  const toWorld = (cx: number, cy: number) => ({ x: (cx - view.tx) / view.scale, y: (cy - view.ty) / view.scale });
  const hit = (cx: number, cy: number) => {
    const p = toWorld(cx, cy);
    let best: string | null = null;
    let bestD = 8 / view.scale;
    const gx = Math.floor(p.x / grid.cell);
    const gy = Math.floor(p.y / grid.cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const id of grid.m.get(`${gx + dx},${gy + dy}`) ?? []) {
      const q = pos.get(id)!;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) (bestD = d), (best = id);
    }
    return best;
  };
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const zoomAt = (cx: number, cy: number, f: number) => setView((v) => {
    const scale = Math.min(12, Math.max(0.08, v.scale * f));
    return { scale, tx: cx - ((cx - v.tx) * scale) / v.scale, ty: cy - ((cy - v.ty) * scale) / v.scale };
  });
  const fitTo = (ids: string[]) => {
    const c = ref.current;
    const pts = ids.map((id) => pos.get(id)).filter(Boolean) as { x: number; y: number }[];
    if (!c || !pts.length) return;
    const [minX, maxX, minY, maxY] = [Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x)), Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y))];
    const scale = Math.min(6, Math.max(0.1, 0.8 * Math.min(c.clientWidth / Math.max(40, maxX - minX), c.clientHeight / Math.max(40, maxY - minY))));
    setView({ scale, tx: c.clientWidth / 2 - ((minX + maxX) / 2) * scale, ty: c.clientHeight / 2 - ((minY + maxY) / 2) * scale });
  };
  const sel = selected ? byId.get(selected) : null;

  return (
    <div className="graph">
      <div className="graph-bar">
        <label className="sr-only" htmlFor="graph-search">Find a capability</label>
        <input id="graph-search" type="search" placeholder="Find a capability" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => {
            if (e.key !== 'Enter' || !matches?.size) return;
            // Keyboard path to a node: zoom to the results and select the first, so "Open" is one Tab away.
            fitTo([...matches]);
            setSelected([...matches][0]);
          }} />
        {matches ? <span className="muted num">{matches.size} found</span> : null}
        {matches?.size ? <Button kind="quiet" onClick={() => fitTo([...matches])}>Zoom to results</Button> : null}
        <Button kind="quiet" onClick={() => fitTo(g.nodes.map((n) => n.id))}>Fit all</Button>
        <span className="faint num graph-stats">{g.nodes.length} nodes · {g.edges.length} links · draw {drawMs} ms</span>
      </div>
      <canvas
        ref={ref}
        className="graph-canvas"
        role="img"
        aria-label={`Capability graph with ${g.nodes.length} capabilities in ${clusters.length} domains. Use “Show as table” for a list.`}
        tabIndex={0}
        onWheel={(e) => zoomAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY, e.deltaY < 0 ? 1.15 : 1 / 1.15)}
        onMouseDown={(e) => (drag.current = { x: e.clientX, y: e.clientY, moved: false })}
        onMouseMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
          d.x = e.clientX;
          d.y = e.clientY;
          setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
        }}
        onMouseUp={(e) => {
          if (drag.current && !drag.current.moved) setSelected(hit(e.nativeEvent.offsetX, e.nativeEvent.offsetY));
          drag.current = null;
        }}
        onMouseLeave={() => (drag.current = null)}
        onKeyDown={(e) => {
          const c = ref.current!;
          if (e.key === '+' || e.key === '=') zoomAt(c.clientWidth / 2, c.clientHeight / 2, 1.25);
          else if (e.key === '-') zoomAt(c.clientWidth / 2, c.clientHeight / 2, 0.8);
          else if (e.key === '0') fitTo(g.nodes.map((n) => n.id));
          else if (e.key.startsWith('Arrow')) setView((v) => ({ ...v, tx: v.tx + (e.key === 'ArrowLeft' ? 40 : e.key === 'ArrowRight' ? -40 : 0), ty: v.ty + (e.key === 'ArrowUp' ? 40 : e.key === 'ArrowDown' ? -40 : 0) }));
          else if (e.key === 'Enter' && selected) onOpen(selected);
          else return;
          e.preventDefault();
        }}
      />
      <div className="graph-legend faint">
        <span><i className="dot approved" /> approved</span> <span><i className="dot registered" /> registered</span> <span><i className="dot blocked" /> blocked</span> · keys: + − 0 arrows, Enter opens the selection
      </div>
      {sel ? (
        <div className="graph-sel" role="status">
          <span className="name">{sel.name}</span> <span className="faint">{sel.kind} · {sel.status} · {sel.domain} · {neighbours.get(sel.id)?.size ?? 0} link(s)</span>
          <Button kind="quiet" onClick={() => onOpen(sel.id)}>Open</Button>
          <Button kind="quiet" onClick={() => setSelected(null)}>Clear</Button>
        </div>
      ) : null}
    </div>
  );
}
