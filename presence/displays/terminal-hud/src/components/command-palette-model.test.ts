import { describe, expect, it } from 'vitest';
import { makeI18n } from '../i18n.js';
import { PANELS } from '../keymap.js';
import { filterPalette, navigationPalette } from './command-palette-model.js';

describe('navigation palette discovery', () => {
  it('finds every panel by stable id and translates the displayed labels', () => {
    const catalog = navigationPalette(makeI18n('ja'));
    for (const panel of PANELS) {
      expect(filterPalette(catalog, panel).some((entry) => entry.id === `panel:${panel}`)).toBe(
        true
      );
    }
    expect(filterPalette(catalog, 'タスク')[0]?.selection).toEqual({
      kind: 'panel',
      panel: 'tasks',
    });
    expect(filterPalette(catalog, 'ＡＧＥＮＴＳ')[0]?.selection).toEqual({
      kind: 'panel',
      panel: 'agents',
    });
  });

  it('finds connection management without offering auth or mutation commands', () => {
    const catalog = navigationPalette(makeI18n('en'));
    expect(filterPalette(catalog, 'services accounts')[0]?.selection).toEqual({
      kind: 'connections',
    });
    expect(
      catalog.every((entry) =>
        ['panel', 'connections', 'refresh', 'help'].includes(entry.selection.kind)
      )
    ).toBe(true);
    expect(filterPalette(catalog, 'not-a-real-command')).toEqual([]);
  });
});
