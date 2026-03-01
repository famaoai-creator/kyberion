#!/usr/bin/env node
/**
 * Skill Creation Wizard - scaffolds a new skill from template.
 * Standards-compliant version (Script Civilization Mission).
 *
 * Usage:
 *   node scripts/create_skill.cjs <skill-name> [--description "desc"] [--template ts|cjs]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { logger, errorHandler } = require('../libs/core/core.cjs');
const { safeReadFile, safeWriteFile } = require('../libs/core/secure-io.cjs');
const pathResolver = require('../libs/core/path-resolver.cjs');

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
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, destPath);
      } else {
        try {
          let content = safeReadFile(srcPath, { encoding: 'utf8' });
          for (const [key, val] of Object.entries(replacements)) {
            content = content.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), val);
          }
          safeWriteFile(destPath, content);
        } catch (err) {
          logger.error(`Failed to copy ${srcPath}: ${err.message}`);
        }
      }
    }
  }

  walk(templateDir, targetDir);
}

function ensureNamespaceStructure(category) {
  const catDir = pathResolver.rootResolve(path.join('skills', category));
  if (!fs.existsSync(catDir)) {
    fs.mkdirSync(catDir, { recursive: true });
  }

  const scriptsLink = path.join(catDir, 'scripts');
  if (!fs.existsSync(scriptsLink)) {
    try {
      fs.symlinkSync('../../scripts', scriptsLink, 'dir');
      logger.info(`Created scripts symlink for category "${category}"`);
    } catch (_e) {}
  }

  const nmLink = path.join(catDir, 'node_modules');
  if (!fs.existsSync(nmLink)) {
    try {
      fs.symlinkSync('../../node_modules', nmLink, 'dir');
      logger.info(`Created node_modules symlink for category "${category}"`);
    } catch (_e) {}
  }
}

function regenerateIndex() {
  try {
    execSync('node scripts/generate_skill_index.cjs', { cwd: pathResolver.rootDir(), stdio: 'pipe' });
  } catch (e) {
    logger.warn('Could not regenerate skill index: ' + e.message);
  }
}

try {
  const { name, description, template, category } = parseArgs();

  if (!name) {
    logger.info(`
Skill Creation Wizard

Usage:
  node scripts/create_skill.cjs <skill-name> [options]

Options:
  --description "text"    Skill description
  --template cjs|ts       Template type (default: cjs)
  --category <name>       Skill category (default: utilities)
                          Valid: core, engineering, audit, connector, media, intelligence, ux, business, utilities
`);
    process.exit(0);
  }

  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    logger.error('Skill name must be lowercase with hyphens only (e.g. my-new-skill)');
    process.exit(1);
  }

  const targetDir = pathResolver.rootResolve(path.join('skills', category, name));
  if (fs.existsSync(targetDir)) {
    logger.error(`Skill "${name}" already exists in category "${category}"`);
    process.exit(1);
  }

  const templateDir = pathResolver.rootResolve(path.join('templates', `skill-template-${template}`));
  const replacements = {
    '{{SKILL_NAME}}': name,
    '{{DESCRIPTION}}': description || `${name} skill`,
    '{{DATE}}': new Date().toISOString().split('T')[0],
  };

  logger.info(`Creating skill "${name}" in category "${category}" from ${template} template...`);
  ensureNamespaceStructure(category);
  copyTemplate(templateDir, targetDir, replacements);

  // Link local node_modules for @agent/core resolution
  const localNmLink = path.join(targetDir, 'node_modules');
  if (!fs.existsSync(localNmLink)) {
    try {
      const relativePath = template === 'ts' ? '../../../node_modules' : '../../../node_modules';
      fs.symlinkSync(relativePath, localNmLink, 'dir');
      logger.info(`Linked node_modules for skill "${name}"`);
    } catch (e) {
      logger.warn(`Failed to link node_modules: ${e.message}`);
    }
  }

  regenerateIndex();
  
  logger.success(`Skill "${name}" created at ${targetDir}`);
  logger.info(`
Next steps:
  1. Edit skills/${category}/${name}/scripts/main.${template === 'ts' ? 'ts' : 'cjs'} to implement your logic
  2. Update skills/${category}/${name}/SKILL.md with detailed documentation
  3. Add unit tests in tests/unit.test.cjs
  4. Run: node scripts/cli.cjs info ${name} to verify
`);
} catch (err) {
  errorHandler(err, 'Skill Creation Failed');
}
