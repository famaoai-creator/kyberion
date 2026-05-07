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
  TraceContext,
  persistTrace,
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

  // Phase B-1.5: every checkpoint emits a Trace, so the structured observability
  // pipeline (Chronos viewer, distill, error-classifier) can correlate
  // checkpoint events with surrounding actuator activity.
  const traceCtx = new TraceContext(`mission_controller:checkpoint:${activeMissionId}`, {
    actuator: 'mission_controller',
    missionId: activeMissionId,
  });
  traceCtx.addEvent('checkpoint.requested', { task_id: taskId, note: note.slice(0, 200) });

  logger.info(`📸 Checkpoint for ${activeMissionId}: ${taskId}...`);
  let traceStatus: 'ok' | 'error' = 'ok';
  try {
    await withLock(`mission-${activeMissionId}`, async () => {
      const stageSpan = traceCtx.startSpan('git.stage');
      try {
        safeExec('git', ['add', '.'], { cwd: missionPath });
        traceCtx.endSpan('ok');
      } catch (err: any) {
        traceCtx.endSpan('error', err?.message);
        throw err;
      }

      let commitCreated = true;
      const commitSpan = traceCtx.startSpan('git.commit');
      try {
        safeExec('git', ['commit', '-m', `checkpoint(${activeMissionId}): ${taskId} - ${note}`], {
          cwd: missionPath,
        });
        traceCtx.endSpan('ok');
      } catch (_) {
        // git commit fails when there are no staged changes — that is the
        // "state-only checkpoint" path, NOT an error condition.
        logger.info('No new changes in mission repo — recording state-only checkpoint.');
        commitCreated = false;
        traceCtx.addEvent('git.commit.skipped_no_changes');
        traceCtx.endSpan('ok');
      }

      const hash = getGitHash(missionPath);
      const saveSpan = traceCtx.startSpan('state.save');
      const currentState = loadState(activeMissionId)!;
      currentState.git.latest_commit = hash;
      currentState.git.checkpoints.push({
        task_id: taskId,
        commit_hash: hash,
        ts: new Date().toISOString(),
      });
      await saveState(activeMissionId, currentState, { alreadyLocked: true });
      traceCtx.addEvent('checkpoint.recorded', {
        commit_hash: hash,
        commit_created: commitCreated,
        checkpoint_count: currentState.git.checkpoints.length,
      });
      traceCtx.endSpan('ok');

      logger.success(
        `✅ Recorded checkpoint ${hash} in mission repo${commitCreated ? '' : ' (state-only)'}.`
      );
    });

    const ledgerSpan = traceCtx.startSpan('project_ledger.sync');
    try {
      await syncProjectLedgerIfLinked(activeMissionId);
      traceCtx.endSpan('ok');
    } catch (err: any) {
      // Ledger sync failure must not fail the checkpoint, but we record it.
      traceCtx.endSpan('error', err?.message);
      throw err;
    }

    const intentSpan = traceCtx.startSpan('intent_delta.emit');
    try {
      await emitMissionLifecycleIntentSnapshot({
        missionId: activeMissionId,
        stage: 'execution',
        text: note || taskId,
        source: 'mission_state',
      });
      traceCtx.endSpan('ok');
    } catch (err: any) {
      traceCtx.endSpan('error', err?.message);
      throw err;
    }
  } catch (err: any) {
    traceStatus = 'error';
    logger.error(`Checkpoint failed: ${err.message}`);
  } finally {
    // Persistence must never break the checkpoint flow itself.
    try {
      const trace = traceCtx.finalize();
      // If finalize ran via the inner try/finally already setting status, force
      // the rootSpan status to reflect outer outcome (children may have all been ok
      // but a step after the lock could still have thrown).
      if (traceStatus === 'error' && trace.rootSpan.status !== 'error') {
        trace.rootSpan.status = 'error';
      }
      persistTrace(trace);
    } catch (persistErr: any) {
      logger.warn(
        `[mission-maintenance] Failed to persist checkpoint trace: ${persistErr?.message || persistErr}`,
      );
    }
  }
}

/**
 * Window in milliseconds during which repeated RESUME calls are coalesced
 * into a single history entry. Prevents history bloat across orchestrator
 * restarts / supervisor flapping for long-running (24h+) missions.
 */
export const RESUME_IDEMPOTENCY_WINDOW_MS = 60_000;

/**
 * Returns true if a fresh RESUME entry should be skipped because the most
 * recent history entry is already a RESUME within the idempotency window.
 * Pure function — exported for unit testing.
 */
export function shouldSkipResumeEntry(
  history: Array<{ ts: string; event: string }>,
  now: Date = new Date(),
  windowMs: number = RESUME_IDEMPOTENCY_WINDOW_MS,
): boolean {
  const last = history[history.length - 1];
  if (!last || last.event !== 'RESUME') return false;
  const lastMs = new Date(last.ts).getTime();
  if (Number.isNaN(lastMs)) return false;
  return now.getTime() - lastMs < windowMs;
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

  // Pre-flight read (no mutation) — used only for branch switch decision and flight recorder display.
  const preState = loadState(targetId);
  if (!preState) throw new Error(`Mission ${targetId} not found.`);

  logger.info(`🔄 Resuming Mission: ${targetId}...`);
  const missionPath = findMissionPath(targetId);
  if (!missionPath) throw new Error(`Mission ${targetId} path not found.`);

  const currentBranch = args.getCurrentBranch(missionPath);
  if (currentBranch !== preState.git.branch) {
    safeExec('git', ['checkout', preState.git.branch], { cwd: missionPath });
  }

  const flightRecorderPath = path.join(missionPath, 'LATEST_TASK.json');
  if (safeExistsSync(flightRecorderPath)) {
    const task = readJsonFile<{ description?: string }>(flightRecorderPath);
    logger.warn(`📍 FLIGHT RECORDER DETECTED: Last intended task was: ${task.description}`);
    logger.info('Please verify the physical state and continue from this point.');
  }

  // Atomic RESUME: re-load fresh state inside the lock to avoid clobbering
  // a concurrent checkpoint, and dedupe RESUMEs within the idempotency window.
  await withLock(`mission-${targetId}`, async () => {
    const fresh = loadState(targetId!)!;
    const now = new Date();
    if (shouldSkipResumeEntry(fresh.history, now)) {
      const lastTs = new Date(fresh.history[fresh.history.length - 1].ts).getTime();
      logger.info(
        `↳ Skipping RESUME entry (last RESUME was ${Math.round(
          (now.getTime() - lastTs) / 1000,
        )}s ago, within idempotency window).`,
      );
    } else {
      fresh.history.push({
        ts: now.toISOString(),
        event: 'RESUME',
        note: 'Session re-established.',
      });
      await saveState(targetId!, fresh, { alreadyLocked: true });
    }
  });

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
