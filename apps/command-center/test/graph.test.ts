import { describe, expect, it } from 'vitest';
import { type GNode, layoutGraph } from '../src/graph';

const DOMAINS = ['frontend', 'backend', 'database', 'devops', 'security', 'docs', 'testing', 'data', 'design', 'ai', 'mobile', 'finance', 'general', 'automation', 'cloud', 'research', 'product', 'legal'];
const nodes = (n: number): GNode[] => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `cap-${i}`, domain: DOMAINS[(i * 7) % DOMAINS.length], kind: 'skill', status: i % 5 ? 'registered' : 'approved', quality: (i * 37) % 100 }));

describe('capability graph layout', () => {
  it('is deterministic, keeps clusters apart and every node inside its cluster', () => {
    const a = layoutGraph(nodes(1000));
    const b = layoutGraph(nodes(1000));
    expect([...a.pos]).toEqual([...b.pos]);
    for (let i = 0; i < a.clusters.length; i++) for (let k = i + 1; k < a.clusters.length; k++) {
      const [p, q] = [a.clusters[i], a.clusters[k]];
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(p.r + q.r);
    }
    const byId = new Map(nodes(1000).map((n) => [n.id, n]));
    for (const [id, p] of a.pos) {
      const c = a.clusters.find((x) => x.domain === byId.get(id)!.domain)!;
      expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeLessThanOrEqual(c.r);
    }
  });

  it('lays out 10,000 capabilities quickly enough to stay interactive', () => {
    const t = performance.now();
    const r = layoutGraph(nodes(10_000));
    const ms = performance.now() - t;
    expect(r.pos.size).toBe(10_000);
    expect(ms).toBeLessThan(500);
  });
});
