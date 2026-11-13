import { terminalPalette } from '@synaptome/ui-tokens';
import type { Tone } from './kit';

/* ---------- themes: restrained paper/graphite, never neon ---------- */

export type Palette = Record<Tone, string> & { bg?: string; sel: string; rule: string };
export const THEMES: Record<string, Palette> = {
  dark: terminalPalette('dark'),
  light: terminalPalette('light'),
  // "auto" keeps the terminal's own background and uses colours that read on dark and light alike.
  auto: { fg: '', mid: '', dim: 'gray', accent: 'yellow', ok: 'green', warn: 'yellow', danger: 'red', sel: '', rule: 'gray' },
};
export const NO_COLOR = !!process.env.NO_COLOR;
