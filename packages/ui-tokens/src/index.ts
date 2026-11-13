/**
 * Synaptome design tokens: the single source for the Web Command Center (as CSS custom properties) and the Terminal
 * Workbench (as its colour palette). "Ledger": paper and graphite, hairline rules, one bronze accent.
 */

export type ThemeName = 'light' | 'dark';

export interface Palette {
  paper: string;
  surface: string;
  sunken: string;
  raised: string;
  ink: string;
  ink2: string;
  ink3: string;
  rule: string;
  ruleStrong: string;
  accent: string;
  accentInk: string;
  accentWash: string;
  ok: string;
  warn: string;
  danger: string;
  info: string;
  okWash: string;
  warnWash: string;
  dangerWash: string;
  select: string;
  focus: string;
  shadow: string;
}

export const PALETTES: Record<ThemeName, Palette> = {
  light: {
    paper: '#f6f3ec', surface: '#fbf9f4', sunken: '#efebe1', raised: '#ffffff',
    ink: '#1f1d1a', ink2: '#55514a', ink3: '#655f55',
    rule: '#dcd6c8', ruleStrong: '#b9b2a1',
    accent: '#8a5a2b', accentInk: '#6e4520', accentWash: '#efe4d3',
    ok: '#55682f', warn: '#7d5508', danger: '#8c2f2a', info: '#3f5566',
    okWash: '#e6ead7', warnWash: '#f2e6c8', dangerWash: '#f1dcd8',
    select: '#e9e1cf', focus: '#8a5a2b',
    shadow: '0 1px 0 rgba(31,29,26,.04), 0 8px 24px rgba(31,29,26,.10)',
  },
  dark: {
    paper: '#171614', surface: '#1d1c19', sunken: '#121110', raised: '#262420',
    ink: '#e9e4d8', ink2: '#b6af9f', ink3: '#9c9587',
    rule: '#33302a', ruleStrong: '#4c483f',
    accent: '#c9925a', accentInk: '#dba873', accentWash: '#2e261c',
    ok: '#9fae72', warn: '#d2a24c', danger: '#d57f74', info: '#93abbc',
    okWash: '#23281a', warnWash: '#2c2515', dangerWash: '#2e1c19',
    select: '#2d2a23', focus: '#c9925a',
    shadow: '0 1px 0 rgba(0,0,0,.3), 0 10px 30px rgba(0,0,0,.45)',
  },
};

export const SPACE = { s1: 4, s2: 8, s3: 12, s4: 16, s5: 24, s6: 32, s7: 48 };
export const TYPE = { xs: 11, sm: 12, base: 13, md: 14, lg: 16, xl: 20, '2xl': 28 };
export const FONTS = {
  display: '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif',
  ui: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", sans-serif',
  mono: '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, "SF Mono", Menlo, monospace',
};

/** paper -> --paper, ink2 -> --ink-2, ruleStrong -> --rule-strong, accentInk -> --accent-ink */
export const cssName = (k: string) => `--${k.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase()}`;
const varsOf = (p: Palette) => Object.entries(p).map(([k, v]) => `${cssName(k)}: ${v};`).join(' ');

/** CSS custom properties for both themes: explicit choice via data-theme, otherwise the system preference. */
export function tokensCss(): string {
  return [
    `:root { --font-display: ${FONTS.display}; --font-ui: ${FONTS.ui}; --font-mono: ${FONTS.mono}; ${Object.entries(SPACE).map(([k, v]) => `--${k}: ${v}px;`).join(' ')} ${Object.entries(TYPE).map(([k, v]) => `--t-${k}: ${v}px;`).join(' ')} --radius: 2px; --row: 30px; --ease: cubic-bezier(.2,.7,.2,1); }`,
    `:root, :root[data-theme="light"] { ${varsOf(PALETTES.light)} }`,
    `:root[data-theme="dark"] { ${varsOf(PALETTES.dark)} }`,
    `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { ${varsOf(PALETTES.dark)} } }`,
  ].join('\n');
}

/** The terminal palette is a projection of the same tokens. */
export function terminalPalette(theme: ThemeName) {
  const p = PALETTES[theme];
  return { bg: p.paper, fg: p.ink, mid: p.ink2, dim: p.ink3, accent: p.accent, ok: p.ok, warn: p.warn, danger: p.danger, sel: p.select, rule: p.ruleStrong };
}

/* ---------- contrast (WCAG 2.x) ---------- */

function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Every text colour on every background it is drawn on, against the WCAG AA minimum for normal text (4.5:1). */
export function contrastReport(theme: ThemeName) {
  const p = PALETTES[theme];
  const texts: (keyof Palette)[] = ['ink', 'ink2', 'ink3', 'accent', 'accentInk', 'ok', 'warn', 'danger', 'info'];
  const grounds: (keyof Palette)[] = ['paper', 'surface', 'sunken', 'raised', 'select'];
  return texts.flatMap((t) => grounds.map((g) => ({ text: t, ground: g, ratio: Number(contrast(p[t], p[g]).toFixed(2)), pass: contrast(p[t], p[g]) >= 4.5 })));
}
