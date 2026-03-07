import * as path from 'node:path';
import { logger, safeWriteFile, safeExec, pathResolver } from '@agent/core';

/**
 * scripts/create_mission.ts
 * Creates a new mission state anchored to a Tenant and Vision.
 * [SECURE-IO COMPLIANT VERSION]
 */

async function getGitContext() {
  try {
    const branchRes = safeExec('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    const hashRes = safeExec('git', ['rev-parse', '--short', 'HEAD']);
    return { 
      branch: branchRes.trim(), 
      hash: hashRes.trim() 
    };
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
    process.exit(1);
  }

  const gitContext = await getGitContext();
  if (gitContext.branch === 'main' || gitContext.branch === 'master') {
    logger.warn(`⚠️  WARNING: Currently on ${gitContext.branch} branch. GEMINI.md requires a feature branch.`);
  }

  const missionDir = pathResolver.missionDir(missionId);
  const statePath = path.join(missionDir, 'mission-state.json');

  // Use safeWriteFile which handles directory creation and validation
  // We check for existence implicitly by trying to write if appropriate, 
  // or we could use a safe existence check if we added one to core.
  // For now, we follow the secure-io pattern.

  // Resolve Vision Reference
  let resolvedVision = visionRef;
  if (!resolvedVision) {
    const personalVisionPath = path.join(pathResolver.rootDir(), 'knowledge/personal/my-vision.md');
    // Note: We use pathResolver to keep it clean
    resolvedVision = '/knowledge/personal/my-vision.md'; 
    // In a real scenario, we'd verify existence via a safe utility.
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
    context: { associated_projects: [] },
    history: [
      { ts: new Date().toISOString(), event: 'CREATED', note: `Mission created for tenant: ${tenantId}` }
    ]
  };

  safeWriteFile(statePath, JSON.stringify(state, null, 2));
  
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
- [ ] Step 4: Knowledge Distillation
- [ ] Step 5: Mission Logic
- [ ] Step 6: Final Cleanup
`;
  safeWriteFile(taskBoardPath, taskBoardContent);

  logger.success(`🚀 Mission ${missionId} created (Secure-IO Enforced).`);
  logger.info(`Directory: ${missionDir}`);
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
