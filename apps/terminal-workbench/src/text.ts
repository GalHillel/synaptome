import stringWidth from 'string-width';
import type { Line } from './kit';

/* ---------- width-safe text helpers (wide and combining characters included) ---------- */

export function clip(text: string, width: number): string {
  if (width <= 0) return '';
  const clean = text.replace(/[\r\n\t]+/g, ' ');
  if (stringWidth(clean) <= width) return clean;
  let out = '';
  let w = 0;
  for (const ch of clean) {
    const cw = stringWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}
export const pad = (text: string, width: number, right = false) => {
  const t = clip(text, width);
  const gap = ' '.repeat(Math.max(0, width - stringWidth(t)));
  return right ? gap + t : t + gap;
};
/** Fits a styled line into exactly `width` cells. */
export function fitLine(line: Line, width: number): Line {
  const out: Line = [];
  let left = width;
  for (const s of line) {
    if (left <= 0) break;
    const t = clip(s.t, left);
    out.push({ ...s, t });
    left -= stringWidth(t);
  }
  if (left > 0) out.push({ t: ' '.repeat(left) });
  return out;
}
/** Word-wraps a styled line; continuation lines keep the style of the segment being wrapped. */
export function wrapLine(line: Line, width: number): Line[] {
  const rows: Line[] = [[]];
  let used = 0;
  for (const seg of line) {
    for (const word of seg.t.split(/(\s+)/)) {
      if (!word) continue;
      let w = word;
      while (stringWidth(w) > width) {
        const head = clip(w, width - used > 4 ? width - used : width).replace(/…$/, '');
        if (!head) break;
        if (used + stringWidth(head) > width) (rows.push([]), (used = 0));
        rows[rows.length - 1].push({ ...seg, t: head });
        rows.push([]);
        used = 0;
        w = w.slice(head.length);
      }
      if (used + stringWidth(w) > width) {
        rows.push([]);
        used = 0;
        if (!w.trim()) continue;
      }
      rows[rows.length - 1].push({ ...seg, t: w });
      used += stringWidth(w);
    }
  }
  return rows;
}
