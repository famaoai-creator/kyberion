export type ChronosThemeMode = 'system' | 'light' | 'dark';

/**
 * The modes the header control actually offers, in cycle order.
 *
 * `light` is deliberately absent. The shared token derivation
 * (`webThemePackToCssVars`) is theme-aware and correct, but the chronos
 * COMPONENT layer is not: ~939 text and ~650 background/border utilities
 * across `page.tsx` and `MissionIntelligence.tsx` are hardcoded dark-console
 * values (`text-white/72`, `bg-black/20`, `text-cyan-100/80`, …). Rendered on
 * a genuinely light panel they measure 1.0–1.3:1 — a 1,866-element contrast
 * failure, measured in-browser.
 *
 * Until those utilities are migrated to `--kb-*` tokens, offering a light mode
 * means offering an unreadable screen, so the console renders dark and says so.
 * → docs/developer/improvement-plans-2026-07/DS-06_CHRONOS_LIGHT_THEME.ja.md
 */
export const CHRONOS_THEME_CYCLE: ChronosThemeMode[] = ['system', 'dark'];

export function nextChronosThemeMode(current: ChronosThemeMode): ChronosThemeMode {
  const index = CHRONOS_THEME_CYCLE.indexOf(current);
  // An unknown/legacy stored value (e.g. a 'light' left in localStorage from
  // before light was withdrawn) lands on the first supported mode.
  if (index < 0) return CHRONOS_THEME_CYCLE[0];
  return CHRONOS_THEME_CYCLE[(index + 1) % CHRONOS_THEME_CYCLE.length];
}

/**
 * Resolve the stored preference to the palette actually rendered.
 *
 * `system` used to follow `prefers-color-scheme`, which meant every operator on
 * a light-mode OS opened the console straight into the unreadable light path
 * without ever choosing it. Chronos is a dark console; `system` resolves to dark
 * until the component layer supports otherwise.
 */
export function resolveChronosThemeMode(
  mode: ChronosThemeMode,
  _systemPrefersDark: boolean
): 'light' | 'dark' {
  return mode === 'light' ? 'light' : 'dark';
}
