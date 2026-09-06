import { defineCatalog } from './foundation/governed-catalog.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeWriteFile } from './secure-io.js';
import { isRecord } from './foundation/text.js';
import { pathResolver } from './path-resolver.js';

/**
 * User Preference Adapter v1.0
 */

const PREF_PATH = pathResolver.knowledge('personal/user-preferences.json');
const USER_PREFERENCES_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/user-preferences.schema.json'
);

export type UserPreferences = Record<string, unknown>;

/**
 * Parse the persisted preference root without making arbitrary JSON values
 * look like a mutable preference map.
 */
export function parseUserPreferences(value: unknown): UserPreferences | null {
  return isRecord(value) ? value : null;
}

function userPreferencesCatalogAtPath(filePath: string) {
  return defineCatalog<UserPreferences>({
    id: 'user-preferences',
    path: filePath,
    schema: USER_PREFERENCES_SCHEMA_PATH,
  });
}

function loadPersistedPreferences(): UserPreferences | null {
  if (!safeExistsSync(PREF_PATH) || !safeLstat(PREF_PATH).isFile()) return null;
  try {
    return parseUserPreferences(userPreferencesCatalogAtPath(PREF_PATH).load());
  } catch {
    return null;
  }
}

function isSafePreferenceSegment(segment: string): boolean {
  return !['__proto__', 'constructor', 'prototype'].includes(segment);
}

export function writeUserPreferencesAtPath(filePath: string, preferences: UserPreferences): string {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const validated = userPreferencesCatalogAtPath(safePath).validate(preferences, safePath);
  safeWriteFile(safePath, JSON.stringify(validated, null, 2) + '\n', { mkdir: true });
  return safePath;
}

export function readUserPreference(
  preferences: UserPreferences,
  key: string,
  defaultValue: unknown = null
): unknown {
  let current: unknown = preferences;
  for (const part of key.split('.')) {
    if (!isSafePreferenceSegment(part) || !isRecord(current)) return defaultValue;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return defaultValue;
    current = current[part];
  }
  return current;
}

export function writeUserPreference(
  preferences: UserPreferences,
  key: string,
  value: unknown
): boolean {
  const parts = key.split('.');
  if (parts.length === 0 || parts.some((part) => !isSafePreferenceSegment(part))) return false;

  let current = preferences;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (existing === undefined || existing === null) {
      current[part] = {};
    } else if (!isRecord(existing)) {
      return false;
    }
    current = current[part] as UserPreferences;
  }

  current[parts[parts.length - 1]] = value;
  return true;
}

export const preferenceAdapter = {
  get: (key: string, defaultValue: unknown = null): unknown => {
    try {
      const prefs = loadPersistedPreferences();
      return prefs ? readUserPreference(prefs, key, defaultValue) : defaultValue;
    } catch (_e) {
      return defaultValue;
    }
  },

  set: (key: string, value: unknown): boolean => {
    try {
      const prefs = safeExistsSync(PREF_PATH) ? loadPersistedPreferences() : {};
      if (!prefs || !writeUserPreference(prefs, key, value)) return false;

      writeUserPreferencesAtPath(PREF_PATH, prefs);
      return true;
    } catch (_e) {
      return false;
    }
  },

  forSkill: (skillName: string) => {
    return preferenceAdapter.get(skillName, {});
  },
};
