const path = require('path');
const fs = require('fs');

const rootDir = path.resolve(__dirname, '../..');
const ACTIVE_ROOT = path.join(rootDir, 'active');

/**
 * Path Resolver Utility
 * Centralizes directory mapping to support seamless migrations and mission isolation.
 */
const pathResolver = {
  /**
   * Get the root directory for active data
   */
  activeRoot: () => ACTIVE_ROOT,

  /**
   * Get a mission-specific workspace
   * @param {string} missionId 
   */
  missionDir: (missionId) => {
    const dir = path.join(ACTIVE_ROOT, 'missions', missionId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  },

  /**
   * Get shared infrastructure paths (backward compatible with 'work/')
   */
  shared: (subPath = '') => path.join(ACTIVE_ROOT, 'shared', subPath),

  /**
   * Legacy bridge for 'work/' path requests
   */
  resolve: (oldPath) => {
    return oldPath.replace(/^work\//, 'active/shared/');
  }
};

module.exports = pathResolver;
