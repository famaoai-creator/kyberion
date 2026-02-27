const fs = require('fs');
const path = require('path');
const { logger } = require('../libs/core/core.cjs');

const rootDir = path.resolve(__dirname, '..');
const REQUIRED_FIELDS = ['name', 'description', 'status'];
const VALID_STATUSES = ['implemented', 'planned', 'conceptual'];

let errors = 0;
let checked = 0;

const SKIP_DIRS = new Set([
  'node_modules',
  'knowledge',
  'scripts',
  'schemas',
  'templates',
  'evidence',
  'coverage',
  'test-results',
  'work',
  'nonfunctional',
  'dist',
  'tests',
  '.github',
]);

const skillsRootDir = path.join(rootDir, 'skills');
const categories = fs
  .readdirSync(skillsRootDir)
  .filter((f) => fs.lstatSync(path.join(skillsRootDir, f)).isDirectory());

for (const cat of categories) {
  const catPath = path.join(skillsRootDir, cat);
  const skillDirs = fs
    .readdirSync(catPath)
    .filter((f) => fs.lstatSync(path.join(catPath, f)).isDirectory());

  for (const dir of skillDirs) {
    const skillFullDir = path.join(catPath, dir);
    const skillPath = path.join(skillFullDir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;

    checked++;
    const content = fs.readFileSync(skillPath, 'utf8');

    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) {
      logger.error(`${cat}/${dir}: No YAML frontmatter found`);
      errors++;
      continue;
    }

    const frontmatter = fmMatch[1];
    for (const field of REQUIRED_FIELDS) {
      const regex = new RegExp(`^${field}:`, 'm');
      if (!regex.test(frontmatter)) {
        logger.error(`${cat}/${dir}: Missing required field "${field}"`);
        errors++;
      }
    }

    const statusMatch = frontmatter.match(/^status:\s*(.+)$/m);
    if (statusMatch) {
      const status = statusMatch[1].trim();
      if (!VALID_STATUSES.includes(status)) {
        logger.error(
          `${cat}/${dir}: Invalid status "${status}". Must be one of: ${VALID_STATUSES.join(', ')}`
        );
        errors++;
      }
    }

    // --- Structural Integrity Checks ---
    const pkgPath = path.join(skillFullDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      logger.error(`${cat}/${dir}: Missing package.json`);
      errors++;
    }

    const srcIndexTsPath = path.join(skillFullDir, 'src/index.ts');
    const scriptsLegacyPath = path.join(skillFullDir, `scripts/${dir}.cjs`);
    const scriptsLegacyPath2 = path.join(skillFullDir, `scripts/main.cjs`);

    // We expect either a modern src/index.ts or at least some entry point.
    if (
      !fs.existsSync(srcIndexTsPath) &&
      !fs.existsSync(scriptsLegacyPath) &&
      !fs.existsSync(scriptsLegacyPath2) &&
      !fs.existsSync(path.join(skillFullDir, 'scripts'))
    ) {
      logger.error(`${cat}/${dir}: Missing standard entry point (src/index.ts or scripts/)`);
      errors++;
    }

    // --- Architectural Integrity Checks ---
    const scriptDir = path.join(skillFullDir, 'scripts');
    if (fs.existsSync(scriptDir)) {
      const scripts = fs.readdirSync(scriptDir).filter((f) => f.endsWith('.cjs'));
      for (const script of scripts) {
        const scriptContent = fs.readFileSync(path.join(scriptDir, script), 'utf8');

        // Enforce common ignore lists
        if (
          scriptContent.includes('const IGNORE_DIRS =') ||
          scriptContent.includes('const ignorePatterns =')
        ) {
          logger.error(
            `${cat}/${dir}: Hardcoded ignore lists found in ${script}. Migrate to config-loader.cjs`
          );
          errors++;
        }

        // Enforce common CLI utils
        if (scriptContent.includes('yargs(hideBin(process.argv))')) {
          logger.error(
            `${cat}/${dir}: Legacy yargs setup found in ${script}. Migrate to cli-utils.cjs`
          );
          errors++;
        }
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
