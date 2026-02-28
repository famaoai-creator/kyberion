const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const { logger } = require('../libs/core/core.cjs');

const rootDir = path.resolve(__dirname, '..');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

// --- Domain & Role Definitions ---
const rolesDataPath = path.resolve(rootDir, 'knowledge/personalities/roles.json');
let DOMAINS = {};
let ROLE_SKILLS = {};
try {
  const rolesData = JSON.parse(fs.readFileSync(rolesDataPath, 'utf8'));
  DOMAINS = rolesData.domains;
  ROLE_SKILLS = rolesData.roles;
} catch (e) {
  console.error('Failed to load roles data from ' + rolesDataPath);
  process.exit(1);
}

async function main() {
  console.clear();
  console.log('Welcome to Gemini Skills Ecosystem Setup Wizard (Hierarchical Edition)\n');

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
  console.log(`Professional Domain: ${selectedDomain.name}\n`);
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

  // 3. Ensure Directory Structure & .gitkeep
  const personalDir = path.resolve(rootDir, 'knowledge/personal');
  const confidentialDir = path.resolve(rootDir, 'knowledge/confidential');
  
  // 3.1. Personal is always local
  if (!fs.existsSync(personalDir)) {
    fs.mkdirSync(personalDir, { recursive: true });
    logger.info(`Created local personal directory: knowledge/personal`);
  }
  fs.writeFileSync(path.join(personalDir, '.gitkeep'), '');

  // 3.2. Confidential can be a remote sync target
  const syncConfidential = await askQuestion('\nStep 3: Do you want to sync Confidential knowledge with a remote repository? (y/N): ');
  if (syncConfidential.toLowerCase() === 'y') {
    const repoUrl = await askQuestion('Enter the Git repository URL for Confidential knowledge: ');
    if (repoUrl) {
      try {
        logger.info(`Linking knowledge/confidential to ${repoUrl}...`);
        // Use sovereign-sync if available, else direct git
        execSync(`node scripts/cli.cjs run sovereign-sync -- init confidential "${repoUrl}"`, {
          stdio: 'inherit',
          cwd: rootDir,
        });
        logger.success('Confidential knowledge synced and linked.');
      } catch (e) {
        logger.error(`Failed to sync confidential repo: ${e.message}`);
        logger.info('Falling back to local confidential directory.');
        if (!fs.existsSync(confidentialDir)) fs.mkdirSync(confidentialDir, { recursive: true });
      }
    }
  } else {
    if (!fs.existsSync(confidentialDir)) {
      fs.mkdirSync(confidentialDir, { recursive: true });
      logger.info('Created local confidential directory: knowledge/confidential');
    }
  }
  fs.writeFileSync(path.join(confidentialDir, '.gitkeep'), '');

  // 4. Save role config (Updated Schema)
  const roleConfigPath = path.join(personalDir, 'role-config.json');
  const config = {
    active_role: roleName,
    persona: `The ${roleName}`,
    mission: roleConfig.description,
    tier_access: 'personal',
    recommended_skills: roleConfig.skills,
    last_initialized: new Date().toISOString(),
  };

  fs.writeFileSync(roleConfigPath, JSON.stringify(config, null, 2));
  logger.success(`Role saved to knowledge/personal/role-config.json (Ready for Gemini CLI)`);

  // 5. Base Setup
  try {
    logger.info('Installing core dependencies (pnpm install)...');
    execSync('pnpm install', { stdio: 'inherit', cwd: rootDir });
  } catch (_e) {
    logger.error('Dependency installation failed.');
  }

  // 5. Index Generation
  try {
    logger.info('Generating Global Skill Index...');
    execSync('node scripts/generate_skill_index.cjs', { stdio: 'inherit', cwd: rootDir });
  } catch (_e) {
    logger.error('Failed to generate skill index.');
  }

  // 6. Setup Confidential hierarchy
  const setupScript = path.join(rootDir, 'scripts/setup_ecosystem.sh');
  if (fs.existsSync(setupScript)) {
    try {
      logger.info('Setting up Confidential knowledge hierarchy...');
      execSync(`bash "${setupScript}"`, { stdio: 'inherit', cwd: rootDir });
    } catch (_e) {
      logger.error('Ecosystem setup had issues.');
    }
  }

  // 7. Generate role-based skill bundle
  try {
    const missionName = `${roleName.toLowerCase().replace(/ /g, '-').replace(/&/g, 'and')}-starter`;
    const skillArgs = roleConfig.skills.join(' ');
    logger.info(`Generating starter bundle "${missionName}"...`);

    // Use cli.cjs instead of direct path to resolve hierarchical location
    execSync(`node scripts/cli.cjs run skill-bundle-packager -- ${missionName} ${skillArgs}`, {
      stdio: 'inherit',
      cwd: rootDir,
    });
    logger.success(`Bundle created: active/shared/bundles/${missionName}/bundle.json`);
  } catch (_e) {
    logger.error('Bundle generation failed.');
  }

  // 8. Final Output
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Setup complete for role: ${roleName}`);
  console.log(`Domain: ${selectedDomain.name}`);
  console.log(`${'='.repeat(60)}\n`);

  if (roleConfig.playbook) {
    console.log(`Recommended Playbook: ${roleConfig.playbook}`);
  }

  console.log(`\nNext Step: node scripts/cli.cjs run codebase-mapper -- .`);
  console.log('Or visit the Knowledge Portal: npm run portal');
  console.log('');

  rl.close();
}

main();
