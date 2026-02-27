#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { logger } = require('../libs/core/core.cjs');

/**
 * Skill Creation Wizard - scaffolds a new skill from template.
 *
 * Usage:
 *   node scripts/create_skill.cjs <skill-name> [--description "desc"] [--template ts|cjs]
 *
 * Examples:
 *   node scripts/create_skill.cjs my-new-skill --description "Does something cool"
 *   node scripts/create_skill.cjs my-ts-skill --template ts --description "TypeScript skill"
 */

const rootDir = path.resolve(__dirname, '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith('--'));
  const descIdx = args.indexOf('--description');
  const description = descIdx !== -1 ? args[descIdx + 1] : '';
  const templateIdx = args.indexOf('--template');
  const template = templateIdx !== -1 ? args[templateIdx + 1] : 'cjs';
  const catIdx = args.indexOf('--category');
  const category = catIdx !== -1 ? args[catIdx + 1] : 'utilities';
  return { name, description, template, category };
}

function copyTemplate(templateDir, targetDir, replacements) {
  if (!fs.existsSync(templateDir)) {
    logger.error(`Template directory not found: ${templateDir}`);
    process.exit(1);
  }

  function walk(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, destPath);
      } else {
        let content = fs.readFileSync(srcPath, 'utf8');
        for (const [key, val] of Object.entries(replacements)) {
          content = content.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), val);
        }
        fs.writeFileSync(destPath, content);
      }
    }
  }

  walk(templateDir, targetDir);
}

function ensureNamespaceStructure(category) {
  const catDir = path.join(rootDir, 'skills', category);
  if (!fs.existsSync(catDir)) {
    fs.mkdirSync(catDir, { recursive: true });
  }

  // Ensure scripts/node_modules symlinks exist in the category dir
  // We use relative symlinks so they work even if the monorepo is moved
  const scriptsLink = path.join(catDir, 'scripts');
  if (!fs.existsSync(scriptsLink)) {
    try {
      fs.symlinkSync('../../scripts', scriptsLink, 'dir');
      logger.info(`Created scripts symlink for category "${category}"`);
    } catch (_e) {
      /* already exists or permission error */
    }
  }

  const nmLink = path.join(catDir, 'node_modules');
  if (!fs.existsSync(nmLink)) {
    try {
      fs.symlinkSync('../../node_modules', nmLink, 'dir');
      logger.info(`Created node_modules symlink for category "${category}"`);
    } catch (_e) {
      /* already exists or permission error */
    }
  }
}

function regenerateIndex() {
  try {
    execSync('node scripts/generate_skill_index.cjs', { cwd: rootDir, stdio: 'pipe' });
  } catch (e) {
    logger.warn('Could not regenerate skill index: ' + e.message);
  }
}

// Main
const { name, description, template, category } = parseArgs();

if (!name) {
  console.log(`
Skill Creation Wizard

Usage:
  node scripts/create_skill.cjs <skill-name> [options]

Options:
  --description "text"    Skill description
  --template cjs|ts       Template type (default: cjs)
  --category <name>       Skill category (default: utilities)
                          Valid: core, engineering, audit, connector, media, intelligence, ux, business, utilities

Examples:
  node scripts/create_skill.cjs my-skill --category engineering --description "A useful skill"
`);
  process.exit(0);
}

// Validate name
if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  logger.error('Skill name must be lowercase with hyphens only (e.g. my-new-skill)');
  process.exit(1);
}

const targetDir = path.join(rootDir, 'skills', category, name);
if (fs.existsSync(targetDir)) {
  logger.error(`Skill "${name}" already exists in category "${category}"`);
  process.exit(1);
}

const templateDir = path.join(rootDir, 'templates', `skill-template-${template}`);
const replacements = {
  '{{SKILL_NAME}}': name,
  '{{DESCRIPTION}}': description || `${name} skill`,
  '{{DATE}}': new Date().toISOString().split('T')[0],
};

logger.info(`Creating skill "${name}" in category "${category}" from ${template} template...`);
ensureNamespaceStructure(category);
copyTemplate(templateDir, targetDir, replacements);
regenerateIndex();
logger.success(`Skill "${name}" created at ${targetDir}`);
console.log(`
Next steps:
  1. Edit skills/${category}/${name}/scripts/main.${template === 'ts' ? 'ts' : 'cjs'} to implement your logic
  2. Update skills/${category}/${name}/SKILL.md with detailed documentation
  3. Add unit tests in tests/unit.test.cjs
  4. Run: node scripts/cli.cjs info ${name} to verify
`);
