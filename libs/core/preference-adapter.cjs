const fs = require('fs');
const path = require('path');

/**
 * User Preference Adapter v1.0
 * Manages user-specific settings and learns from behavior.
 * Data is stored in the Personal Tier, ensuring it never leaks.
 */

const rootDir = path.resolve(__dirname, '../..');
const PREF_PATH = path.join(rootDir, 'knowledge/personal/user-preferences.json');

const preferenceAdapter = {
  /**
   * Get preference for a specific skill or category
   * @param {string} key - Key like 'executive-reporting-maestro.detail_level'
   * @param {any} defaultValue - Fallback if not set
   */
  get: (key, defaultValue = null) => {
    try {
      if (!fs.existsSync(PREF_PATH)) return defaultValue;
      const prefs = JSON.parse(fs.readFileSync(PREF_PATH, 'utf8'));

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

  /**
   * Set and persist a user preference
   */
  set: (key, value) => {
    try {
      const prefs = fs.existsSync(PREF_PATH) ? JSON.parse(fs.readFileSync(PREF_PATH, 'utf8')) : {};

      const parts = key.split('.');
      let current = prefs;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!current[part]) current[part] = {};
        current = current[part];
      }
      current[parts[parts.length - 1]] = value;

      fs.writeFileSync(PREF_PATH, JSON.stringify(prefs, null, 2) + '\n');
      return true;
    } catch (_e) {
      return false;
    }
  },

  /**
   * Get all preferences for a specific skill
   */
  forSkill: (skillName) => {
    return preferenceAdapter.get(skillName, {});
  },
};

module.exports = preferenceAdapter;
