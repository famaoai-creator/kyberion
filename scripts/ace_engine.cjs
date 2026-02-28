#!/usr/bin/env node
/**
 * ACE Engine v4.0 - Multi-Role Federation (The AMA-Flow)
 * 
 * Implements GEMINI.md Section X: Multi-Role Collaboration.
 * Usage: node scripts/ace_engine.cjs --mission=<id> --role="<persona_name>" --action="<action_description>"
 */
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { logger, fileUtils } = require('../libs/core/core.cjs');

const rootDir = path.resolve(__dirname, '..');
const rolesPath = path.join(rootDir, 'knowledge/personalities/roles.json');

async function runACE() {
  const args = process.argv.slice(2);
  const missionId = args.find(a => a.startsWith('--mission='))?.split('=')[1] || process.env.MISSION_ID;
  const roleName = args.find(a => a.startsWith('--role='))?.split('=')[1];
  const action = args.find(a => a.startsWith('--action='))?.split('=')[1];

  if (!missionId || !roleName) {
    console.log(chalk.yellow('Usage: node scripts/ace_engine.cjs --mission=<id> --role="<persona_name>" [--action="<description>"]'));
    process.exit(1);
  }

  const missionDir = path.resolve(rootDir, 'active/missions', missionId);
  const roleDirName = `role_${roleName.toLowerCase().replace(/ /g, '_')}`;
  const personaDir = path.join(missionDir, roleDirName);
  const consensusPath = path.join(missionDir, 'consensus.json');
  const taskBoardPath = path.join(missionDir, 'TASK_BOARD.md');

  // 1. Physical Isolation Setup (Task 2.2)
  if (!fs.existsSync(personaDir)) {
    fs.mkdirSync(personaDir, { recursive: true });
    fs.mkdirSync(path.join(personaDir, 'evidence'), { recursive: true });
    fs.mkdirSync(path.join(personaDir, 'scratch'), { recursive: true });
    logger.info(`Created Persona Sandbox: ${roleDirName}`);
  }

  console.log(chalk.bold.bgMagenta(`\n ACE Federation Active: ${roleName} `));
  console.log(chalk.cyan(`Mission: ${missionId}`));
  console.log(chalk.dim(`Sandbox: ${personaDir}`));

  // 2. Load Global Strategy (Task 2.3)
  if (fs.existsSync(taskBoardPath)) {
    console.log(chalk.dim(`Shared Strategy Loaded: TASK_BOARD.md`));
  } else {
    logger.warn(`Global TASK_BOARD.md not found in mission directory.`);
  }

  // 3. Action Implementation (Simulated for now, would be a real Skill call)
  const result = {
    role: roleName,
    action: action || 'Review/Analyze',
    timestamp: new Date().toISOString(),
    status: 'COMPLETED',
    findings: `Action executed in ${roleDirName}. All intermediate data isolated.`
  };

  // 4. Save Persona-Specific Evidence (Task 2.4)
  const evidenceFile = path.join(personaDir, 'evidence', `action_${Date.now()}.json`);
  fs.writeFileSync(evidenceFile, JSON.stringify(result, null, 2));
  logger.success(`Evidence recorded in persona sandbox: ${path.basename(evidenceFile)}`);

  // 5. Consensus Management (Task 3.1)
  updateConsensus(consensusPath, roleName, 'APPROVED');

  return result;
}

function updateConsensus(path, role, status) {
  let consensus = { approvals: {}, last_updated: null };
  if (fs.existsSync(path)) {
    try {
      consensus = JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch (e) { /* ignore corrupt */ }
  }

  consensus.approvals[role] = status;
  consensus.last_updated = new Date().toISOString();

  fs.writeFileSync(path, JSON.stringify(consensus, null, 2));
  logger.info(`Consensus updated for ${role}: ${status}`);
}

runACE().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
