const fs = require('fs');
const path = require('path');
const { logger } = require('./lib/core.cjs');

const rootDir = path.resolve(__dirname, '..');
const REQUIRED_FIELDS = ['name', 'description', 'status'];
const VALID_STATUSES = ['implemented', 'planned', 'conceptual'];

let errors = 0;
let checked = 0;

const SKIP_DIRS = new Set([
  'node_modules', 'knowledge', 'scripts', 'schemas', 'templates',
  'evidence', 'coverage', 'test-results', 'work', 'nonfunctional', 'dist', 'tests', '.github'
]);

const dirs = fs.readdirSync(rootDir).filter(f => {
  const fullPath = path.join(rootDir, f);
  return fs.statSync(fullPath).isDirectory() && !f.startsWith('.') && !SKIP_DIRS.has(f);
});

for (const dir of dirs) {
  const skillPath = path.join(rootDir, dir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) continue;

  checked++;
  const content = fs.readFileSync(skillPath, 'utf8');

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    logger.error(`${dir}: No YAML frontmatter found`);
    errors++;
    continue;
  }

  const frontmatter = fmMatch[1];
  for (const field of REQUIRED_FIELDS) {
    const regex = new RegExp(`^${field}:`, 'm');
    if (!regex.test(frontmatter)) {
      logger.error(`${dir}: Missing required field "${field}"`);
      errors++;
    }
  }

  const statusMatch = frontmatter.match(/^status:\s*(.+)$/m);
  if (statusMatch) {
    const status = statusMatch[1].trim();
    if (!VALID_STATUSES.includes(status)) {
      logger.error(`${dir}: Invalid status "${status}". Must be one of: ${VALID_STATUSES.join(', ')}`);
      errors++;
    }
  }

  // --- Architectural Integrity Checks ---
  const scriptDir = path.join(rootDir, dir, 'scripts');
  if (fs.existsSync(scriptDir)) {
    const scripts = fs.readdirSync(scriptDir).filter(f => f.endsWith('.cjs'));
    for (const script of scripts) {
      const scriptContent = fs.readFileSync(path.join(scriptDir, script), 'utf8');
      
      // Enforce common ignore lists
      if (scriptContent.includes('const IGNORE_DIRS =') || scriptContent.includes('const ignorePatterns =')) {
        logger.error(`${dir}: Hardcoded ignore lists found in ${script}. Migrate to config-loader.cjs`);
        errors++;
      }

      // Enforce common CLI utils
      if (scriptContent.includes('yargs(hideBin(process.argv))')) {
        logger.error(`${dir}: Legacy yargs setup found in ${script}. Migrate to cli-utils.cjs`);
        errors++;
      }
    }
  }
}

logger.info(`Checked ${checked} skills`);
if (errors > 0) {
  logger.error(`Found ${errors} validation errors`);
  process.exit(1);
} else {
  logger.success('All skills have valid metadata');
}