const fs = require('fs');
const path = require('path');

/**
 * Loads common project standards from knowledge/common/project_standards.json
 */
function loadProjectStandards() {
  const configPath = path.resolve(__dirname, '../../knowledge/common/project_standards.json');
  try {
    const data = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(data);
  } catch (_e) {
    // Fallback defaults if config is missing
    return {
      ignore_dirs: ['.git', 'node_modules', '.DS_Store'],
      ignore_extensions: ['.lock', '.bin'],
    };
  }
}

module.exports = {
  loadProjectStandards,
};
