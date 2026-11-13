/** Minimal front-matter reader for SKILL.md / agent files (YAML subset: scalars, folded blocks, lists). */
export function parseFrontmatter(md: string): { data: Record<string, any>; body: string; hasFrontmatter: boolean } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  if (!m) return { data: {}, body: md, hasFrontmatter: false };
  const data: Record<string, any> = {};
  const lines = m[1].split(/\r?\n/);
  const unq = (s: string) => {
    const t = s.trim();
    return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
  };
  let i = 0;
  while (i < lines.length) {
    const km = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(lines[i]);
    if (!km) {
      i++;
      continue;
    }
    const key = km[1];
    const val = km[2].trim();
    let k = i + 1;
    if (val === '') {
      const items: string[] = [];
      while (k < lines.length && /^\s*-\s+/.test(lines[k])) items.push(unq(lines[k++].replace(/^\s*-\s+/, '')));
      if (!items.length) {
        const nested: string[] = [];
        while (k < lines.length && /^\s+\S/.test(lines[k])) nested.push(lines[k++].trim());
        data[key] = nested.join('\n');
      } else data[key] = items;
    } else if (/^[>|][+-]?$/.test(val)) {
      const buf: string[] = [];
      while (k < lines.length && (/^\s+/.test(lines[k]) || lines[k] === '')) buf.push(lines[k++].trim());
      data[key] = (val[0] === '>' ? buf.join(' ') : buf.join('\n')).trim();
    } else if (/^\[.*\]$/.test(val)) {
      data[key] = val.slice(1, -1).split(',').map(unq).filter(Boolean);
    } else data[key] = unq(val);
    i = k;
  }
  return { data, body: md.slice(m[0].length), hasFrontmatter: true };
}

/** Rough context cost: ~4 characters per token. Labelled as an estimate wherever shown. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Jaccard similarity over two token sets. */
export function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
