/**
 * FD-06 (設定): pure helpers behind `/settings`. `orderSectionsForFirstRun`
 * decides which of the 7 human sections render first — on first run
 * (readiness not yet complete) the sections with an incomplete/error
 * diagnostic sort ahead of the rest, in the same relative order as
 * `SETTINGS_SECTION_ORDER`; once every diagnostic is `ok`, the canonical
 * order is used unconditionally. No I/O, no `t()`/`frontDeskText()` — the
 * page owns translation and rendering, and the left sub-nav always renders
 * in the canonical order regardless of this reordering (the nav is a fixed
 * menu; only the card stack reflows for first run).
 */

export type SettingsSectionId =
  | 'profile'
  | 'display'
  | 'members'
  | 'services'
  | 'voice'
  | 'notifications'
  | 'recording'
  | 'plugins'
  | 'advanced';

export interface SettingsReadinessItem {
  id: string;
  status: 'ok' | 'incomplete' | 'error';
}

/** Matches plan §FD-06's fixed sub-nav order (settings_nav_* vocabulary). */
export const SETTINGS_SECTION_ORDER: readonly SettingsSectionId[] = [
  'profile',
  'display',
  'members',
  'services',
  'voice',
  'notifications',
  'recording',
  'plugins',
  'advanced',
];

/**
 * Maps a `/api/setup` diagnostics id to the settings section it belongs to.
 * `members` has no diagnostic of its own yet (FD-07 introduces one), so it
 * never sorts ahead of a complete section on its own account. Unknown
 * diagnostic ids are ignored rather than throwing — the page must still
 * render if the API adds a diagnostic this map doesn't know about yet.
 */
/**
 * UI-06: sub-nav entries that are not cards of their own. 表示 (`display`)
 * renders inside the profile card, so it is a nav jump target only and never
 * part of the card stack `orderSectionsForFirstRun` returns.
 */
export const SETTINGS_NAV_ONLY_SECTIONS: ReadonlySet<SettingsSectionId> = new Set(['display']);

/** The card stack in canonical order (sub-nav order minus nav-only entries). */
export const SETTINGS_CARD_SECTION_ORDER: readonly SettingsSectionId[] =
  SETTINGS_SECTION_ORDER.filter((id) => !SETTINGS_NAV_ONLY_SECTIONS.has(id));

const DIAGNOSTIC_SECTION: Record<string, SettingsSectionId> = {
  profile: 'profile',
  avatar: 'voice',
  voice: 'voice',
  services: 'services',
  notifications: 'notifications',
  reasoning: 'advanced',
};

export function orderSectionsForFirstRun(
  readiness: readonly SettingsReadinessItem[]
): SettingsSectionId[] {
  const allComplete = readiness.every((item) => item.status === 'ok');
  if (allComplete) return [...SETTINGS_CARD_SECTION_ORDER];

  const incompleteSections = new Set<SettingsSectionId>();
  for (const item of readiness) {
    if (item.status === 'ok') continue;
    const section = DIAGNOSTIC_SECTION[item.id];
    if (section) incompleteSections.add(section);
  }

  const incomplete = SETTINGS_CARD_SECTION_ORDER.filter((id) => incompleteSections.has(id));
  const rest = SETTINGS_CARD_SECTION_ORDER.filter((id) => !incompleteSections.has(id));
  return [...incomplete, ...rest];
}
