import { logger } from '@agent/core/core';
import { safeExec } from '@agent/core/secure-io';
import { evaluateAutonomousOpsAction } from '@agent/core/autonomous-ops-gate';
import { withExecutionContextAsync } from '@agent/core/authority';
import { createCheckpoint } from './refactor/mission-maintenance.js';
import { listActiveMissions, loadState } from './refactor/mission-state.js';
import { defineScript, isDirectScript } from './lib/harness.js';
function getGitHash(cwd: string): string {
  return safeExec('git', ['rev-parse', 'HEAD'], { cwd }).trim();
}

async function syncProjectLedgerIfLinked(missionId: string): Promise<void> {
  // Checkpointing is the objective here; project-ledger sync is already
  // handled by mission-maintenance when the mission is linked. This helper
  // stays as a no-op so the script can reuse the same checkpoint path.
  void missionId;
}

function buildCheckpointNote(state: any | null): string {
  const status = state?.status || 'unknown';
  const taskCount = Array.isArray(state?.tasks) ? state.tasks.length : 0;
  return `auto-checkpoint status=${status} tasks=${taskCount}`;
}

async function runAutoCheckpoint(): Promise<number> {
  const gate = evaluateAutonomousOpsAction({ actionId: 'auto_checkpoint', executionMode: 'apply' });
  if (gate.decision === 'approve') {
    logger.warn(`[auto-checkpoint] gated for approval: ${gate.reason}`);
    return 0;
  }

  return withExecutionContextAsync('mission_controller', async () => {
    const activeMissions = listActiveMissions();
    if (activeMissions.length === 0) {
      logger.info('[auto-checkpoint] no active missions found');
      return 0;
    }

    let checkpointed = 0;
    let skipped = 0;
    for (const { missionId, missionPath } of activeMissions) {
      const state = loadState(missionId);
      if (!state?.git || !Array.isArray(state.git.checkpoints)) {
        skipped += 1;
        logger.warn(`[auto-checkpoint] skipping ${missionId}: mission git state is incomplete`);
        continue;
      }
      const note = buildCheckpointNote(state);
      logger.info(`[auto-checkpoint] checkpointing ${missionId} at ${missionPath}`);
      await createCheckpoint({
        taskId: 'auto-checkpoint',
        note,
        explicitMissionId: missionId,
        readFocusedMissionId: () => missionId,
        writeFocusedMissionId: () => undefined,
        getGitHash,
        syncProjectLedgerIfLinked,
      });
      checkpointed += 1;
    }

    logger.success(
      `[auto-checkpoint] checkpointed ${checkpointed} active mission(s)` +
        (skipped > 0 ? `; skipped ${skipped} incomplete mission(s)` : '')
    );
    return 0;
  });
}

if (
  isDirectScript(import.meta.url, 'auto_checkpoint.ts') ||
  isDirectScript(import.meta.url, 'auto_checkpoint.js')
) {
  void defineScript({
    name: 'auto:checkpoint',
    flags: [],
    run: () => runAutoCheckpoint(),
  })();
}

export { runAutoCheckpoint };
