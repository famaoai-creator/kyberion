import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { logger, safeWriteFile, pathResolver } from '@agent/core';

/**
 * scripts/create_mission.ts
 * Creates a new mission state anchored to a Tenant and Vision.
 */

function getGitContext() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    return { branch, hash };
  } catch (_) {
    return { branch: 'unknown', hash: 'none' };
  }
}

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

  const gitContext = getGitContext();
  if (gitContext.branch === 'main' || gitContext.branch === 'master') {
    logger.warn(`⚠️  WARNING: Currently on ${gitContext.branch} branch. GEMINI.md requires a feature branch (mission/${missionId.toLowerCase()}) for new missions.`);
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
    const personalVisionPath = path.join(pathResolver.rootDir, 'knowledge/personal/my-vision.md');
    const tenantVisionPath = pathResolver.vision(`${tenantId}.md`);
    
    if (fs.existsSync(personalVisionPath)) {
      resolvedVision = '/knowledge/personal/my-vision.md';
    } else if (fs.existsSync(tenantVisionPath)) {
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
      branch: gitContext.branch,
      initial_hash: gitContext.hash,
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
  const taskBoardContent = `# TASK_BOARD: ${missionId}

## 🛡️ Governance Pre-flight
- [ ] Branch: \`${gitContext.branch}\` (Should not be main/master)
- [ ] Initial Hash: \`${gitContext.hash}\`
- [ ] Checkpoint: Initial state recorded

## Vision Context
- Tenant: ${tenantId}
- Vision: ${resolvedVision}

## Status: Planned

### 🛠️ Execution Phase
- [ ] Step 1: Research and Strategy
- [ ] Step 2: Implementation
- [ ] Step 3: Validation

### 🧠 Distillation & Reflex Phase
- [ ] Step 4: Knowledge Distillation - Extract key insights to \`knowledge/\`.
- [ ] Step 5: Mission Logic - Update/Register \`pipelines/*.yml\` if repeatable.
- [ ] Step 6: Final Cleanup - Archive mission and delete ephemeral scratch files.
`;
  safeWriteFile(taskBoardPath, taskBoardContent);

  logger.success(`🚀 Mission ${missionId} created for tenant ${tenantId}.`);
  logger.info(`Vision: ${resolvedVision}`);
  logger.info(`Directory: ${missionDir}`);
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
