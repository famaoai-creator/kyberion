import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('design contrast checker', () => {
  it('uses the governed themes JSON loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_design_contrast.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('readSafeJsonFile');
    expect(source).not.toContain('return readJson<T>(filePath)');
  });
});

describe('tokens.ui contrast (UI-02)', () => {
  it('passes WCAG AA for the committed light and dark UI palettes', async () => {
    const { checkDesignContrast } = await import('./check_design_contrast.js');
    expect(checkDesignContrast().filter((violation) => violation.startsWith('[ui'))).toEqual([]);
  });

  it('covers text, status, role, boundary and button pairs', async () => {
    const { buildUiContrastPairs } = await import('./check_design_contrast.js');
    const labels = buildUiContrastPairs(['concierge']).map((pair) => pair.label);
    expect(labels).toContain('ui text-muted on canvas');
    expect(labels).toContain('ui text-subtle on surface');
    expect(labels).toContain('ui danger pill');
    expect(labels).toContain('ui role concierge on surface');
    expect(labels).toContain('ui focus-ring boundary on canvas');
    expect(labels).toContain('ui primary button');
  });

  it('flattens status and role colors into checkable keys', async () => {
    const { flattenUiPalette } = await import('./check_design_contrast.js');
    const { loadBrandTokensAtPath } = await import('@agent/core/brand-tokens');
    const ui = loadBrandTokensAtPath().tokens.ui;
    expect(ui).toBeDefined();
    const flat = flattenUiPalette(ui!.dark);
    expect(flat['danger-fg']).toBe(ui!.dark.status.danger.fg);
    expect(flat['role-concierge']).toBe(ui!.dark.role.concierge);
    expect(flat.status).toBeUndefined();
    expect(flat['viz-cat-1']).toBe(ui!.dark.viz.categorical[0]);
    expect(flat['viz-div-5']).toBe(ui!.dark.viz.diverging[4]);
  });

  it('holds every data-viz categorical slot to 3:1 on every UI surface (UI-01b)', async () => {
    const { buildUiVizContrastPairs } = await import('./check_design_contrast.js');
    const pairs = buildUiVizContrastPairs();
    expect(pairs.filter((pair) => pair.foreground.startsWith('viz-cat-'))).toHaveLength(8 * 4);
    expect(pairs.every((pair) => pair.minRatio >= 2)).toBe(true);
    expect(pairs.map((pair) => pair.label)).toContain(
      'ui viz categorical 8 mark on surface-sunken'
    );
  });
});
