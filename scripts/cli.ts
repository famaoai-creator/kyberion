/**
 * scripts/cli.ts
 * Main entry point for the Gemini Ecosystem CLI (TypeScript Edition).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { logger, fileUtils, ui } from '@agent/core/core';

const rootDir = process.cwd();
const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');
const govPath = path.join(rootDir, 'knowledge/personal/role-config.json');

const args = process.argv.slice(2);
const command = args[0];
const skillName = args[1];
const skillArgs = args.slice(2);

function loadIndex() {
  if (!fs.existsSync(indexPath)) return { skills: [] };
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

function findScript(skillDir: string): string | null {
  const distDir = path.join(skillDir, 'dist');
  const scriptsDir = path.join(skillDir, 'scripts');
  
  if (fs.existsSync(distDir)) {
    const files = fs.readdirSync(distDir);
    const main = files.find(f => f === 'index.js' || f === 'main.js');
    if (main) return path.join(distDir, main);
  }
  
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

  console.log(chalk.bold.cyan('\n=== Gemini Ecosystem CLI (TS) ==='));
  console.log(`Role: ${chalk.bold(currentRole)} | Mission: ${process.env.MISSION_ID || 'None'}\n`);

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
