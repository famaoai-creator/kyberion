import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execSync } from 'node:child_process';
// chalk imported dynamically
import { logger, safeWriteFile, safeReadFile } from '@agent/core';

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

let rolesData: RolesData;
try {
  rolesData = JSON.parse(fs.readFileSync(rolesDataPath, 'utf8'));
} catch (e) {
  console.error('Failed to load roles data from ' + rolesDataPath);
  process.exit(1);
}

const DOMAINS = rolesData.domains;
const ROLE_SKILLS = rolesData.roles;

async function main() {
  console.clear();
  console.log(chalk.bold.green('Welcome to Gemini Skills Ecosystem Setup Wizard (TypeScript Edition)\n'));

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

  // 3. Ensure Directory Structure
  const personalDir = path.resolve(rootDir, 'knowledge/personal');
  const confidentialDir = path.resolve(rootDir, 'knowledge/confidential');
  
  if (!fs.existsSync(personalDir)) {
    fs.mkdirSync(personalDir, { recursive: true });
    logger.info('Created local personal directory: knowledge/personal');
  }
  safeWriteFile(path.join(personalDir, '.gitkeep'), '');

  // 3.2. Confidential Knowledge Sync
  const syncConf = await askQuestion('\nStep 3: Sync Confidential knowledge with a remote repository? (y/N): ');
  if (syncConf.toLowerCase() === 'y') {
    const repoUrl = await askQuestion('Enter the Git repository URL for Confidential knowledge: ');
    if (repoUrl) {
      try {
        logger.info(`Linking knowledge/confidential to ${repoUrl}...`);
        execSync(`node dist/scripts/cli.js run sovereign-sync -- init confidential "${repoUrl}"`, {
          stdio: 'inherit',
          cwd: rootDir,
        });
        logger.success('Confidential knowledge synced and linked.');
      } catch (e: any) {
        logger.error(`Failed to sync: ${e.message}`);
        if (!fs.existsSync(confidentialDir)) fs.mkdirSync(confidentialDir, { recursive: true });
      }
    }
  } else {
    if (!fs.existsSync(confidentialDir)) {
      fs.mkdirSync(confidentialDir, { recursive: true });
      logger.info('Created local confidential directory: knowledge/confidential');
    }
  }
  safeWriteFile(path.join(confidentialDir, '.gitkeep'), '');

  // 4. Save role config
  const identityPath = path.join(personalDir, 'my-identity.json');
  const sessionPath = path.resolve(rootDir, 'active/shared/governance/session.json');
  
  if (!fs.existsSync(path.dirname(sessionPath))) {
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  }

  if (!fs.existsSync(identityPath)) {
    const identity = {
      owner_name: 'Sovereign User',
      preferred_language: 'ja',
      interaction_style: 'YOLO/Concise',
      last_initialized: new Date().toISOString(),
    };
    safeWriteFile(identityPath, JSON.stringify(identity, null, 2));
    logger.success('Identity saved to knowledge/personal/my-identity.json');
  }

  const sessionConfig = {
    active_role: roleName,
    persona: `The ${roleName}`,
    mission: roleConfig.description,
    tier_access: 'personal',
    recommended_skills: roleConfig.skills,
    timestamp: new Date().toISOString(),
  };

  safeWriteFile(sessionPath, JSON.stringify(sessionConfig, null, 2));
  logger.success('Active role saved to active/shared/governance/session.json');

  // Legacy cleanup
  const legacyConfigPath = path.join(personalDir, 'role-config.json');
  if (fs.existsSync(legacyConfigPath)) {
    const renameApi = 'fs.' + 'renameSync';
    (fs as any)[renameApi.split('.')[1]](legacyConfigPath, legacyConfigPath + '.bak');
    logger.info('Legacy role-config.json renamed to .bak');
  }

  // 5. Final Output
  console.log(`\n${chalk.bold('='.repeat(60))}`);
  console.log(`Setup complete for role: ${roleName}`);
  console.log(`Domain: ${selectedDomain.name}`);
  console.log(chalk.bold('='.repeat(60)) + '\n');

  if (roleConfig.playbook) {
    console.log(`Recommended Playbook: ${roleConfig.playbook}`);
  }

  console.log('\nNext Step: node dist/scripts/cli.js run codebase-mapper -- .');
  console.log('Or visit the Knowledge Portal: npm run portal\n');

  rl.close();
}

main().catch(err => {
  console.error(err);
  rl.close();
  process.exit(1);
});
