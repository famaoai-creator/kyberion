import { describe, expect, it } from 'vitest';

import {
  CHRONOS_THEME_CYCLE,
  nextChronosThemeMode,
  resolveChronosThemeMode,
} from './chronos-theme';

describe('chronos theme mode', () => {
  it('follows the operating system for the system preference', () => {
    expect(resolveChronosThemeMode('system', false)).toBe('light');
    expect(resolveChronosThemeMode('system', true)).toBe('dark');
  });

  it('honors an explicit dark choice', () => {
    expect(resolveChronosThemeMode('dark', false)).toBe('dark');
    expect(resolveChronosThemeMode('dark', true)).toBe('dark');
  });

  it('still resolves an explicit light choice, so the path stays testable', () => {
    expect(resolveChronosThemeMode('light', true)).toBe('light');
  });

  it('offers both light and dark in the header cycle', () => {
    expect(CHRONOS_THEME_CYCLE).toContain('light');
    expect(CHRONOS_THEME_CYCLE).toContain('dark');
  });

  it('cycles through the supported modes and returns to the start', () => {
    let mode = CHRONOS_THEME_CYCLE[0];
    const seen = [mode];
    for (let step = 0; step < CHRONOS_THEME_CYCLE.length; step += 1) {
      mode = nextChronosThemeMode(mode);
      seen.push(mode);
    }
    expect(seen[seen.length - 1]).toBe(CHRONOS_THEME_CYCLE[0]);
    expect(new Set(seen).size).toBe(CHRONOS_THEME_CYCLE.length);
  });

  it('keeps explicit light in the cycle', () => {
    expect(nextChronosThemeMode('light')).toBe('dark');
  });
});
