#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { logger } = require('./lib/core.cjs');

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
  return { name, description, template };
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

function updateWorkspaces(skillName) {
  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (!pkg.workspaces.includes(skillName)) {
    pkg.workspaces.push(skillName);
    pkg.workspaces.sort();
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
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
const { name, description, template } = parseArgs();

if (!name) {
  console.log(`
Skill Creation Wizard

Usage:
  node scripts/create_skill.cjs <skill-name> [options]

Options:
  --description "text"    Skill description
  --template cjs|ts       Template type (default: cjs)

Examples:
  node scripts/create_skill.cjs my-skill --description "A useful skill"
  node scripts/create_skill.cjs my-ts-skill --template ts --description "TS skill"
`);
  process.exit(0);
}

// Validate name
if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  logger.error('Skill name must be lowercase with hyphens only (e.g. my-new-skill)');
  process.exit(1);
}

const targetDir = path.join(rootDir, name);
if (fs.existsSync(targetDir)) {
  logger.error(`Directory "${name}" already exists`);
  process.exit(1);
}

const templateDir = path.join(rootDir, 'templates', `skill-template-${template}`);
const replacements = {
  '{{SKILL_NAME}}': name,
  '{{DESCRIPTION}}': description || `${name} skill`,
  '{{DATE}}': new Date().toISOString().split('T')[0],
};

logger.info(`Creating skill "${name}" from ${template} template...`);
copyTemplate(templateDir, targetDir, replacements);
updateWorkspaces(name);
regenerateIndex();
logger.success(`Skill "${name}" created at ${targetDir}`);
console.log(`
Next steps:
  1. Edit ${name}/scripts/main.${template === 'ts' ? 'ts' : 'cjs'} to implement your logic
  2. Update ${name}/SKILL.md with detailed documentation
  3. Add unit tests in tests/unit.test.cjs
  4. Run: node scripts/audit_skills.cjs to verify quality
`);
