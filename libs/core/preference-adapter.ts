import { loadJson, safeExistsSync, safeWriteFile } from './secure-io.js';
import { isRecord } from './foundation/text.js';
import { pathResolver } from './path-resolver.js';

/**
 * User Preference Adapter v1.0
 */

const PREF_PATH = pathResolver.knowledge('personal/user-preferences.json');

export type UserPreferences = Record<string, unknown>;

/**
 * Parse the persisted preference root without making arbitrary JSON values
 * look like a mutable preference map.
 */
export function parseUserPreferences(value: unknown): UserPreferences | null {
  return isRecord(value) ? value : null;
}

function isSafePreferenceSegment(segment: string): boolean {
  return !['__proto__', 'constructor', 'prototype'].includes(segment);
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
      if (!safeExistsSync(PREF_PATH)) return defaultValue;
      const prefs = parseUserPreferences(loadJson<unknown>(PREF_PATH));
      return prefs ? readUserPreference(prefs, key, defaultValue) : defaultValue;
    } catch (_e) {
      return defaultValue;
    }
  },

  set: (key: string, value: unknown): boolean => {
    try {
      const prefs = safeExistsSync(PREF_PATH)
        ? parseUserPreferences(loadJson<unknown>(PREF_PATH))
        : {};
      if (!prefs || !writeUserPreference(prefs, key, value)) return false;

      safeWriteFile(PREF_PATH, JSON.stringify(prefs, null, 2) + '\n');
      return true;
    } catch (_e) {
      return false;
    }
  },

  forSkill: (skillName: string) => {
    return preferenceAdapter.get(skillName, {});
  },
};
