#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { logger: _logger } = require('./lib/core.cjs');

const rootDir = path.resolve(__dirname, '..');

/**
 * Metadata Sync Tool
 * Extracts yargs definitions from scripts and updates SKILL.md.
 */

function extractArgsFromCode(scriptPath) {
  if (!fs.existsSync(scriptPath)) return [];
  const content = fs.readFileSync(scriptPath, 'utf8');
  const args = [];

  // Regex to capture .option('name', { ... })
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

const entries = fs.readdirSync(rootDir, { withFileTypes: true });
const skillDirs = entries
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(rootDir, e.name, 'SKILL.md')))
  .map((e) => e.name);

console.log(`Syncing metadata for ${skillDirs.length} skills...`);

skillDirs.forEach((dir) => {
  const skillMdPath = path.join(rootDir, dir, 'SKILL.md');
  const scriptsDir = path.join(rootDir, dir, 'scripts');
  if (!fs.existsSync(scriptsDir)) return;

  let mainScript = path.join(scriptsDir, 'main.cjs');
  if (!fs.existsSync(mainScript)) {
    const files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.cjs'));
    if (files.length > 0) mainScript = path.join(scriptsDir, files[0]);
    else return;
  }

  const codeArgs = extractArgsFromCode(mainScript);
  if (codeArgs.length === 0) return;

  const content = fs.readFileSync(skillMdPath, 'utf8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
  if (!fmMatch) return;

  try {
    const fm = yaml.load(fmMatch[1]);
    fm.arguments = codeArgs; // Update with truth from code

    const newFm = `---\n${yaml.dump(fm)}---`;
    const newContent = content.replace(/^---\n[\s\S]*?\n---/m, newFm);

    if (newContent !== content) {
      fs.writeFileSync(skillMdPath, newContent);
      console.log(`  [${dir}] SKILL.md updated with ${codeArgs.length} arguments.`);
    }
  } catch (err) {
    console.error(`Failed to sync ${dir}: ${err.message}`);
  }
});

console.log('Sync complete.');
