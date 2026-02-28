import '@agent/core/secure-io'; // Enforce security boundaries
import { runSkillAsync } from '@agent/core';
import { ui, logger } from '@agent/core/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { getAllSkills, syncSkill, installSkill, pushSkill, SkillEntry } from './lib.js';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

const argv = createStandardYargs().option('interactive', { alias: 'i', type: 'boolean', default: true }).parseSync();

async function dashboardMenu() {
  while (true) {
    console.log('\n' + '='.repeat(60));
    console.log('  \ud83d\udee0\ufe0f  Gemini Skills Management Dashboard');
    console.log('='.repeat(60) + '\n');
    console.log('Main Menu:');
    console.log('  1. List Skills & Status');
    console.log('  2. Sync All Skills (Git Pull)');
    console.log('  3. Install All Skills (npm install)');
    console.log('  4. Push All Skills (Git Commit & Push)');
    console.log('  5. Create New Skill');
    console.log('  6. Delete Skill');
    console.log('  0. Exit');

    const choice = await ui.ask('\nSelect an option: ');

    switch (choice) {
      case '1':
        await showSkillsStatus();
        break;
      case '2':
        await performBatchOperation('Syncing', syncSkill);
        break;
      case '3':
        await performBatchOperation('Installing', installSkill);
        break;
      case '4':
        await performPushOperation();
        break;
      case '5':
        await createNewSkill();
        break;
      case '6':
        await deleteSkill();
        break;
      case '0':
        console.log('Exiting dashboard. Goodbye!');
        return;
      default:
        console.log('Invalid option. Please try again.');
    }
  }
}

async function showSkillsStatus() {
  const spinner = ui.spinner('Analyzing skills');
  const skills = getAllSkills();
  spinner.stop(true);

  console.log('\n' + '-'.repeat(80));
  console.log(`| ${'Skill Name'.padEnd(30)} | ${'Category'.padEnd(12)} | ${'Status'.padEnd(15)} | ${'Git'.padEnd(10)} |`);
  console.log('-'.repeat(80));

  skills.forEach(skill => {
    const status = skill.isInstalled ? '\x1b[32m[INSTALLED]\x1b[0m' : '\x1b[33m[NOT INST]\x1b[0m';
    const gitStatus = skill.gitStatus 
      ? (skill.gitStatus.hasChanges ? '\x1b[31mModified\x1b[0m' : '\x1b[32mClean\x1b[0m')
      : '\x1b[90mN/A\x1b[0m';
    
    console.log(`| ${skill.name.padEnd(30)} | ${skill.category.padEnd(12)} | ${status.padEnd(24)} | ${gitStatus.padEnd(19)} |`);
  });
  console.log('-'.repeat(80) + '\n');

  await ui.confirm('Back to main menu?');
}

async function performBatchOperation(actionName: string, operation: (path: string) => string) {
  const skills = getAllSkills();
  console.log(`\n${actionName} ${skills.length} skills...`);

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
    const progress = ui.progressBar(i + 1, skills.length);
    process.stdout.write(`\r${progress} ${actionName} ${skill.name}...`);
    operation(skill.path);
  }
  process.stdout.write('\n');
  logger.success(`${actionName} complete for all skills.`);
  await ui.confirm('Press enter to continue...');
}

async function performPushOperation() {
  const message = await ui.ask('Enter commit message: ');
  if (!message) {
    console.log('Commit message is required. Aborting.');
    return;
  }
  await performBatchOperation('Pushing', (p) => pushSkill(p, message));
}

async function createNewSkill() {
  const name = await ui.ask('Enter new skill name: ');
  if (!name) return;
  const category = (await ui.ask('Enter category (default: utilities): ')) || 'utilities';
  const desc = await ui.ask('Enter description: ');

  try {
    const rootDir = path.resolve(__dirname, '../../../../');
    execSync(`node scripts/create_skill.cjs ${name} --category ${category} --description "${desc}"`, {
      cwd: rootDir,
      stdio: 'inherit'
    });
    logger.success(`Skill "${name}" created successfully.`);
  } catch (e: any) {
    logger.error(`Failed to create skill: ${e.message}`);
  }
  await ui.confirm('Press enter to continue...');
}

async function deleteSkill() {
  const name = await ui.ask('Enter skill name to delete: ');
  if (!name) return;
  
  const skills = getAllSkills();
  const skill = skills.find(s => s.name === name);
  
  if (!skill) {
    logger.error(`Skill "${name}" not found.`);
    await ui.confirm('Press enter to continue...');
    return;
  }

  const confirmed = await ui.confirm(`Are you SURE you want to delete "${name}"? This will physically remove the directory.`);
  if (!confirmed) return;

  try {
    const rootDir = path.resolve(__dirname, '../../../../');
    const fullPath = path.resolve(rootDir, skill.path);
    fs.rmSync(fullPath, { recursive: true, force: true });
    logger.success(`Skill "${name}" deleted.`);
    
    // Regenerate index
    execSync('node scripts/generate_skill_index.cjs', { cwd: rootDir });
  } catch (e: any) {
    logger.error(`Failed to delete skill: ${e.message}`);
  }
  await ui.confirm('Press enter to continue...');
}

if (typeof process !== 'undefined' && !process.env.VITEST) {
  runSkillAsync('github-skills-manager', async () => {
    if (argv.interactive) {
      await dashboardMenu();
      return { status: 'success', mode: 'interactive' };
    } else {
      const skills = getAllSkills();
      return { repositories: skills };
    }
  });
}
