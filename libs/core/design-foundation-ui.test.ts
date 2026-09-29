import { describe, expect, it } from 'vitest';
import { loadBrandTokensAtPath } from './brand-tokens.js';
import { contrastRatio, listDesignStyles, loadDesignFoundation } from './design-foundation.js';
import { deriveStyleUiOverride, ensureContrast, mixHex } from './design-foundation-ui.js';

const foundation = loadDesignFoundation()!;
const ui = loadBrandTokensAtPath().tokens.ui!;
const styles = listDesignStyles(foundation).filter((style) => style.colors);

describe('KDS v2 Surface palette derivation', () => {
  it('ensureContrast keeps a passing colour and pushes a failing one to the floor', () => {
    expect(ensureContrast('#000000', ['#ffffff'], 4.5)).toBe('#000000');
    const pushed = ensureContrast('#9ab0d0', ['#ffffff'], 4.5);
    expect(contrastRatio(pushed, '#ffffff')!).toBeGreaterThanOrEqual(4.5);
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('is deterministic', () => {
    const style = styles[0];
    expect(deriveStyleUiOverride(ui, foundation, style, 'light')).toEqual(
      deriveStyleUiOverride(ui, foundation, style, 'light')
    );
  });

  for (const style of styles) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${style.id}/${mode}: text 4.5:1, borders/focus 3:1, accent fill carries its ink`, () => {
        const { palette } = deriveStyleUiOverride(ui, foundation, style, mode)!;
        for (const surface of ['canvas', 'surface', 'surface-raised', 'surface-sunken'] as const) {
          for (const text of ['text', 'text-muted', 'text-subtle', 'accent-text'] as const) {
            expect(
              contrastRatio(palette[text], palette[surface]),
              `${text} on ${surface}`
            ).toBeGreaterThanOrEqual(4.5);
          }
          for (const edge of ['border-strong', 'focus-ring', 'accent'] as const) {
            expect(
              contrastRatio(palette[edge], palette[surface]),
              `${edge} on ${surface}`
            ).toBeGreaterThanOrEqual(3);
          }
        }
        expect(contrastRatio(palette['text-on-accent'], palette.accent)!).toBeGreaterThanOrEqual(
          4.5
        );
        expect(
          contrastRatio(palette['text-on-accent'], palette['accent-hover'])!
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('never restyles the meaning of status colours: same keys, only lightness moves', () => {
    const { palette } = deriveStyleUiOverride(ui, foundation, styles[0], 'light')!;
    expect(Object.keys(palette.status)).toEqual(Object.keys(ui.light.status));
    expect(palette.status.danger.bg).toBe(ui.light.status.danger.bg);
    expect(palette.status.danger.border).toBe(ui.light.status.danger.border);
  });

  it('surface gradient is opt-in, and its stops keep the button ink at 4.5:1', () => {
    for (const style of styles) {
      for (const mode of ['light', 'dark'] as const) {
        const override = deriveStyleUiOverride(ui, foundation, style, mode)!;
        if (!style.surface_gradient) {
          expect(override.gradientAccent).toBe('none');
          continue;
        }
        expect(override.gradientAccent).toMatch(/^linear-gradient\(/);
        for (const stop of override.gradientAccent.match(/#[0-9a-f]{6}/giu) ?? []) {
          expect(contrastRatio(override.palette['text-on-accent'], stop)!).toBeGreaterThanOrEqual(
            4.5
          );
        }
      }
    }
    expect(styles.filter((style) => style.surface_gradient).map((style) => style.id)).toEqual([
      'aurora',
    ]);
  });

  it('radius steps around the style radius', () => {
    const editorial = deriveStyleUiOverride(
      ui,
      foundation,
      styles.find((s) => s.id === 'editorial')!,
      'light'
    )!;
    expect(editorial.radius.md).toBe(foundation.scales.radius.xs);
    const aurora = deriveStyleUiOverride(
      ui,
      foundation,
      styles.find((s) => s.id === 'aurora')!,
      'light'
    )!;
    expect(aurora.radius.md).toBe(foundation.scales['radius']['2xl']);
  });
});
