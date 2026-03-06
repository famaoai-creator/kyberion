import chalk from 'chalk';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { logger, safeWriteFile, safeReadFile, safeExec } from '@agent/core';

/**
 * scripts/init_wizard.ts
 * [SECURE-IO COMPLIANT VERSION]
 */

const rootDir = process.cwd();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const askQuestion = (query: string): Promise<string> => new Promise((resolve) => rl.question(query, resolve));

// --- Domain & Role Definitions ---
const rolesDataPath = path.resolve(rootDir, 'knowledge/personalities/roles.json');

interface Domain {
  name: string;
  roles: Record<string, string>;
}

interface RoleConfig {
  description: string;
  skills: string[];
  playbook?: string;
}

interface RolesData {
  domains: Record<string, Domain>;
  roles: Record<string, RoleConfig>;
}

async function main() {
  let rolesData: RolesData;
  try {
    const rawData = safeReadFile(rolesDataPath, { encoding: 'utf8' }) as string;
    rolesData = JSON.parse(rawData);
  } catch (e) {
    console.error('Failed to load roles data from ' + rolesDataPath);
    process.exit(1);
  }

  const DOMAINS = rolesData.domains;
  const ROLE_SKILLS = rolesData.roles;

  console.clear();
  console.log(chalk.bold.green('Welcome to Gemini Skills Ecosystem Setup Wizard\n'));

  // 1. Domain Selection
  console.log('Step 1: Select your professional domain:');
  Object.keys(DOMAINS).forEach((id) => {
    console.log(`${id}. ${DOMAINS[id].name}`);
  });

  const domainChoice = await askQuestion('\nEnter number (1-5): ');
  const selectedDomain = DOMAINS[domainChoice];

  if (!selectedDomain) {
    console.log('Invalid domain choice. Exiting.');
    rl.close();
    return;
  }

  // 2. Role Selection
  console.clear();
  console.log(chalk.bold.cyan(`Professional Domain: ${selectedDomain.name}\n`));
  console.log('Step 2: Select your specific role:');
  Object.keys(selectedDomain.roles).forEach((id) => {
    console.log(`${id}. ${selectedDomain.roles[id]}`);
  });

  const roleChoice = await askQuestion('\nEnter number: ');
  const roleName = selectedDomain.roles[roleChoice];
  const roleConfig = ROLE_SKILLS[roleName];

  if (!roleConfig) {
    console.log('Invalid role choice. Exiting.');
    rl.close();
    return;
  }

  logger.info(`Initializing environment for role: ${roleName}...`);

  // 3. Ensure Sovereign Directory Standard
  // safeWriteFile handles directory creation automatically.
  // We write empty .gitkeep to ensure they exist.
  const essentialDirs = [
    'knowledge/personal/.gitkeep',
    'knowledge/confidential/.gitkeep',
    'vault/.gitkeep',
    'active/projects/.gitkeep',
    'active/missions/.gitkeep',
    'active/shared/governance/.gitkeep',
    'active/shared/runtime/vision/frames/.gitkeep',
    'scratch/.gitkeep',
    'presence/bridge/.gitkeep',
    'presence/sensors/.gitkeep'
  ];

  essentialDirs.forEach(file => {
    safeWriteFile(path.join(rootDir, file), '');
  });

  const personalDir = path.resolve(rootDir, 'knowledge/personal');
  const confidentialDir = path.resolve(rootDir, 'knowledge/confidential');

  // 3.2. Confidential Knowledge Sync
  const syncConf = await askQuestion('\nStep 3: Sync Confidential knowledge with a remote repository? (y/N): ');
  if (syncConf.toLowerCase() === 'y') {
    const repoUrl = await askQuestion('Enter the Git repository URL for Confidential knowledge: ');
    if (repoUrl) {
      try {
        logger.info(`Linking knowledge/confidential to ${repoUrl}...`);
        await safeExec('node', ['dist/scripts/cli.js', 'run', 'sovereign-sync', '--', 'init', 'confidential', repoUrl]);
        logger.success('Confidential knowledge synced and linked.');
      } catch (e: any) {
        logger.error(`Failed to sync: ${e.message}`);
      }
    }
  }

  // 4. Save identity and session
  const identityPath = path.join(personalDir, 'my-identity.json');
  const sessionPath = path.resolve(rootDir, 'active/shared/governance/session.json');
  
  const identity = {
    owner_name: 'Sovereign User',
    preferred_language: 'ja',
    interaction_style: 'YOLO/Concise',
    last_initialized: new Date().toISOString(),
  };
  safeWriteFile(identityPath, JSON.stringify(identity, null, 2));

  const sessionConfig = {
    active_role: roleName,
    persona: `The ${roleName}`,
    mission: roleConfig.description,
    tier_access: 'personal',
    recommended_skills: roleConfig.skills,
    timestamp: new Date().toISOString(),
  };
  safeWriteFile(sessionPath, JSON.stringify(sessionConfig, null, 2));
  logger.success('Context and Identity updated safely.');

  // --- 4.2. Vision Infusion ---
  console.clear();
  console.log(chalk.bold.magenta('\n✨ Step 4: Vision Infusion (The Soul)'));
  console.log('What is your overarching vision for this ecosystem?');
  
  const userVision = await askQuestion(chalk.cyan('\nYour Vision: '));
  
  if (userVision) {
    const visionPath = path.join(rootDir, 'knowledge/personal/my-vision.md');
    const visionContent = `# My Sovereign Vision\n\n**Stated on**: ${new Date().toLocaleDateString()}\n\n> ${userVision}\n\n---\n*Ultimate guiding light.*\n`;
    safeWriteFile(visionPath, visionContent);
    logger.success('Vision infused safely.');
  }

  console.log(`\n${chalk.bold('='.repeat(60))}`);
  console.log(`Setup complete for role: ${roleName}`);
  console.log(chalk.bold('='.repeat(60)) + '\n');

  console.log(chalk.bold('🚀 Next Steps (Critical):'));
  console.log(`1. ${chalk.cyan('npm run build')}        - Generate binary logic`);
  console.log(`2. ${chalk.cyan('npm run vision:start')} - Activate agent sight`);
  
  console.log('\nTo begin:');
  console.log(chalk.green('node dist/scripts/cli.js run codebase-mapper -- .'));
  console.log('\n');

  rl.close();
}

main().catch(err => {
  console.error(err);
  rl.close();
  process.exit(1);
});
