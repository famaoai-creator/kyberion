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
const DOMAINS = {
  1: {
    name: 'Leadership & Strategy',
    roles: {
      1: 'CEO',
      2: 'Business Owner',
      3: 'Product Manager',
    },
  },
  2: {
    name: 'Engineering & Operations',
    roles: {
      1: 'Software Engineer',
      2: 'Software Developer',
      3: 'Ecosystem Architect',
      4: 'Reliability Engineer',
      5: 'Incident Commander',
      6: 'Performance Engineer',
      7: 'Integration Steward',
    },
  },
  3: {
    name: 'Business & Growth',
    roles: {
      1: 'Strategic Sales',
      2: 'Marketing & Growth',
      3: 'Customer Success',
    },
  },
  4: {
    name: 'Governance & Quality',
    roles: {
      1: 'PMO Governance',
      2: 'Quality Assurance',
      3: 'Legal & IP Strategist',
      4: 'Cyber Security Lead',
    },
  },
  5: {
    name: 'Support & Stewardship',
    roles: {
      1: 'Executive Assistant',
      2: 'Knowledge Steward',
      3: 'Line Manager',
    },
  },
};

const ROLE_SKILLS = {
  CEO: {
    skills: [
      'release-note-crafter',
      'project-health-check',
      'license-auditor',
      'cloud-cost-estimator',
      'pr-architect',
      'onboarding-wizard',
      'asset-token-economist',
      'dependency-lifeline',
      'skill-evolution-engine',
      'sustainability-consultant',
    ],
    playbook: 'knowledge/orchestration/mission-playbooks/ceo-strategy.md',
    description: 'Strategy, Finance, Org, and Ecosystem Stewardship',
  },
  'Business Owner': {
    skills: [
      'business-impact-analyzer',
      'strategic-roadmap-planner',
      'financial-modeling-maestro',
      'scenario-multiverse-orchestrator',
      'executive-reporting-maestro',
      'stakeholder-communicator',
      'budget-variance-tracker',
      'competitive-intel-strategist',
    ],
    playbook: 'knowledge/orchestration/mission-playbooks/ceo-strategy.md',
    description: 'P&L Responsibility, Strategic Alignment, and Market Success',
  },
  'Product Manager': {
    skills: [
      'requirements-wizard',
      'strategic-roadmap-planner',
      'ux-auditor',
      'telemetry-insight-engine',
      'business-impact-analyzer',
      'doc-sync-sentinel',
      'scenario-multiverse-orchestrator',
      'stakeholder-communicator',
    ],
    playbook: 'knowledge/orchestration/mission-playbooks/product-audit.md',
    description: 'Product Vision, Roadmap, and Requirement Definition',
  },
  'Software Engineer': {
    skills: [
      'codebase-mapper',
      'local-reviewer',
      'security-scanner',
      'quality-scorer',
      'log-analyst',
      'bug-predictor',
      'refactoring-engine',
      'test-genie',
    ],
    description: 'DevOps & Tooling',
  },
  'Software Developer': {
    skills: [
      'boilerplate-genie',
      'refactoring-engine',
      'test-suite-architect',
      'api-fetcher',
      'data-transformer',
      'template-renderer',
      'codebase-mapper',
      'local-reviewer',
      'issue-to-solution-bridge',
      'kernel-compiler',
      'technology-porter',
    ],
    description: 'Product Implementation',
  },
  'Ecosystem Architect': {
    skills: [
      'autonomous-skill-designer',
      'skill-evolution-engine',
      'skill-quality-auditor',
      'knowledge-auditor',
      'codebase-mapper',
      'boilerplate-genie',
      'dependency-grapher',
      'document-generator',
    ],
    description: 'Monorepo Maintenance',
  },
  'Reliability Engineer': {
    skills: [
      'crisis-manager',
      'self-healing-orchestrator',
      'log-analyst',
      'chaos-monkey-orchestrator',
      'sustainability-consultant',
      'cloud-cost-estimator',
      'monitoring-config-auditor',
      'disaster-recovery-planner',
      'log-to-requirement-bridge',
    ],
    description: 'SRE & Cost',
  },
  'Incident Commander': {
    skills: [
      'crisis-manager',
      'stakeholder-communicator',
      'executive-reporting-maestro',
      'slack-communicator-pro',
      'log-analyst',
      'document-generator',
      'knowledge-fetcher',
    ],
    description: 'Crisis Coordination, Remediation Strategy, and Incident Reporting',
  },
  'Performance Engineer': {
    skills: [
      'performance-monitor-analyst',
      'cloud-waste-hunter',
      'cloud-cost-estimator',
      'cognitive-load-auditor',
      'refactoring-engine',
      'log-analyst',
      'benchmark',
      'unit-economics-optimizer',
    ],
    description: 'Performance Evaluation, Resource Optimization, and Scalability',
  },
  'Strategic Sales': {
    skills: [
      'competitive-intel-strategist',
      'business-growth-planner',
      'stakeholder-communicator',
      'ppt-artisan',
      'document-generator',
      'investor-readiness-audit',
      'ip-profitability-architect',
    ],
    description: 'Business Development',
  },
  'Marketing & Growth': {
    skills: [
      'competitive-intel-strategist',
      'business-growth-planner',
      'stakeholder-communicator',
      'ppt-artisan',
      'document-generator',
      'scenario-multiverse-orchestrator',
    ],
    description: 'Market Fit & Branding',
  },
  'Customer Success': {
    skills: [
      'automated-support-architect',
      'telemetry-insight-engine',
      'slack-communicator-pro',
      'doc-sync-sentinel',
      'ux-auditor',
      'api-doc-generator',
    ],
    description: 'Support & Adoption',
  },
  'PMO Governance': {
    skills: [
      'pmo-governance-lead',
      'project-health-check',
      'knowledge-auditor',
      'skill-quality-auditor',
      'budget-variance-tracker',
      'executive-reporting-maestro',
      'onboarding-wizard',
      'dependency-lifeline',
    ],
    description: 'Quality Gates & Risk',
  },
  'Quality Assurance': {
    skills: [
      'test-genie',
      'test-suite-architect',
      'test-viewpoint-analyst',
      'ux-auditor',
      'quality-scorer',
      'completeness-scorer',
      'requirements-wizard',
      'doc-sync-sentinel',
      'api-evolution-manager',
    ],
    description: 'QA/QC & Evidence',
  },
  'Legal & IP Strategist': {
    skills: [
      'ip-strategist',
      'ip-profitability-architect',
      'license-auditor',
      'compliance-officer',
      'ai-ethics-auditor',
      'sensitivity-detector',
      'data-lineage-guardian',
    ],
    description: 'Compliance & IP',
  },
  'Cyber Security Lead': {
    skills: [
      'security-scanner',
      'red-team-adversary',
      'post-quantum-shield',
      'supply-chain-sentinel',
      'ai-ethics-auditor',
      'compliance-officer',
      'crisis-manager',
      'data-lineage-guardian',
    ],
    description: 'Defense & Vulnerability',
  },
  'Executive Assistant': {
    skills: [
      'google-workspace-integrator',
      'slack-communicator-pro',
      'doc-sync-sentinel',
      'release-note-crafter',
      'asset-token-economist',
      'knowledge-fetcher',
      'word-artisan',
      'ppt-artisan',
      'document-generator',
    ],
    description: 'Support & Coordination',
  },
  'Knowledge Steward': {
    skills: [
      'knowledge-harvester',
      'knowledge-fetcher',
      'knowledge-refiner',
      'knowledge-auditor',
      'data-collector',
      'doc-to-text',
      'api-fetcher',
      'box-connector',
      'google-workspace-integrator',
      'auto-context-mapper',
      'glossary-resolver',
    ],
    description: 'Data Collection',
  },
  'Line Manager': {
    skills: [
      'onboarding-wizard',
      'slack-communicator-pro',
      'biometric-context-adapter',
      'pr-architect',
      'project-health-check',
      'skill-bundle-packager',
      'stakeholder-communicator',
      'budget-variance-tracker',
    ],
    description: 'Approvals & Team Health',
  },
  'Experience Designer': {
    skills: [
      'ux-auditor',
      'layout-architect',
      'synthetic-user-persona',
      'diagram-renderer',
      'ppt-artisan',
      'html-reporter',
      'document-generator',
      'requirements-wizard',
    ],
    description: 'UX, UI, & Design Systems',
  },
  'Finance Controller': {
    skills: [
      'financial-modeling-maestro',
      'budget-variance-tracker',
      'unit-economics-optimizer',
      'cloud-cost-estimator',
      'cloud-waste-hunter',
      'business-impact-analyzer',
      'excel-artisan',
      'executive-reporting-maestro',
    ],
    description: 'P&L & Unit Economics',
  },
  'Talent & Culture': {
    skills: [
      'talent-requirement-generator',
      'onboarding-wizard',
      'biometric-context-adapter',
      'skill-bundle-packager',
      'ai-ethics-auditor',
    ],
    description: 'Hiring & Culture',
  },
};

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
