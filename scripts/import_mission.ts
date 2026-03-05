import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, pathResolver } from '@agent/core';

/**
 * Mission Import Tool (MEP v0.1 Prototype)
 * Ingests a MEP file and deploys it as a new active mission.
 */

interface ImportOptions {
  mepPath: string;
  targetMissionId: string;
}

const REHYDRATE_MAP: Record<string, string> = {
  '{{HOME}}': process.env.HOME || '/Users',
  '{{PROJECT_ROOT}}': process.cwd(),
};

function rehydrateContent(content: string): string {
  let rehydrated = content;
  for (const [key, value] of Object.entries(REHYDRATE_MAP)) {
    rehydrated = rehydrated.split(key).join(value);
  }
  return rehydrated;
}

async function importMission({ mepPath, targetMissionId }: ImportOptions) {
  if (!fs.existsSync(mepPath)) {
    logger.error(`MEP file not found: ${mepPath}`);
    process.exit(1);
  }

  const mep = JSON.parse(fs.readFileSync(mepPath, 'utf8'));
  logger.info(`📥 Ingesting MEP: ${mep.missionId} (v${mep.version})`);

  const targetPath = pathResolver.active(`missions/${targetMissionId}`);
  if (fs.existsSync(targetPath)) {
    logger.error(`Mission directory already exists: ${targetMissionId}. Please use a unique ID.`);
    process.exit(1);
  }

  fs.mkdirSync(targetPath, { recursive: true });
  fs.mkdirSync(path.join(targetPath, 'evidence'), { recursive: true });
  fs.mkdirSync(path.join(targetPath, 'signals'), { recursive: true });

  // 1. Deploy Contract
  if (mep.blueprint.contract) {
    const contract = JSON.parse(rehydrateContent(JSON.stringify(mep.blueprint.contract)));
    // Update internal ID to match new deployment
    contract.id = targetMissionId;
    fs.writeFileSync(path.join(targetPath, 'contract.json'), JSON.stringify(contract, null, 2));
  }

  // 2. Deploy Procedure
  if (mep.blueprint.procedure) {
    const procedure = rehydrateContent(mep.blueprint.procedure);
    fs.writeFileSync(path.join(targetPath, 'TASK_BOARD.md'), procedure);
  }

  // 3. Restore Evidence (if present)
  if (mep.evidence && Array.isArray(mep.evidence)) {
    for (const ev of mep.evidence) {
      const evContent = typeof ev.content === 'object' ? JSON.stringify(ev.content, null, 2) : ev.content;
      fs.writeFileSync(path.join(targetPath, 'evidence', ev.name), rehydrateContent(evContent));
    }
  }

  logger.success(`✅ Mission imported and deployed to: ${targetPath}`);
  logger.info(`You can now resume this mission using its new ID: ${targetMissionId}`);
}

// CLI Entry
const args = process.argv.slice(2);
const mepFile = args[0];
const newId = args[1] || `MSN-IMPORTED-${Date.now()}`;

if (!mepFile) {
  console.log('Usage: node scripts/import_mission.ts <mep-file-path> [new-mission-id]');
  process.exit(1);
}

importMission({
  mepPath: mepFile,
  targetMissionId: newId
}).catch(err => {
  logger.error(`Import failed: ${err.message}`);
});
