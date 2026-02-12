#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');

// --- Bootstrap Step ---
try {
  require('./bootstrap.cjs');
} catch (e) {
  console.warn('[CLI] Bootstrap failed, attempting to continue...');
}
// ----------------------

const { logger, fileUtils } = require('./lib/core.cjs');
const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');

// --- Role Identity Display ---
const currentRole = fileUtils.getCurrentRole();
console.log(`\x1b[36m[Ecosystem Identity] Active Role: ${currentRole}\x1b[0m\n`);
// -----------------------------

const args = process.argv.slice(2);
const command = args[0];
const skillName = args[1];
const skillArgs = args.slice(2);

function loadIndex() {
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

function findScript(skillDir) {
  const scriptsDir = path.join(skillDir, 'scripts');
  const distDir = path.join(skillDir, 'dist');
  
  // 1. Search in scripts/ (prefer main.cjs)
  if (fs.existsSync(scriptsDir)) {
    const files = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.cjs') || f.endsWith('.js'));
    const main = files.find(f => f === 'main.cjs' || f === 'main.js');
    if (main) return path.join(scriptsDir, main);
    if (files.length > 0) return path.join(scriptsDir, files[0]);
  }

  // 2. Search in dist/ (compiled TS)
  if (fs.existsSync(distDir)) {
    const files = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
    const main = files.find(f => f === 'main.js' || f === 'score.js');
    if (main) return path.join(distDir, main);
    if (files.length > 0) return path.join(distDir, files[0]);
  }

  return null;
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

  // Clean arguments: remove the '--' separator if present so child processes can parse flags correctly
  const cleanArgs = skillArgs.filter(arg => arg !== '--');
  const cmd = `node "${script}" ${cleanArgs.map(a => `"${a}"`).join(' ')}`;
  try {
    const output = execSync(cmd, { encoding: 'utf8', cwd: rootDir, stdio: 'pipe' });
    process.stdout.write(output);
  } catch (err) {
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
    skills = skills.filter(s => s.status === filter);
  }

  // Load metrics for scores
  const { metrics } = require('./lib/metrics.cjs');
  const history = metrics.reportFromHistory();
  const scores = new Map();
  history.skills.forEach(s => scores.set(s.skill, s.efficiencyScore));

  // Group by "Domain/Category" (simulated by path prefix or first tag)
  const groups = {};
  skills.forEach(s => {
    // Try to find category from SKILL.md frontmatter or fallback to 'General'
    const skillMd = path.join(rootDir, s.name, 'SKILL.md');
    let category = 'General';
    if (fs.existsSync(skillMd)) {
      const content = fs.readFileSync(skillMd, 'utf8');
      const fm = parseFrontmatter(content);
      if (fm.category) category = fm.category;
    }
    
    if (!groups[category]) groups[category] = [];
    groups[category].push(s);
  });

  console.log(`\n${skills.length} skills${filter ? ` (${filter})` : ''} available:\n`);

  Object.keys(groups).sort().forEach(cat => {
    console.log(chalk.bold.underline(`${cat}:`));
    groups[cat].sort((a, b) => a.name.localeCompare(b.name)).forEach(s => {
      const hasScript = findScript(path.join(rootDir, s.name)) ? '+' : ' ';
      const score = scores.get(s.name) || '--';
      const scoreColor = score !== '--' && score < 70 ? chalk.yellow : chalk.green;
      
      console.log(`  [${hasScript}] ${s.name.padEnd(30)} ${scoreColor(String(score).padStart(3))} | ${s.description.substring(0, 50)}`);
    });
    console.log('');
  });

  console.log(`  [+] = runnable | Score: Efficiency (0-100)\n`);
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
