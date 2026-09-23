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

/**
 * UI-07: the theme choice uses the same per-viewer key as the front desk
 * (`kyberion.ui.theme`; absent = follow the system). The former Chronos key
 * is still read so an existing choice (and scripts that seed it, such as
 * check_chronos_dom_contrast) keep working.
 */
export const CHRONOS_THEME_STORAGE_KEY = 'kyberion.ui.theme';
export const CHRONOS_LEGACY_THEME_STORAGE_KEY = 'chronos.theme-mode';

function normalizeStoredTheme(value: string | null): ChronosThemeMode | null {
  return value === 'light' || value === 'dark' || value === 'system' ? value : null;
}

export function loadStoredChronosThemeMode(): ChronosThemeMode | null {
  if (typeof window === 'undefined') return null;
  try {
    return (
      normalizeStoredTheme(window.localStorage.getItem(CHRONOS_THEME_STORAGE_KEY)) ??
      normalizeStoredTheme(window.localStorage.getItem(CHRONOS_LEGACY_THEME_STORAGE_KEY))
    );
  } catch {
    return null;
  }
}

export function saveStoredChronosThemeMode(mode: ChronosThemeMode): void {
  if (typeof window === 'undefined') return;
  try {
    if (mode === 'system') window.localStorage.removeItem(CHRONOS_THEME_STORAGE_KEY);
    else window.localStorage.setItem(CHRONOS_THEME_STORAGE_KEY, mode);
    window.localStorage.removeItem(CHRONOS_LEGACY_THEME_STORAGE_KEY);
  } catch {
    // localStorage may be denied; the choice still applies to this page view.
  }
}

/**
 * `system` follows `prefers-color-scheme` through the token stylesheet; a
 * pinned light/dark sets `data-theme` on `<html>` (`:root[data-theme]`).
 */
export function applyChronosThemeMode(mode: ChronosThemeMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (mode === 'system') {
    root.removeAttribute('data-theme');
    root.style.removeProperty('color-scheme');
  } else {
    root.setAttribute('data-theme', mode);
    root.style.colorScheme = mode;
  }
}

/**
 * Inline `<head>` script: applies a stored light/dark choice before first
 * paint so a pinned theme never flashes the system theme.
 */
export const CHRONOS_THEME_BOOTSTRAP_SCRIPT = `(function(){try{var s=window.localStorage;var t=s.getItem(${JSON.stringify(
  CHRONOS_THEME_STORAGE_KEY
)})||s.getItem(${JSON.stringify(
  CHRONOS_LEGACY_THEME_STORAGE_KEY
)});if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);document.documentElement.style.colorScheme=t;}}catch(e){}})();`;
