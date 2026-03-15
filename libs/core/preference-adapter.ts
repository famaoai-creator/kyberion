import * as path from 'node:path';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';

/**
 * User Preference Adapter v1.0
 */

const PREF_PATH = path.join(process.cwd(), 'knowledge/personal/user-preferences.json');

export const preferenceAdapter = {
  get: (key: string, defaultValue: any = null) => {
    try {
      if (!safeExistsSync(PREF_PATH)) return defaultValue;
      const prefs = JSON.parse(safeReadFile(PREF_PATH, { encoding: 'utf8' }) as string);

      const parts = key.split('.');
      let current = prefs;
      for (const part of parts) {
        if (current[part] === undefined) return defaultValue;
        current = current[part];
      }
      return current;
    } catch (_e) {
      return defaultValue;
    }
  },

  set: (key: string, value: any) => {
    try {
      const prefs = safeExistsSync(PREF_PATH)
        ? JSON.parse(safeReadFile(PREF_PATH, { encoding: 'utf8' }) as string)
        : {};

      const parts = key.split('.');
      let current = prefs;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!current[part]) current[part] = {};
        current = current[part];
      }
      current[parts[parts.length - 1]] = value;

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
