/**
 * scripts/ace_engine.ts
 * Federated Expertise (Knowledge-Driven) Engine.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { logger } from '@agent/core/core';
import { safeReadFile, safeWriteFile } from '@agent/core';
import * as pathResolver from '@agent/core/path-resolver';

async function main() {
  const args = process.argv.slice(2);
  const missionId = args.find(a => a.startsWith('--mission='))?.split('=')[1] || process.env.MISSION_ID;
  const roleName = args.find(a => a.startsWith('--role='))?.split('=')[1];
  const action = args.find(a => a.startsWith('--action='))?.split('=')[1] || 'Review';
  const status = args.find(a => a.startsWith('--status='))?.split('=')[1] || 'APPROVED';

  if (!missionId || !roleName) {
    console.log(chalk.yellow('Usage: node ace_engine.js --mission=<id> --role="<name>" [--status=APPROVED|NO-GO]'));
    process.exit(1);
  }

  const missionDir = pathResolver.missionDir(missionId);
  const roleId = roleName.toLowerCase().replace(/ /g, '_');
  const personaDir = path.join(missionDir, `role_${roleId}`);
  const consensusPath = path.join(missionDir, 'consensus.json');

  if (!fs.existsSync(personaDir)) {
    fs.mkdirSync(path.join(personaDir, 'evidence'), { recursive: true });
    fs.mkdirSync(path.join(personaDir, 'scratch'), { recursive: true });
  }

  logger.info(chalk.bold.bgMagenta(` ACE Federation Active: ${roleName} `));

  const result = {
    role: roleName,
    action,
    status,
    timestamp: new Date().toISOString(),
    findings: `Analysis performed under ${roleName} guidelines.`
  };

  safeWriteFile(path.join(personaDir, 'evidence', `action_${Date.now()}.json`), JSON.stringify(result, null, 2));

  // Update Consensus
  let consensus: any = { approvals: {}, last_updated: null, conflict: false };
  if (fs.existsSync(consensusPath)) {
    try { consensus = JSON.parse(safeReadFile(consensusPath, { encoding: 'utf8' }) as string); } catch (_) {}
  }

  consensus.approvals[roleName] = status;
  consensus.last_updated = new Date().toISOString();
  const states = Object.values(consensus.approvals);
  consensus.conflict = states.includes('NO-GO') && states.includes('APPROVED');

  safeWriteFile(consensusPath, JSON.stringify(consensus, null, 2));
  logger.success(`Consensus updated: ${status}`);
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
