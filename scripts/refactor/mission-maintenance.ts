/**
 * scripts/refactor/mission-maintenance.ts
 * Maintenance and recovery operations for missions.
 */

import * as path from 'node:path';
import {
  findMissionPath,
  logger,
  pathResolver,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeStat,
  safeWriteFile,
  withLock,
  appendMissionExecutionLedgerEntry,
  type MissionActorType,
} from '@agent/core';
import { listActiveMissions, listMissionsInSearchDirs, loadState, saveState } from './mission-state.js';
import { emitMissionLifecycleIntentSnapshot } from './mission-intent-delta.js';
import { readJsonFile } from './cli-input.js';

export async function createCheckpoint(args: {
  taskId: string;
  note: string;
  explicitMissionId?: string;
  readFocusedMissionId: () => string | null;
  writeFocusedMissionId: (missionId: string) => void;
  getGitHash: (cwd: string) => string;
  syncProjectLedgerIfLinked: (missionId: string) => Promise<void>;
}): Promise<void> {
  const { explicitMissionId, readFocusedMissionId } = args;
  if (explicitMissionId) {
    const targetMissionId = explicitMissionId.toUpperCase();
    const explicitState = loadState(targetMissionId);
    const explicitPath = findMissionPath(targetMissionId);
    if (explicitState?.status === 'active' && explicitPath) {
      return recordCheckpointForMission(targetMissionId, explicitPath, args);
    }
    logger.error(
      `Mission ${targetMissionId} is not active or could not be found. Checkpoint aborted.`
    );
    return;
  }

  const focusedMissionId = readFocusedMissionId();
  if (focusedMissionId) {
    const focusedState = loadState(focusedMissionId);
    const focusedPath = findMissionPath(focusedMissionId);
    if (focusedState?.status === 'active' && focusedPath) {
      return recordCheckpointForMission(focusedMissionId, focusedPath, args);
    }
  }

  const activeMissions = listActiveMissions();

  if (activeMissions.length === 0) {
    logger.error('No active mission found. Checkpoint aborted.');
    logger.info('  To activate a mission:  mission_controller start <MISSION_ID>');
    logger.info('  To see all missions:    mission_controller list');
    return;
  }

  if (activeMissions.length > 1) {
    logger.error(
      'Multiple active missions found. Checkpoint aborted to avoid writing to the wrong mission.'
    );
    logger.info(
      '  Specify the target mission explicitly: mission_controller checkpoint <MISSION_ID> <TASK_ID> "<NOTE>"'
    );
    logger.info(
      '  Or use: mission_controller checkpoint --mission-id <MISSION_ID> <TASK_ID> "<NOTE>"'
    );
    return;
  }

  const [activeMission] = activeMissions;
  return recordCheckpointForMission(activeMission.missionId, activeMission.missionPath, args);
}

async function recordCheckpointForMission(
  activeMissionId: string,
  missionPath: string,
  args: {
    taskId: string;
    note: string;
    writeFocusedMissionId: (missionId: string) => void;
    getGitHash: (cwd: string) => string;
    syncProjectLedgerIfLinked: (missionId: string) => Promise<void>;
  }
): Promise<void> {
  const { taskId, note, writeFocusedMissionId, getGitHash, syncProjectLedgerIfLinked } = args;
  writeFocusedMissionId(activeMissionId);

  const state = loadState(activeMissionId);
  if (!state) return;

  logger.info(`📸 Checkpoint for ${activeMissionId}: ${taskId}...`);
  try {
    await withLock(`mission-${activeMissionId}`, async () => {
      safeExec('git', ['add', '.'], { cwd: missionPath });

      let commitCreated = true;
      try {
        safeExec('git', ['commit', '-m', `checkpoint(${activeMissionId}): ${taskId} - ${note}`], {
          cwd: missionPath,
        });
      } catch (_) {
        logger.info('No new changes in mission repo — recording state-only checkpoint.');
        commitCreated = false;
      }

      const hash = getGitHash(missionPath);
      const currentState = loadState(activeMissionId)!;
      currentState.git.latest_commit = hash;
      currentState.git.checkpoints.push({
        task_id: taskId,
        commit_hash: hash,
        ts: new Date().toISOString(),
      });
      await saveState(activeMissionId, currentState, { alreadyLocked: true });

      logger.success(
        `✅ Recorded checkpoint ${hash} in mission repo${commitCreated ? '' : ' (state-only)'}.`
      );
    });
    await syncProjectLedgerIfLinked(activeMissionId);
    await emitMissionLifecycleIntentSnapshot({
      missionId: activeMissionId,
      stage: 'execution',
      text: note || taskId,
      source: 'mission_state',
    });
  } catch (err: any) {
    logger.error(`Checkpoint failed: ${err.message}`);
  }
}

export async function resumeMission(
  id: string | undefined,
  args: {
    readFocusedMissionId: () => string | null;
    writeFocusedMissionId: (missionId: string) => void;
    getCurrentBranch: (cwd: string) => string;
    syncProjectLedgerIfLinked: (missionId: string) => Promise<void>;
  }
): Promise<void> {
  let targetId = id?.toUpperCase();

  if (!targetId) {
    for (const { missionId: active } of listActiveMissions()) {
      targetId = active;
      break;
    }

    if (!targetId) {
      logger.warn('No active mission found to resume.');
      return;
    }
  }

  const state = loadState(targetId);
  if (!state) throw new Error(`Mission ${targetId} not found.`);

  logger.info(`🔄 Resuming Mission: ${targetId}...`);
  const missionPath = findMissionPath(targetId);
  if (!missionPath) throw new Error(`Mission ${targetId} path not found.`);

  const currentBranch = args.getCurrentBranch(missionPath);
  if (currentBranch !== state.git.branch) {
    safeExec('git', ['checkout', state.git.branch], { cwd: missionPath });
  }

  const flightRecorderPath = path.join(missionPath, 'LATEST_TASK.json');
  if (safeExistsSync(flightRecorderPath)) {
    const task = readJsonFile<{ description?: string }>(flightRecorderPath);
    logger.warn(`📍 FLIGHT RECORDER DETECTED: Last intended task was: ${task.description}`);
    logger.info('Please verify the physical state and continue from this point.');
  }

  state.history.push({
    ts: new Date().toISOString(),
    event: 'RESUME',
    note: 'Session re-established.',
  });
  await saveState(targetId, state);
  await args.syncProjectLedgerIfLinked(targetId);
  args.writeFocusedMissionId(targetId);
  logger.success(`✅ Mission ${targetId} is back in focus.`);
}

export async function recordTask(
  missionId: string,
  description: string,
  details: any = {}
): Promise<void> {
  const upperId = missionId.toUpperCase();
  const missionDir = findMissionPath(upperId);
  if (!missionDir) throw new Error(`Mission ${upperId} not found.`);

  const flightRecorderPath = path.join(missionDir, 'LATEST_TASK.json');
  safeWriteFile(
    flightRecorderPath,
    JSON.stringify(
      {
        ts: new Date().toISOString(),
        description,
        details,
      },
      null,
      2
    )
  );
  logger.info(`📝 [FlightRecorder] Intention recorded: ${description}`);
}

export async function recordEvidence(args: {
  missionId: string;
  taskId: string;
  note: string;
  evidence?: string[];
  teamRole?: string;
  actorId?: string;
  actorType?: MissionActorType;
  getGitHash: (cwd: string) => string;
  syncProjectLedgerIfLinked: (missionId: string) => Promise<void>;
}): Promise<void> {
  const upperId = args.missionId.toUpperCase();
  const missionPath = findMissionPath(upperId);
  if (!missionPath) throw new Error(`Mission ${upperId} not found.`);

  const state = loadState(upperId);
  if (!state) throw new Error(`Mission ${upperId} state not found.`);
  if (state.status === 'archived') {
    throw new Error(`Mission ${upperId} is archived. Evidence cannot be recorded.`);
  }

  logger.info(`🧾 Evidence for ${upperId}: ${args.taskId}...`);

  await withLock(`mission-${upperId}`, async () => {
    appendMissionExecutionLedgerEntry({
      mission_id: upperId,
      mission_path_hint: missionPath,
      event_type: 'evidence_recorded',
      task_id: args.taskId,
      team_role: args.teamRole,
      actor_id: args.actorId,
      actor_type: args.actorType || (args.actorId ? 'agent' : undefined),
      decision: args.note,
      evidence: args.evidence || [],
      payload: {
        mission_status: state.status,
      },
    });

    safeExec('git', ['add', '.'], { cwd: missionPath });
    try {
      safeExec('git', ['commit', '-m', `evidence(${upperId}): ${args.taskId} - ${args.note}`], {
        cwd: missionPath,
      });
    } catch (_) {
      logger.info('No new changes in mission repo after evidence record.');
    }

    const hash = args.getGitHash(missionPath);
    const currentState = loadState(upperId)!;
    currentState.git.latest_commit = hash;
    currentState.history.push({
      ts: new Date().toISOString(),
      event: 'EVIDENCE',
      note: `${args.taskId}: ${args.note}`,
    });
    await saveState(upperId, currentState, { alreadyLocked: true });
  });

  await args.syncProjectLedgerIfLinked(upperId);
  logger.success(`✅ Recorded evidence for ${upperId}.`);
}

export async function purgeMissions(rootDir: string, dryRun = false): Promise<void> {
  const adfPath = pathResolver.knowledge('governance/mission-lifecycle.json');
  if (!safeExistsSync(adfPath)) {
    logger.error('Mission lifecycle ADF not found.');
    return;
  }

  const adf = readJsonFile<{
    policies: Array<{
      name: string;
      condition: { has_file?: string; max_age_days?: number };
      target_dir: string;
      naming_pattern: string;
    }>;
  }>(adfPath);
  const candidates: Array<{
    mission: string;
    missionDir: string;
    targetPath: string;
    policyName: string;
  }> = [];

  for (const { missionId: mission, missionPath: missionDir } of listMissionsInSearchDirs()) {
    for (const policy of adf.policies) {
      let match = false;
      const { condition } = policy;

      if (condition.has_file) {
        match = safeExistsSync(path.join(missionDir, condition.has_file));
      } else if (condition.max_age_days) {
        const stat = safeStat(missionDir);
        const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
        match = ageDays > condition.max_age_days;
      }

      if (!match) continue;

      let targetPath = policy.target_dir;
      const now = new Date();
      targetPath = targetPath.replace(
        '{YYYY-MM}',
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      );
      targetPath = pathResolver.rootResolve(
        path.join(targetPath, policy.naming_pattern.replace('{mission_id}', mission))
      );
      candidates.push({ mission, missionDir, targetPath, policyName: policy.name });
      break;
    }
  }

  if (candidates.length === 0) {
    logger.info('No missions match purge policies. Nothing to do.');
    return;
  }

  console.log('');
  console.log(`  Missions matching purge policies: ${candidates.length}`);
  console.log('');
  for (const candidate of candidates) {
    console.log(
      `    ${candidate.mission.padEnd(30)} → ${path.relative(rootDir, candidate.targetPath)}  (${candidate.policyName})`
    );
  }
  console.log('');

  if (dryRun) {
    logger.info('Dry run complete. No missions were moved. Run "purge --execute" to apply.');
    return;
  }

  for (const candidate of candidates) {
    logger.info(
      `Archiving mission ${candidate.mission} to ${candidate.targetPath} (Policy: ${candidate.policyName})`
    );
    if (!safeExistsSync(path.dirname(candidate.targetPath))) {
      safeMkdir(path.dirname(candidate.targetPath), { recursive: true });
    }
    safeExec('cp', ['-r', candidate.missionDir, candidate.targetPath]);
    safeRmSync(candidate.missionDir, { recursive: true, force: true });
  }

  logger.success(`✅ ${candidates.length} mission(s) purged.`);
}
