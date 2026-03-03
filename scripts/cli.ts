/**
 * scripts/cli.ts
 * Main entry point for the Gemini Ecosystem CLI (TypeScript Edition).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
const chalk: any = require('chalk').default || require('chalk');
import { logger, fileUtils, ui } from '@agent/core/core';

const rootDir = process.cwd();
const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');

interface SkillInfo {
  name?: string;
  n?: string;
  status?: string;
  s?: string;
  path?: string;
  main?: string;
  m?: string;
  risk?: string;
  r?: string;
  description?: string;
  d?: string;
  tags?: string[];
  t?: string[];
}

/**
 * Proactive Health Check
 */
async function checkHealth(role: string) {
  const govPath = path.join(rootDir, 'active/shared/governance-report.json');
  const perfDir = path.join(rootDir, 'evidence/performance');
  const recipePath = path.join(rootDir, 'knowledge/orchestration/remediation-recipes.json');

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
        const report = JSON.parse(fs.readFileSync(govPath, 'utf8'));
        if (report.overall_status !== 'compliant') {
          logger.warn('Ecosystem is currently NON-COMPLIANT.');
          if (fs.existsSync(recipePath)) {
            const recipes = JSON.parse(fs.readFileSync(recipePath, 'utf8'));
            if (recipes.NON_COMPLIANT) {
              console.log(chalk.cyan(`
⚙️  Auto-healing triggered: ${recipes.NON_COMPLIANT.description}`));
              try {
                execSync(recipes.NON_COMPLIANT.command, { stdio: 'inherit', cwd: rootDir });
                console.log(chalk.green('\n✔  Repair complete. Continuing...\n'));
              } catch (e: any) {
                logger.error(`Self-healing failed: ${e.message}`);
              }
            }
          }
        }
      }
    }
    // ... performance, integrity checks omitted for brevity in POC, 
    // but fully implemented in final version.
  }
}

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
    // Prioritize .js (compiled) over .cjs (legacy)
    const main = files.find(f => f === 'index.js' || f === 'main.js') || files.find(f => f === 'index.cjs');
    if (main) return path.join(scriptsDir, main);
  }
  
  return null;
}

async function runCommand() {
  const index = loadIndex();
  const skills: SkillInfo[] = index.s || index.skills;
  let targetSkill = skillName;

  if (!targetSkill) {
    console.log(chalk.bold('\n▶ Select a skill to run:'));
    const implemented = skills.filter(s => (s.s || s.status) === 'impl' || s.status === 'implemented');
    implemented.slice(0, 10).forEach((s, i) => console.log(`  ${chalk.cyan(i + 1 + '.')} ${s.n || s.name}`));
    targetSkill = (await ui.confirm('Run interactive search?')) ? await ui.ask('Enter skill name: ') : null;
    if (!targetSkill) process.exit(0);
  }

  const skill = skills.find(s => (s.n || s.name) === targetSkill);
  if (!skill) {
    logger.error(`Skill "${targetSkill}" not found in index`);
    process.exit(1);
  }

  const skillPath = skill.path || (skill.n || skill.name);
  const skillDir = path.join(rootDir, skillPath!);
  let script = null;
  const mainPath = skill.m || skill.main;
  
  if (mainPath) {
    const fullPath = path.join(skillDir, mainPath);
    if (fs.existsSync(fullPath)) script = fullPath;
  }
  
  if (!script) script = findScript(skillDir);
  if (!script) {
    logger.error(`Skill "${targetSkill}" has no runnable scripts.`);
    process.exit(1);
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
    case 'run': await runCommand(); break;
    case 'list': /* list implementation */ break;
    case 'system': /* system proxy implementation */ break;
    default:
      console.log('Available commands: run, list, info, system');
      process.exit(0);
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
