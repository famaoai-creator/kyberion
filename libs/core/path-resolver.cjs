const path = require('path');
const fs = require('fs');

/**
 * Path Resolver Utility v2.0
 * Robust directory mapping for hierarchical namespace architecture.
 */

// Root detection: Find the directory containing package.json starting from current __dirname
function findProjectRoot(startDir) {
  let current = startDir;
  while (current !== path.parse(current).root) {
    if (
      fs.existsSync(path.join(current, 'package.json')) &&
      fs.existsSync(path.join(current, 'skills'))
    ) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(__dirname, '../..'); // Fallback
}

const rootDir = findProjectRoot(__dirname);
const ACTIVE_ROOT = path.join(rootDir, 'active');
const INDEX_PATH = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');

const pathResolver = {
  rootDir: () => rootDir,
  activeRoot: () => ACTIVE_ROOT,

  /**
   * Resolve a skill's physical directory via the global index
   * @param {string} skillName
   */
  skillDir: (skillName) => {
    if (!fs.existsSync(INDEX_PATH)) return path.join(rootDir, 'skills/utilities', skillName); // Guess fallback

    const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    const skill = (index.s || index.skills).find((s) => (s.n || s.name) === skillName);

    if (skill && skill.path) {
      return path.join(rootDir, skill.path);
    }
    return path.join(rootDir, skillName); // Legacy fallback
  },

  /**
   * Get a mission-specific workspace
   */
  missionDir: (missionId) => {
    const dir = path.join(ACTIVE_ROOT, 'missions', missionId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  },

  /**
   * Get shared infrastructure paths
   */
  shared: (subPath = '') => path.join(ACTIVE_ROOT, 'shared', subPath),

  /**
   * Resolve logical path to physical path with support for skill:// prefix
   */
  resolve: (logicalPath) => {
    if (!logicalPath) return rootDir;

    // Support for skill://skill-name/path/to/file
    if (logicalPath.startsWith('skill://')) {
      const parts = logicalPath.slice(8).split('/');
      const skillName = parts[0];
      const relPath = parts.slice(1).join('/');
      return path.join(pathResolver.skillDir(skillName), relPath);
    }

    if (logicalPath.startsWith('active/shared/')) {
      return path.join(ACTIVE_ROOT, 'shared', logicalPath.replace('active/shared/', ''));
    }

    return path.isAbsolute(logicalPath) ? logicalPath : path.resolve(rootDir, logicalPath);
  },

  /**
   * Always resolve relative to project root, regardless of current process.cwd()
   */
  rootResolve: (relativePath) => {
    return path.isAbsolute(relativePath) ? relativePath : path.join(rootDir, relativePath);
  },
};

module.exports = pathResolver;
