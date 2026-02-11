#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { logger } = require('./lib/core.cjs');

const rootDir = path.resolve(__dirname, '..');
const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');

const args = process.argv.slice(2);
const command = args[0];
const skillName = args[1];
const skillArgs = args.slice(2);

function loadIndex() {
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

function findScript(skillDir) {
  const scriptsDir = path.join(skillDir, 'scripts');
  if (!fs.existsSync(scriptsDir)) return null;
  const files = fs.readdirSync(scriptsDir).filter(f =>
    f.endsWith('.cjs') || f.endsWith('.js') || f.endsWith('.mjs')
  );
  return files.length > 0 ? path.join(scriptsDir, files[0]) : null;
}

function runCommand() {
  if (!skillName) {
    logger.error('Usage: gemini-skills run <skill-name> [args...]');
    process.exit(1);
  }

  const index = loadIndex();
  const skill = index.skills.find(s => s.name === skillName);
  if (!skill) {
    logger.error(`Skill "${skillName}" not found in index`);
    const similar = index.skills
      .filter(s => s.name.includes(skillName) || skillName.includes(s.name))
      .map(s => s.name);
    if (similar.length > 0) logger.info(`Did you mean: ${similar.join(', ')}?`);
    process.exit(1);
  }

  const skillDir = path.join(rootDir, skill.name);
  const script = findScript(skillDir);
  if (!script) {
    logger.error(`Skill "${skillName}" has no runnable scripts (status may be "planned")`);
    process.exit(1);
  }

  const cmd = `node "${script}" ${skillArgs.map(a => `"${a}"`).join(' ')}`;
  try {
    const output = execSync(cmd, { encoding: 'utf8', cwd: rootDir, stdio: 'pipe' });
    process.stdout.write(output);
  } catch (_err) {
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    process.exit(err.status || 1);
  }
}

function listCommand() {
  const index = loadIndex();
  const filter = skillName; // optional status filter

  let skills = index.skills;
  if (filter && ['implemented', 'planned', 'conceptual'].includes(filter)) {
    skills = skills.filter(s => {
      const skillMd = path.join(rootDir, s.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) return false;
      const content = fs.readFileSync(skillMd, 'utf8');
      const statusMatch = content.match(/^status:\s*(.+)$/m);
      return statusMatch && statusMatch[1].trim() === filter;
    });
  }

  console.log(`\n${skills.length} skills${filter ? ` (${filter})` : ''}:\n`);
  for (const s of skills) {
    const hasScript = findScript(path.join(rootDir, s.name)) ? '+' : ' ';
    console.log(`  [${hasScript}] ${s.name.padEnd(35)} ${s.description.substring(0, 60)}`);
  }
  console.log(`\n  [+] = has runnable scripts\n`);
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  let currentKey = null;
  let inArray = false;
  let arrayItems = [];

  for (const line of match[1].split('\n')) {
    if (inArray) {
      const itemMatch = line.match(/^\s+-\s+(.*)/);
      if (itemMatch) {
        const val = itemMatch[1].trim();
        if (val.startsWith('name:')) {
          const obj = {};
          const kvM = val.match(/^(\w+):\s*(.+)/);
          if (kvM) obj[kvM[1]] = kvM[2].trim();
          arrayItems.push(obj);
        } else if (arrayItems.length > 0 && typeof arrayItems[arrayItems.length - 1] === 'object') {
          const kvM = val.match(/^(\w+):\s*(.+)/);
          if (kvM) arrayItems[arrayItems.length - 1][kvM[1]] = kvM[2].trim();
        } else {
          arrayItems.push(val);
        }
        continue;
      }
      const propMatch = line.match(/^\s{4,}(\w+):\s*(.+)/);
      if (propMatch && arrayItems.length > 0 && typeof arrayItems[arrayItems.length - 1] === 'object') {
        arrayItems[arrayItems.length - 1][propMatch[1]] = propMatch[2].trim();
        continue;
      }
      fm[currentKey] = arrayItems;
      inArray = false;
      arrayItems = [];
    }
    const kvMatch = line.match(/^(\w+):\s*(.*)/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === '') { inArray = true; arrayItems = []; }
      else fm[currentKey] = val;
    }
  }
  if (inArray && currentKey) fm[currentKey] = arrayItems;
  return fm;
}

function searchCommand() {
  const keyword = skillName;
  if (!keyword) {
    logger.error('Usage: gemini-skills search <keyword>');
    process.exit(1);
  }

  const index = loadIndex();
  const lowerKey = keyword.toLowerCase();

  const results = index.skills.filter(s =>
    s.name.toLowerCase().includes(lowerKey) ||
    s.description.toLowerCase().includes(lowerKey)
  );

  if (results.length === 0) {
    console.log(`\nNo skills found matching "${keyword}"\n`);
    return;
  }

  // Sort: implemented first
  const sorted = results.sort((a, b) => {
    const aImpl = findScript(path.join(rootDir, a.name)) ? 0 : 1;
    const bImpl = findScript(path.join(rootDir, b.name)) ? 0 : 1;
    return aImpl - bImpl;
  });

  console.log(`\n${sorted.length} skills matching "${keyword}":\n`);

  for (const s of sorted) {
    const hasScript = findScript(path.join(rootDir, s.name)) ? '+' : ' ';
    console.log(`  [${hasScript}] ${s.name.padEnd(35)} ${s.description.substring(0, 60)}`);

    // Show arguments summary from SKILL.md
    const skillMd = path.join(rootDir, s.name, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      const content = fs.readFileSync(skillMd, 'utf8');
      const fm = parseFrontmatter(content);
      if (Array.isArray(fm.arguments) && fm.arguments.length > 0) {
        const argStr = fm.arguments.map(a =>
          a.positional ? `<${a.name}>` : `--${a.name}${a.required === 'true' ? '*' : ''}`
        ).join(' ');
        console.log(`       args: ${argStr}`);
      }
    }
  }
  console.log(`\n  [+] = has runnable scripts   * = required\n`);
}

function infoCommand() {
  if (!skillName) {
    logger.error('Usage: gemini-skills info <skill-name>');
    process.exit(1);
  }

  const skillDir = path.join(rootDir, skillName);
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    logger.error(`Skill "${skillName}" not found`);
    process.exit(1);
  }

  const content = fs.readFileSync(skillMd, 'utf8');
  const script = findScript(skillDir);

  console.log(content);
  if (script) {
    console.log(`\nScript: ${path.relative(rootDir, script)}`);
  }
}

switch (command) {
  case 'run':
    runCommand();
    break;
  case 'list':
    listCommand();
    break;
  case 'search':
    searchCommand();
    break;
  case 'info':
    infoCommand();
    break;
  default:
    console.log(`
Gemini Skills CLI

Usage:
  node scripts/cli.cjs run <skill-name> [args...]    Run a skill
  node scripts/cli.cjs list [status]                  List skills (filter by: implemented, planned)
  node scripts/cli.cjs search <keyword>               Search skills by name or description
  node scripts/cli.cjs info <skill-name>              Show skill details
`);
}
