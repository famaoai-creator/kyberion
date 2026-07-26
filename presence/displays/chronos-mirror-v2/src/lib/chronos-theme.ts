export type ChronosThemeMode = 'system' | 'light' | 'dark';

/** The modes exposed by the Chronos header control, in cycle order. */
export const CHRONOS_THEME_CYCLE: ChronosThemeMode[] = ['system', 'light', 'dark'];

export function nextChronosThemeMode(current: ChronosThemeMode): ChronosThemeMode {
  const index = CHRONOS_THEME_CYCLE.indexOf(current);
  // Unknown stored values land on the first supported mode.
  if (index < 0) return CHRONOS_THEME_CYCLE[0];
  return CHRONOS_THEME_CYCLE[(index + 1) % CHRONOS_THEME_CYCLE.length];
}

/** Resolve the stored preference to the palette actually rendered. */
export function resolveChronosThemeMode(
  mode: ChronosThemeMode,
  systemPrefersDark: boolean
): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemPrefersDark ? 'dark' : 'light';
}
