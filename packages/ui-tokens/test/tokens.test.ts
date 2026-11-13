import { describe, expect, it } from 'vitest';
import { PALETTES, contrast, contrastReport, cssName, terminalPalette, tokensCss } from '../src/index';

describe('design tokens', () => {
  it('every text colour meets WCAG AA (4.5:1) on every background, in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const failing = contrastReport(theme).filter((r) => !r.pass);
      expect(failing, `${theme}: ${JSON.stringify(failing)}`).toEqual([]);
    }
  });

  it('computes contrast as WCAG defines it', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });

  it('emits CSS for both themes and the system preference, with the names the stylesheet uses', () => {
    const css = tokensCss();
    expect(cssName('ink2')).toBe('--ink-2');
    expect(cssName('ruleStrong')).toBe('--rule-strong');
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(`--ink-3: ${PALETTES.light.ink3};`);
    expect(css).toContain('--t-base: 13px;');
  });

  it('gives the terminal the same colours as the web', () => {
    expect(terminalPalette('dark')).toMatchObject({ bg: PALETTES.dark.paper, fg: PALETTES.dark.ink, accent: PALETTES.dark.accent });
  });
});
