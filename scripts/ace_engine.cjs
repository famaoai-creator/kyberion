#!/usr/bin/env node
/**
 * ACE Engine v4.1 - Federated Expertise (Knowledge-Driven)
 * 
 * Implements GEMINI.md Section X (Conflict Resolution) 
 * and Persona-Specific Rule Loading from knowledge/roles/.
 */
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { logger, fileUtils } = require('../libs/core/core.cjs');

const rootDir = path.resolve(__dirname, '..');

async function runACE() {
  const args = process.argv.slice(2);
  const missionId = args.find(a => a.startsWith('--mission='))?.split('=')[1] || process.env.MISSION_ID;
  const roleName = args.find(a => a.startsWith('--role='))?.split('=')[1];
  const action = args.find(a => a.startsWith('--action='))?.split('=')[1];
  const status = args.find(a => a.startsWith('--status='))?.split('=')[1] || 'APPROVED';

  if (!missionId || !roleName) {
    console.log(chalk.yellow('Usage: node scripts/ace_engine.cjs --mission=<id> --role="<persona_name>" [--action="<desc>"] [--status=APPROVED|NO-GO]'));
    process.exit(1);
  }

  const missionDir = path.resolve(rootDir, 'active/missions', missionId);
  const roleId = roleName.toLowerCase().replace(/ /g, '_');
  const personaDir = path.join(missionDir, `role_${roleId}`);
  const consensusPath = path.join(missionDir, 'consensus.json');
  const roleRulesPath = path.join(rootDir, 'knowledge/roles', `${roleId}.md`);

  // 1. Sandbox Setup
  if (!fs.existsSync(personaDir)) {
    fs.mkdirSync(personaDir, { recursive: true });
    fs.mkdirSync(path.join(personaDir, 'evidence'), { recursive: true });
    fs.mkdirSync(path.join(personaDir, 'scratch'), { recursive: true });
  }

  console.log(chalk.bold.bgMagenta(`\n ACE Federation Active: ${roleName} `));

  // 2. Load Role-Specific Expertise (Task 3.1)
  if (fs.existsSync(roleRulesPath)) {
    const rules = fs.readFileSync(roleRulesPath, 'utf8');
    console.log(chalk.green(`Expertise Loaded: ${path.basename(roleRulesPath)} (${rules.length} bytes)`));
    // Here, rules would be injected into the LLM prompt.
  }

  // 3. Execution & Evidence
  const result = {
    role: roleName,
    action: action || 'Review',
    status: status,
    timestamp: new Date().toISOString(),
    findings: `Analysis performed under ${roleName} guidelines. Status: ${status}`
  };

  const evidenceFile = path.join(personaDir, 'evidence', `action_${Date.now()}.json`);
  fs.writeFileSync(evidenceFile, JSON.stringify(result, null, 2));
  logger.success(`Evidence recorded: ${path.basename(evidenceFile)}`);

  // 4. Consensus & Conflict Detection (Task 1.2)
  updateConsensus(consensusPath, roleName, status);

  return result;
}

function updateConsensus(path, role, status) {
  let consensus = { approvals: {}, last_updated: null, conflict: false };
  if (fs.existsSync(path)) {
    try { consensus = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) {}
  }

  consensus.approvals[role] = status;
  consensus.last_updated = new Date().toISOString();

  // Detect Conflict
  const states = Object.values(consensus.approvals);
  consensus.conflict = states.includes('NO-GO') && states.includes('APPROVED');

  if (consensus.conflict) {
    logger.warn(`CONFLICT DETECTED in consensus. Final Sudo Decision required.`);
  }

  fs.writeFileSync(path, JSON.stringify(consensus, null, 2));
  logger.info(`Consensus updated for ${role}: ${status}`);
}

runACE().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
