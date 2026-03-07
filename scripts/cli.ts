/**
 * scripts/cli.ts
 * Main entry point for the Gemini Ecosystem CLI (TypeScript Edition).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { logger, fileUtils, ui } from '@agent/core/core';

const rootDir = process.cwd();
const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');
const govPath = path.join(rootDir, 'knowledge/personal/role-config.json');

const args = process.argv.slice(2);
const command = args[0];
let skillName = args[1];
let skillArgs = args.slice(2);

// Persona Swapper: Handle --branch flag
const branchIdx = skillArgs.indexOf('--branch');
let activeBranch: any = null;
if (branchIdx !== -1) {
  const branchId = skillArgs[branchIdx + 1];
  const patchPath = path.join(rootDir, 'knowledge/evolution/latent-wisdom', `${branchId}.json`);
  if (fs.existsSync(patchPath)) {
    activeBranch = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
    console.log(chalk.magenta(`\n🎭 PERSONA SWAP: Loading latent wisdom from branch "${branchId}"`));
    console.log(chalk.gray(`Rules: ${activeBranch.delta_rules.join(', ')}`));
  } else {
    console.log(chalk.red(`\n❌ Error: Branch "${branchId}" not found in Wisdom Vault.`));
  }
  // Remove flag and value from args before passing to skill
  skillArgs.splice(branchIdx, 2);
}

function loadIndex() {
  if (!fs.existsSync(indexPath)) return { skills: [] };
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

function findScript(skillDir: string): string | null {
  const distDir = path.join(skillDir, 'dist');
  const scriptsDir = path.join(skillDir, 'scripts');
  
  // 1. Direct local dist
  if (fs.existsSync(distDir)) {
    const files = fs.readdirSync(distDir);
    const main = files.find(f => f === 'index.js' || f === 'main.js');
    if (main) return path.join(distDir, main);
  }
  
  // 2. Monorepo nested dist (ROOT/dist/skills/CATEGORY/NAME/src/index.js)
  const relPath = path.relative(rootDir, skillDir);
  const nestedDist = path.join(rootDir, 'dist', relPath, 'src', 'index.js');
  if (fs.existsSync(nestedDist)) return nestedDist;

  // 3. Local scripts
  if (fs.existsSync(scriptsDir)) {
    const files = fs.readdirSync(scriptsDir);
    const main = files.find(f => f === 'index.js' || f === 'main.js') || files.find(f => f === 'index.cjs');
    if (main) return path.join(scriptsDir, main);
  }
  
  return null;
}

async function checkHealth(role: string) {
  const priorities: Record<string, string[]> = {
    'Ecosystem Architect': ['integrity', 'governance', 'debt'],
    'Reliability Engineer': ['performance', 'governance'],
    'Security Reviewer': ['pii', 'governance'],
    CEO: ['debt', 'governance', 'performance'],
  };

  const myPriorities = priorities[role] || ['governance', 'performance'];

  for (const p of myPriorities) {
    if (p === 'governance') {
      if (fs.existsSync(govPath)) {
        // Governance check logic could go here
      } else {
        logger.warn('Ecosystem is currently NON-COMPLIANT.');
        try {
          console.log(chalk.yellow('⚙️  Auto-healing triggered: Run the self-healing health check'));
          execSync('node dist/scripts/check_skills_health.js --fix', { stdio: 'inherit', cwd: rootDir });
        } catch (err) {
          logger.error('Self-healing failed: ' + (err as Error).message);
        }
      }
    }
  }
}

function logResponse(text: string) {
  try {
    const sharedDir = path.join(rootDir, 'active/shared');
    if (!fs.existsSync(sharedDir)) fs.mkdirSync(sharedDir, { recursive: true });
    const envelope = {
      skill: 'cli-direct',
      status: 'success',
      data: { message: text },
      metadata: { timestamp: new Date().toISOString(), duration_ms: 0 }
    };
    fs.writeFileSync(path.join(sharedDir, 'last_response.json'), JSON.stringify(envelope, null, 2), 'utf8');
  } catch (_) {}
}

function isSkillRestricted(name: string): { restricted: boolean; reason?: string } {
  try {
    const restrictedPath = path.join(rootDir, 'knowledge/governance/restricted-skills.json');
    if (fs.existsSync(restrictedPath)) {
      const data = JSON.parse(fs.readFileSync(restrictedPath, 'utf8'));
      const restriction = data.restrictions.find((r: any) => r.name === name);
      if (restriction && restriction.status === 'restricted') {
        return { restricted: true, reason: restriction.reason };
      }
    }
  } catch (_) {}
  return { restricted: false };
}

async function runCommand() {
  const index = loadIndex();
  const skills = index.s || index.skills || [];
  const skill = skills.find((s: any) => s.n === skillName || s.name === skillName);

  if (!skill) {
    const errorMsg = `Skill "${skillName}" not found in index`;
    logger.error(errorMsg);
    logResponse(errorMsg);
    return;
  }

  // 1. Governance Restriction Check
  const restriction = isSkillRestricted(skillName);
  if (restriction.restricted) {
    const errorMsg = `🚫 Skill "${skillName}" is RESTRICTED by governance policy.\nReason: ${restriction.reason}`;
    logger.error(errorMsg);
    logResponse(errorMsg);
    return;
  }

  // 2. Platform Compatibility Check (Static)
  const currentPlatform = os.platform();
  const rawPlatforms = skill.p || [];
  const supportedPlatforms = Array.isArray(rawPlatforms) ? rawPlatforms : [rawPlatforms];
  
  if (supportedPlatforms.length > 0 && !supportedPlatforms.includes(currentPlatform)) {
    const errorMsg = `❌ Skill "${skillName}" is not supported on ${currentPlatform}. Supported: ${supportedPlatforms.join(', ')}`;
    logger.error(errorMsg);
    logResponse(errorMsg);
    return;
  }

  const script = findScript(path.join(rootDir, skill.path));
  if (!script) {
    const errorMsg = `Skill "${skillName}" has no runnable scripts.`;
    logger.error(errorMsg);
    logResponse(errorMsg);
    return;
  }

  const cleanArgs = skillArgs.filter(arg => arg !== '--');
  const cmd = `node "${script}" ${cleanArgs.map(a => `"${a}"`).join(' ')}`;
  
  try {
    execSync(cmd, { stdio: 'inherit', cwd: rootDir, env: { ...process.env, GEMINI_FORMAT: 'human' } });
  } catch (err: any) {
    process.exit(err.status || 1);
  }
}

async function main() {
  const roleConfig = fileUtils.getFullRoleConfig() || { active_role: 'Ecosystem Architect', persona: 'The Architect' };
  const currentRole = roleConfig.active_role;

  console.log(chalk.bold.magenta('\n🌌 KYBERION CONSOLE'));
  console.log(chalk.dim('The High-Fidelity Autonomous Engineering Ecosystem'));
  console.log(`Role: ${chalk.bold.cyan(currentRole)} | Mission: ${process.env.MISSION_ID ? chalk.yellow(process.env.MISSION_ID) : 'None'}\n`);

  await checkHealth(currentRole);

  switch (command) {
    case 'run': 
      await runCommand(); 
      break;
    case 'list':
      console.log('List of skills not implemented in this proxy.');
      break;
    case 'system':
      const serviceAction = args[1] || 'status';
      try {
        if (serviceAction === 'create-skill') {
          const cat = args[2];
          const nom = args[3];
          if (!cat || !nom) {
            console.log('Usage: system create-skill <category> <skill-name>');
          } else {
            execSync(`npx tsx scripts/create_skill.ts ${cat} ${nom}`, { stdio: 'inherit', cwd: rootDir });
          }
        } else {
          execSync(`npx tsx scripts/service_manager.ts ${serviceAction}`, { stdio: 'inherit', cwd: rootDir });
        }
      } catch (err: any) {
        process.exit(err.status || 1);
      }
      break;
    default:
      const helpMsg = 'Available commands: run, list, info, system';
      console.log(helpMsg);
      logResponse(helpMsg);
  }
}

main().catch(err => {
  const errorMsg = (err as Error).message;
  logger.error(errorMsg);
  logResponse(errorMsg);
  process.exit(1);
});
