import { logger, safeReadFile, safeWriteFile, pathResolver, safeReaddir, safeStat } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';

/**
 * Kyberion CLI v2.1 [SECURE-IO ENFORCED]
 * Strictly compliant with Layer 2 (Shield).
 */

const rootDir = pathResolver.rootDir();
const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  let skillName = args[1];
  let skillArgs = args.slice(2);

  // 1. Cognitive Layer: Automatic Context Hydration
  const missionId = process.env.MISSION_ID;
  if (missionId) {
    const statePath = path.join(rootDir, 'active/missions', missionId, 'mission-state.json');
    try {
      const stateContent = safeReadFile(statePath, { encoding: 'utf8' }) as string;
      const state = JSON.parse(stateContent);
      console.log(chalk.cyan(`\n🧠 BRAIN: Context hydrated from mission "${missionId}" (Status: ${state.status})`));
    } catch (_) {}
  }

  // 2. Persona Layer: Handle --branch flag
  const branchIdx = skillArgs.indexOf('--branch');
  if (branchIdx !== -1) {
    const branchId = skillArgs[branchIdx + 1];
    const patchPath = path.join(rootDir, 'knowledge/evolution/latent-wisdom', `${branchId}.json`);
    try {
      const patchContent = safeReadFile(patchPath, { encoding: 'utf8' }) as string;
      const patch = JSON.parse(patchContent);
      console.log(chalk.magenta(`\n🎭 PERSONA SWAP: Loading latent wisdom from branch "${branchId}"`));
      console.log(chalk.gray(`Rules: ${patch.delta_rules.join(', ')}`));
    } catch (_) {
      console.log(chalk.red(`\n❌ Error: Branch "${branchId}" not found in Wisdom Vault.`));
    }
    skillArgs.splice(branchIdx, 2);
  }

  if (command === 'run' && skillName) {
    const indexContent = safeReadFile(indexPath, { encoding: 'utf8' }) as string;
    const index = JSON.parse(indexContent);
    const skills = index.s || index.skills || [];
    const skill = skills.find((s: any) => s.n === skillName || s.name === skillName);

    if (!skill) {
      logger.error(`Skill "${skillName}" not found in index.`);
      return;
    }

    const script = resolveSkillPath(skill.path);
    if (!script) {
      logger.error(`Skill "${skillName}" has no runnable scripts.`);
      return;
    }

    const cleanArgs = skillArgs.filter(arg => arg !== '--');
    const cmd = `node "${script}" ${cleanArgs.map(a => `"${a}"`).join(' ')}`;
    console.log(chalk.blue(`🚀 ACTUATING: ${skillName}...`));
    
    try {
      const { execSync } = await import('node:child_process');
      execSync(cmd, { stdio: 'inherit', env: { ...process.env, MISSION_ID: missionId || '' } });
    } catch (err: any) {
      logger.error(`Execution failed: ${err.message}`);
    }
  } else {
    console.log(chalk.yellow('\n🌌 KYBERION CONSOLE v2.1 [SECURE-IO ENFORCED]'));
    console.log(chalk.gray('Usage: cli run <actuator> [args] [--branch <patchId>]'));
  }
}

function resolveSkillPath(skillPath: string) {
  // 1. Check for Actuators (libs/actuators/...)
  const actuatorDistPath = path.join(rootDir, 'dist', skillPath, 'src');
  if (fs.existsSync(actuatorDistPath)) {
    const files = fs.readdirSync(actuatorDistPath);
    const main = files.find(f => f === 'index.js' || f === 'main.js');
    if (main) return path.join(actuatorDistPath, main);
  }

  // 2. Check for legacy/other skills (dist/skills/...)
  const skillDistPath = path.join(rootDir, 'dist', skillPath, 'src');
  if (fs.existsSync(skillDistPath)) {
    const files = fs.readdirSync(skillDistPath);
    const main = files.find(f => f === 'index.js' || f === 'main.js');
    if (main) return path.join(skillDistPath, main);
  }
  return null;
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
