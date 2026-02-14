#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const rootDir = path.resolve(__dirname, '..');
// --- Bootstrap Step ---
try {
  require('./bootstrap.cjs');
} catch (_e) {
  console.warn('[CLI] Bootstrap failed, attempting to continue...');
}
// ----------------------
const { logger, fileUtils, ui } = require('./lib/core.cjs');
const chalk = require('chalk');
const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');
// --- UX: Proactive Health Check ---
async function checkHealth(role) {
  const govPath = path.join(rootDir, 'work/governance-report.json');
  const perfDir = path.join(rootDir, 'evidence/performance');
  const recipePath = path.join(rootDir, 'knowledge/orchestration/remediation-recipes.json');

  const priorities = {
    'Ecosystem Architect': ['integrity', 'governance', 'debt'],
    'Reliability Engineer': ['performance', 'governance'],
    'Security Reviewer': ['pii', 'governance'],
    'CEO': ['debt', 'governance', 'performance'],
  };

  const myPriorities = priorities[role] || ['governance', 'performance'];

  for (const p of myPriorities) {
    if (p === 'governance') {
      // 1. Governance Status
      if (fs.existsSync(govPath)) {
        const report = JSON.parse(fs.readFileSync(govPath, 'utf8'));
        if (report.overall_status !== 'compliant') {
          logger.warn('Ecosystem is currently NON-COMPLIANT.');
          const recipes = fs.existsSync(recipePath)
            ? JSON.parse(fs.readFileSync(recipePath, 'utf8'))
            : {};
          if (recipes.NON_COMPLIANT) {
            console.log(chalk.cyan(`\n\u2699\ufe0f  Auto-healing triggered: ${recipes.NON_COMPLIANT.description}`));
            console.log(chalk.dim(`    Executing: ${recipes.NON_COMPLIANT.command}\n`));
            try {
              execSync(recipes.NON_COMPLIANT.command, { stdio: 'inherit', cwd: rootDir });
              console.log(chalk.green('\n\u2714  Repair complete. Continuing...\n'));
            } catch (e) {
              logger.error(`Self-healing failed: ${e.message}`);
            }
          }
        }
      }
    }

    if (p === 'performance') {
      // 2. SRE: SLO Breach Alerts
      if (fs.existsSync(perfDir)) {
        const perfFiles = fs
          .readdirSync(perfDir)
          .filter((f) => f.endsWith('.json'))
          .sort();
        if (perfFiles.length > 0) {
          const latestPerf = JSON.parse(
            fs.readFileSync(path.join(perfDir, perfFiles[perfFiles.length - 1]), 'utf8')
          );
          if (latestPerf.slo_breaches && latestPerf.slo_breaches.length > 0) {
            const criticals = latestPerf.slo_breaches.filter((b) => b.severity === 'CRITICAL');
            if (criticals.length > 0) {
              console.log(
                chalk.bgRed.white.bold(
                  `\n !!! CRITICAL RELIABILITY ALERT: ${criticals.length} CHRONIC BREACHES !!! `
                )
              );
              criticals.forEach((b) => {
                console.log(
                  chalk.red(
                    `  [!] ${b.skill.toUpperCase()}: Failed SLO for ${b.consecutive_breaches} consecutive scans!`
                  )
                );
              });
              console.log(chalk.bgRed.white.bold(` ${' '.repeat(56)} \n`));
            } else {
              console.log(
                chalk.red.bold(
                  `\n\u26a0\ufe0f  SLO BREACH DETECTED (${latestPerf.slo_breaches.length} skills)`
                )
              );
              latestPerf.slo_breaches.slice(0, 3).forEach((b) => {
                console.log(
                  chalk.red(
                    `   - ${b.skill}: Latency ${b.actual_latency}ms (Target ${b.target_latency}ms)`
                  )
                );
              });
            }
          }
        }
      }
    }

    if (p === 'integrity' && role === 'Ecosystem Architect') {
      try {
        console.log(chalk.dim('\n\u23f3  Checking knowledge integrity...'));
        execSync('node scripts/check_knowledge_integrity.cjs', { stdio: 'ignore', cwd: rootDir });
      } catch (_e) {
        console.log(chalk.yellow(' \u26a0\ufe0f  Knowledge base has broken links or inconsistencies.'));
      }
    }

    if (p === 'pii' && role === 'Security Reviewer') {
      try {
        execSync('node scripts/scan_pii_in_docs.cjs', { stdio: 'ignore', cwd: rootDir });
      } catch (_e) {
        console.log(chalk.red(' \ud83d\udea8  SECURITY ALERT: Sensitive tokens found in documentation!'));
      }
    }

    if (p === 'debt') {
      try {
        console.log(chalk.dim('\n\u23f3  Calculating technical debt...'));
        execSync('node scripts/generate_debt_report.cjs', { stdio: 'inherit', cwd: rootDir });
      } catch (_e) {
        /* ignore */
      }
    }
  }
}
// --- Role Identity Display ---
// (Identity display moved into init)
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
    const files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.cjs') || f.endsWith('.js'));
    const main = files.find((f) => f === 'main.cjs' || f === 'main.js');
    if (main) return path.join(scriptsDir, main);
    if (files.length > 0) return path.join(scriptsDir, files[0]);
  }
  // 2. Search in dist/ (compiled TS)
  if (fs.existsSync(distDir)) {
    const files = fs.readdirSync(distDir).filter((f) => f.endsWith('.js'));
    const main = files.find((f) => f === 'main.js' || f === 'score.js');
    if (main) return path.join(distDir, main);
    if (files.length > 0) return path.join(distDir, files[0]);
  }
  return null;
}
async function runCommand() {
  const index = loadIndex();
  const skills = index.s || index.skills;
  let targetSkill = skillName;
  // UX: Interactive Selection if no skill name provided
  if (!targetSkill) {
    console.log(chalk.bold('\n\u25b6 Select a skill to run:'));
    const implemented = skills.filter(
      (s) => (s.s || s.status) === 'impl' || s.status === 'implemented'
    );
    implemented.slice(0, 10).forEach((s, i) => {
      console.log(`  ${chalk.cyan(i + 1 + '.')} ${s.n || s.name}`);
    });
    console.log(chalk.dim('  (Showing top 10... type name or search)'));

    targetSkill = (await ui.confirm('Run interactive search?'))
      ? await ui.ask('Enter skill name: ')
      : null;

    if (!targetSkill) process.exit(0);
  }

  const skill = skills.find((s) => (s.n || s.name) === targetSkill);
  if (!skill) {
    logger.error(`Skill "${skillName}" not found in index`);
    const similar = skills
      .filter((s) => (s.n || s.name).includes(skillName) || skillName.includes(s.n || s.name))
      .map((s) => s.n || s.name);
    if (similar.length > 0) logger.info(`Did you mean: ${similar.join(', ')}?`);
    process.exit(1);
  }
  const skillNameResolved = skill.n || skill.name;
  const skillDir = path.join(rootDir, skillNameResolved);
  // Use pre-resolved main path if available
  let script = null;
  const mainPath = skill.m || skill.main;
  if (mainPath) {
    const fullPath = path.join(rootDir, skillNameResolved, mainPath);
    if (fs.existsSync(fullPath)) script = fullPath;
  }
  if (!script) script = findScript(skillDir);
  if (!script) {
    logger.error(`Skill "${skillName}" has no runnable scripts (status may be "planned")`);
    process.exit(1);
  }
  // Clean arguments: remove the '--' separator if present so child processes can parse flags correctly
  const cleanArgs = skillArgs.filter((arg) => arg !== '--');
  const cmd = `node "${script}" ${cleanArgs.map((a) => `"${a}"`).join(' ')}`;
  try {
    const env = { ...process.env, GEMINI_FORMAT: 'human' };
    const output = execSync(cmd, { encoding: 'utf8', cwd: rootDir, stdio: 'pipe', env });
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
  let skills = index.s || index.skills;
  if (filter && ['implemented', 'planned', 'conceptual'].includes(filter)) {
    skills = skills.filter((s) => (s.s || s.status).startsWith(filter.substring(0, 4)));
  }
  // Load metrics for scores
  const { metrics } = require('./lib/metrics.cjs');
  const history = metrics.reportFromHistory();
  const scores = new Map();
  history.skills.forEach((s) => scores.set(s.skill, s.efficiencyScore));
  // Group by "Domain/Category" (simulated by path prefix or first tag)
  const groups = {};
  skills.forEach((s) => {
    const name = s.n || s.name;
    const skillMd = path.join(rootDir, name, 'SKILL.md');
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
  Object.keys(groups)
    .sort()
    .forEach((cat) => {
      console.log(chalk.bold.underline(`${cat}:`));
      groups[cat]
        .sort((a, b) => (a.n || a.name).localeCompare(b.n || b.name))
        .forEach((s) => {
          const name = s.n || s.name;
          const desc = s.d || s.description;
          // Check pre-resolved or find
          const hasScript = s.m || s.main || findScript(path.join(rootDir, name)) ? '+' : ' ';
          const score = scores.get(name) || '--';
          const scoreColor = score !== '--' && score < 70 ? chalk.yellow : chalk.green;
          console.log(
            `  [${hasScript}] ${name.padEnd(30)} ${scoreColor(String(score).padStart(3))} | ${desc.substring(0, 50)}`
          );
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
      if (
        propMatch &&
        arrayItems.length > 0 &&
        typeof arrayItems[arrayItems.length - 1] === 'object'
      ) {
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
      if (val === '') {
        inArray = true;
        arrayItems = [];
      } else fm[currentKey] = val;
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
  const skills = index.s || index.skills;
  const lowerKey = keyword.toLowerCase();
  const results = skills.filter(
    (s) =>
      (s.n || s.name).toLowerCase().includes(lowerKey) ||
      (s.d || s.description).toLowerCase().includes(lowerKey) ||
      (s.t || s.tags || []).some((tag) => tag.toLowerCase().includes(lowerKey))
  );
  if (results.length === 0) {
    console.log(`\nNo skills found matching "${keyword}"\n`);
    return;
  }
  // Sort: implemented first
  const sorted = results.sort((a, b) => {
    const aImpl = a.m || a.main || findScript(path.join(rootDir, a.n || a.name)) ? 0 : 1;
    const bImpl = b.m || b.main || findScript(path.join(rootDir, b.n || b.name)) ? 0 : 1;
    return aImpl - bImpl;
  });
  console.log(`\n${sorted.length} skills matching "${keyword}":\n`);
  for (const s of sorted) {
    const name = s.n || s.name;
    const desc = s.d || s.description;
    const hasScript = s.m || s.main || findScript(path.join(rootDir, name)) ? '+' : ' ';
    console.log(`  [${hasScript}] ${name.padEnd(35)} ${desc.substring(0, 60)}`);
    // Show arguments summary from SKILL.md
    const skillMd = path.join(rootDir, name, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      const content = fs.readFileSync(skillMd, 'utf8');
      const fm = parseFrontmatter(content);
      if (Array.isArray(fm.arguments) && fm.arguments.length > 0) {
        const argStr = fm.arguments
          .map((a) =>
            a.positional ? `<${a.name}>` : `--${a.name}${a.required === 'true' ? '*' : ''}`
          )
          .join(' ');
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
function showHelp() {
  console.log(`
${chalk.bold.cyan('Gemini Ecosystem CLI')} ${chalk.dim('v1.1.0')}
${chalk.bold('USAGE:')}
  node scripts/cli.cjs ${chalk.cyan('<command>')} [options]
${chalk.bold('COMMANDS:')}
  ${chalk.cyan('run')} <skill> [args]   ${chalk.dim('\u25aa')} Execute a specific skill
  ${chalk.cyan('list')} [status]        ${chalk.dim('\u25aa')} List available skills (implemented/planned)
  ${chalk.cyan('search')} <keyword>     ${chalk.dim('\u25aa')} Find skills by name or description
  ${chalk.cyan('info')} <skill>         ${chalk.dim('\u25aa')} Show detailed skill documentation
${chalk.bold('GLOBAL OPTIONS:')}
  -h, --help             ${chalk.dim('\u25aa')} Show this help message
  -v, --verbose          ${chalk.dim('\u25aa')} Enable detailed logging
  -y, --yes              ${chalk.dim('\u25aa')} Auto-confirm prompts
${chalk.bold('EXAMPLES:')}
  ${chalk.dim('$')} node scripts/cli.cjs run security-scanner --dir .
  ${chalk.dim('$')} node scripts/cli.cjs list implemented
  ${chalk.dim('$')} node scripts/cli.cjs info api-doc-generator
`);
}
async function init() {
  const roleConfig = fileUtils.getFullRoleConfig() || { active_role: 'Unknown', persona: 'The Generic AI' };
  
  // Scoped Execution Check
  const tokenArgIndex = args.indexOf('--token');
  if (tokenArgIndex !== -1) {
    const token = args[tokenArgIndex + 1];
    const { validateToken } = require('./lib/pulse-guard.cjs');
    const scopeData = validateToken(token);
    if (!scopeData) {
      logger.error('Invalid or expired Sovereign Token. Access denied.');
      process.exit(1);
    }
    process.env.GEMINI_MISSION_ID = scopeData.missionId;
    process.env.GEMINI_SCOPED_DIRS = scopeData.scope.allowedDirs.join(',');
    logger.info(`Scoped Mode active for mission: ${scopeData.missionId}`);
  }

  const currentRole = roleConfig.active_role;
  const personaName = roleConfig.persona;
  const mid = process.env.MISSION_ID || 'None';

  // UX: Personality Header
  const themes = {
    'Ecosystem Architect': { color: chalk.bgCyan.black, viewpoint: 'Can this scale to 100+ skills?' },
    'Reliability Engineer': { color: chalk.bgRed.white, viewpoint: 'Is the system stable and performing?' },
    'Security Reviewer': { color: chalk.bgBlack.yellow, viewpoint: 'Where are the hidden vulnerabilities?' },
    'CEO': { color: chalk.bgGold?.black || chalk.bgYellow.black, viewpoint: 'What is the ROI and long-term value?' },
    'Integration Steward': { color: chalk.bgMagenta.white, viewpoint: 'Are the interfaces consistent?' },
  };

  const theme = themes[currentRole] || { color: chalk.bgBlue.white, viewpoint: 'How can I assist today?' };

  console.log(
    `\n ${theme.color(` ${currentRole.toUpperCase()} MODE `)} ${chalk.bold(personaName)} ${chalk.dim(`(Mission: ${mid})`)}`
  );
  console.log(` ${chalk.italic.dim(`"Viewpoint: ${theme.viewpoint}"`)}\n`);

  // Routine Tasks Check
  const { getPendingTasks } = require('./task_manager.cjs');
  const pending = await getPendingTasks(currentRole);
  if (pending.length > 0) {
    console.log(chalk.bgMagenta.white.bold(` \u23f0 PENDING ROUTINES: ${pending.length} tasks `));
    pending.forEach(t => console.log(`   ${chalk.magenta('\u25aa')} ${t.name} ${chalk.dim(`(${t.layer})`)}`));
    console.log(chalk.dim('   Run "node scripts/task_manager.cjs" to process them.\n'));
  }

  await checkHealth(currentRole);
  if (args.includes('-h') || args.includes('--help') || !command) {
    showHelp(currentRole);
    process.exit(0);
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
      showHelp();
      process.exit(1);
  }
}
init().catch((err) => {
  logger.error(err.message);
  process.exit(1);
});
