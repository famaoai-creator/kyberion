import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, safeWriteFile, pathResolver } from '@agent/core';

/**
 * scripts/create_mission.ts
 * Creates a new mission state anchored to a Tenant and Vision.
 */

async function main() {
  const args = process.argv.slice(2);
  const missionId = args[0]?.toUpperCase();
  const tenantId = args[1] || 'default';
  const missionType = args[2] || 'development';
  const visionRef = args[3];

  if (!missionId) {
    console.log('Usage: npx tsx scripts/create_mission.ts <mission_id> <tenant_id> [type] [vision_ref]');
    console.log('Types: development (default), evaluation');
    process.exit(1);
  }

  const missionDir = pathResolver.missionDir(missionId);
  const statePath = path.join(missionDir, 'mission-state.json');

  if (fs.existsSync(statePath)) {
    logger.error(`Mission ${missionId} already exists.`);
    process.exit(1);
  }

  // Resolve Vision Reference
  let resolvedVision = visionRef;
  if (!resolvedVision) {
    const tenantVisionPath = pathResolver.vision(`${tenantId}.md`);
    if (fs.existsSync(tenantVisionPath)) {
      resolvedVision = `/vision/${tenantId}.md`;
    } else {
      resolvedVision = '/vision/_default.md';
    }
  }

  const state = {
    mission_id: missionId,
    type: missionType,
    version: '1.1',
    status: 'planned',
    priority: 5,
    owner: process.env.USER || 'famao',
    tenant_id: tenantId,
    vision_ref: resolvedVision,
    assigned_persona: 'Ecosystem Architect',
    git: {
      branch: `mission/${missionId.toLowerCase()}`,
      checkpoints: []
    },
    milestones: [
      { id: 'M1', title: 'Initialization', status: 'completed', completed_at: new Date().toISOString() },
      { id: 'M2', title: 'Implementation', status: 'pending' },
      { id: 'M3', title: 'Validation', status: 'pending' }
    ],
    context: {
      associated_projects: []
    },
    history: [
      { ts: new Date().toISOString(), event: 'CREATED', note: `Mission created for tenant: ${tenantId}` }
    ]
  };

  safeWriteFile(statePath, JSON.stringify(state, null, 2));
  
  // Create an initial TASK_BOARD.md
  const taskBoardPath = path.join(missionDir, 'TASK_BOARD.md');
  const taskBoardContent = `# TASK_BOARD: ${missionId}\n\n## Vision Context\n- Tenant: ${tenantId}\n- Vision: ${resolvedVision}\n\n## Status: Planned\n\n- [ ] Step 1: Research and Strategy\n- [ ] Step 2: Implementation\n- [ ] Step 3: Validation\n`;
  safeWriteFile(taskBoardPath, taskBoardContent);

  logger.success(`🚀 Mission ${missionId} created for tenant ${tenantId}.`);
  logger.info(`Vision: ${resolvedVision}`);
  logger.info(`Directory: ${missionDir}`);
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
