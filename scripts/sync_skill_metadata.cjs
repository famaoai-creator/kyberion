#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const chalk = require('chalk');

/**
 * Metadata Ecosystem Sync v2.0
 * Synchronizes code (yargs), SKILL.md (SoT), and package.json (npm).
 */

const rootDir = path.resolve(__dirname, '..');
const skillsRootDir = path.join(rootDir, 'skills');

function extractArgsFromCode(scriptPath) {
  if (!fs.existsSync(scriptPath)) return [];
  const content = fs.readFileSync(scriptPath, 'utf8');
  const args = [];
  const optionRegex = /\.option\(['"]([^'"]+)['"],\s*\{([\s\S]*?)\}\)/g;
  let match;

  while ((match = optionRegex.exec(content)) !== null) {
    const name = match[1];
    const body = match[2];
    const arg = { name };
    const aliasMatch = body.match(/alias:\s*['"]([^'"]+)['"]/);
    const typeMatch = body.match(/type:\s*['"]([^'"]+)['"]/);
    const demandMatch = body.match(/demandOption:\s*true/);
    const descMatch = body.match(/desc(?:ribe|ription)?:\s*['"]([^'"]+)['"]/);

    if (aliasMatch) arg.short = aliasMatch[1];
    if (typeMatch) arg.type = typeMatch[1];
    if (demandMatch) arg.required = true;
    if (descMatch) arg.description = descMatch[1];
    args.push(arg);
  }
  return args;
}

function syncSkill(cat, dir) {
  const skillFullDir = path.join(skillsRootDir, cat, dir);
  const skillMdPath = path.join(skillFullDir, 'SKILL.md');
  const pkgPath = path.join(skillFullDir, 'package.json');
  const scriptsDir = path.join(skillFullDir, 'scripts');

  if (!fs.existsSync(skillMdPath)) return;

  // 1. Sync Code -> SKILL.md
  let mainScript = path.join(scriptsDir, 'main.cjs');
  if (!fs.existsSync(mainScript)) {
    if (fs.existsSync(scriptsDir)) {
      const files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.cjs'));
      if (files.length > 0) mainScript = path.join(scriptsDir, files[0]);
    }
  }

  const codeArgs = extractArgsFromCode(mainScript);
  const originalContent = fs.readFileSync(skillMdPath, 'utf8');
  const fmMatch = originalContent.match(/^---\n([\s\S]*?)\n---/m);

  if (fmMatch) {
    try {
      const fm = yaml.load(fmMatch[1]);

      // Update arguments from code
      if (codeArgs.length > 0) fm.arguments = codeArgs;

      // Update category from directory
      fm.category = cat.charAt(0).toUpperCase() + cat.slice(1);

      // Update last_updated
      fm.last_updated = new Date().toISOString().split('T')[0];

      const newFm = `---\n${yaml.dump(fm)}---`;
      const newMdContent = originalContent.replace(/^---\n[\s\S]*?\n---/m, newFm);

      if (newMdContent !== originalContent) {
        fs.writeFileSync(skillMdPath, newMdContent);
        console.log(chalk.green(`  [${dir}] Updated SKILL.md`));
      }

      // 2. Sync SKILL.md -> package.json
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        let pkgChanged = false;

        if (pkg.description !== fm.description) {
          pkg.description = fm.description;
          pkgChanged = true;
        }

        if (pkgChanged) {
          fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
          console.log(chalk.blue(`  [${dir}] Updated package.json description`));
        }
      }
    } catch (err) {
      console.error(chalk.red(`  [${dir}] Sync failed: ${err.message}`));
    }
  }
}

try {
  console.log(chalk.bold.cyan('\n🔄 Synchronizing Ecosystem Metadata...'));

  const categories = fs
    .readdirSync(skillsRootDir)
    .filter((f) => fs.lstatSync(path.join(skillsRootDir, f)).isDirectory());
  categories.forEach((cat) => {
    const catPath = path.join(skillsRootDir, cat);
    const skillDirs = fs
      .readdirSync(catPath)
      .filter((f) => fs.lstatSync(path.join(catPath, f)).isDirectory());
    skillDirs.forEach((dir) => syncSkill(cat, dir));
  });

  console.log(
    chalk.bold.green('\n✨ All skill metadata is now consistent across MD, JS, and JSON.\n')
  );
} catch (err) {
  console.error(chalk.red(`Fatal: ${err.message}`));
}
