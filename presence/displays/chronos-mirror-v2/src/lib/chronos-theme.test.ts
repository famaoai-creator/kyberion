import { describe, expect, it } from 'vitest';

import {
  CHRONOS_THEME_CYCLE,
  nextChronosThemeMode,
  resolveChronosThemeMode,
} from './chronos-theme';

describe('chronos theme mode', () => {
  it('never resolves `system` to the light palette', () => {
    // Regression: `system` followed prefers-color-scheme, so every operator on
    // a light-mode OS opened the console into the light path without choosing
    // it — and the component layer is dark-only, so that path is unreadable.
    expect(resolveChronosThemeMode('system', false)).toBe('dark');
    expect(resolveChronosThemeMode('system', true)).toBe('dark');
  });

  it('honors an explicit dark choice', () => {
    expect(resolveChronosThemeMode('dark', false)).toBe('dark');
    expect(resolveChronosThemeMode('dark', true)).toBe('dark');
  });

  it('still resolves an explicit light choice, so the path stays testable', () => {
    expect(resolveChronosThemeMode('light', true)).toBe('light');
  });

  it('does not offer light in the header cycle', () => {
    expect(CHRONOS_THEME_CYCLE).not.toContain('light');
    expect(CHRONOS_THEME_CYCLE.length).toBeGreaterThan(1);
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

  it('recovers from a withdrawn mode left in localStorage', () => {
    // Someone who picked 'light' before it was withdrawn must not get stuck
    // outside the cycle.
    expect(nextChronosThemeMode('light')).toBe(CHRONOS_THEME_CYCLE[0]);
  });
});
