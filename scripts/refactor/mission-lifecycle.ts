/**
 * scripts/refactor/mission-lifecycle.ts
 * Delegation, verification, import, and finalization helpers for missions.
 */

import * as path from 'node:path';
import {
  findMissionPath,
  grantAccess,
  grantAccessGuarded,
  ledger,
  logger,
  pathResolver,
  queueMissionMemoryPromotionCandidate,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeRmSync,
} from '@agent/core';
import { loadState, saveState } from './mission-state.js';
import { readTrustLedger, recordAgentRuntimeEvent, updateTrustScore, validateMissionQuality } from './mission-governance.js';
import { emitMissionLifecycleIntentSnapshot, evaluateMissionIntentDrift } from './mission-intent-delta.js';

function collectMissionEvidenceRefs(missionDir: string): string[] {
  const evidenceDir = path.join(missionDir, 'evidence');
  if (!safeExistsSync(evidenceDir)) return [];
  return safeReaddir(evidenceDir)
    .filter((entry) => entry !== '.gitkeep')
    .map((entry) => path.join(missionDir, 'evidence', entry));
}

export async function delegateMission(
  id: string,
  agentId: string,
  a2aMessageId: string,
  syncProjectLedgerIfLinked: (missionId: string) => Promise<void>,
): Promise<void> {
  if (!id || !agentId || !a2aMessageId) {
    logger.error('Usage: mission_controller delegate <MISSION_ID> <AGENT_ID> <A2A_MESSAGE_ID>');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }

  const trustLedger = readTrustLedger();
  const agent = trustLedger[agentId];
  if (agent && agent.current_score < 300 && (state.tier === 'personal' || state.tier === 'confidential')) {
    throw new Error(`CRITICAL: Agent ${agentId} has insufficient trust score (${agent.current_score}) for ${state.tier} tier mission.`);
  }

  logger.info(`📤 Delegating Mission ${upperId} to agent ${agentId}...`);

  if (state.status !== 'active') state.status = 'active';
  state.execution_mode = 'delegated';
  state.delegation = {
    agent_id: agentId,
    a2a_message_id: a2aMessageId,
    last_sync_ts: new Date().toISOString(),
    verification_status: 'pending',
  };
  state.history.push({
    ts: new Date().toISOString(),
    event: 'DELEGATE',
    note: `Mission delegated to ${agentId} (A2A: ${a2aMessageId})`,
  });

  await saveState(upperId, state);
  await syncProjectLedgerIfLinked(upperId);
  logger.success(`✅ Mission ${upperId} marked as DELEGATED.`);
}

export async function importMission(
  id: string,
  remoteUrl: string,
  transitionStatus: (current: string, next: string) => any,
  syncProjectLedgerIfLinked: (missionId: string) => Promise<void>,
): Promise<void> {
  if (!id || !remoteUrl) {
    logger.error('Usage: mission_controller import <MISSION_ID> <REMOTE_URL>');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }

  const missionDir = findMissionPath(upperId);
  if (!missionDir) {
    logger.error(`Mission directory for ${upperId} not found.`);
    return;
  }

  logger.info(`📥 Importing results for Mission ${upperId} from ${remoteUrl}...`);
  try {
    try {
      safeExec('git', ['remote', 'add', 'origin_remote', remoteUrl], { cwd: missionDir });
    } catch (_) {
      safeExec('git', ['remote', 'set-url', 'origin_remote', remoteUrl], { cwd: missionDir });
    }
    safeExec('git', ['fetch', 'origin_remote'], { cwd: missionDir });
    safeExec('git', ['merge', 'origin_remote/main', '--no-edit'], { cwd: missionDir });

    state.status = transitionStatus(state.status, 'validating');
    if (state.delegation) {
      state.delegation.last_sync_ts = new Date().toISOString();
      state.delegation.remote_repo_url = remoteUrl;
    }
    state.history.push({
      ts: new Date().toISOString(),
      event: 'IMPORT',
      note: `Imported results from ${remoteUrl}. Transitioned to VALIDATING.`,
    });

    await saveState(upperId, state);
    await syncProjectLedgerIfLinked(upperId);
    logger.success(`✅ Results imported for ${upperId}. Manual/Auto verification required.`);
  } catch (err: any) {
    logger.error(`Import failed: ${err.message}`);
  }
}

export async function verifyMission(
  id: string,
  result: 'verified' | 'rejected',
  note: string,
  transitionStatus: (current: string, next: string) => any,
  syncProjectLedgerIfLinked: (missionId: string) => Promise<void>,
): Promise<void> {
  if (!id || !result || !['verified', 'rejected'].includes(result)) {
    logger.error('Usage: mission_controller verify <MISSION_ID> <verified|rejected> <note>');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }

  if (state.status !== 'active' && state.status !== 'validating') {
    logger.error(`❌ Cannot verify mission ${upperId} (status: ${state.status}). Only active or validating missions can be verified.`);
    return;
  }

  logger.info(`🛡️ Verifying Mission ${upperId}: Result = ${result.toUpperCase()}`);

  if (result === 'verified') {
    state.status = transitionStatus(state.status, 'distilling');
  } else if (state.status !== 'active') {
    state.status = transitionStatus(state.status, 'active');
  }

  if (state.delegation) {
    state.delegation.verification_status = result;
    updateTrustScore(state.delegation.agent_id, result);
  }

  state.history.push({
    ts: new Date().toISOString(),
    event: 'VERIFY',
    note: `Verification ${result}: ${note}`,
  });

  await saveState(upperId, state);
  await syncProjectLedgerIfLinked(upperId);
  await emitMissionLifecycleIntentSnapshot({
    missionId: upperId,
    stage: 'verification',
    text: note,
    source: 'mission_state',
  });
  logger.success(`✅ Mission ${upperId} verification complete. Status: ${state.status}`);
}

export async function finishMission(
  id: string,
  seal: boolean,
  args: {
    archiveDir: string;
    agentRuntimeEventPath: string;
    getGitHash: (cwd: string) => string;
    sealMission: (missionId: string) => Promise<string | undefined>;
    syncProjectLedgerIfLinked: (missionId: string) => Promise<void>;
    transitionStatus: (current: string, next: string) => any;
  },
): Promise<void> {
  if (!id) {
    logger.error('Usage: mission_controller finish <MISSION_ID> [--seal]');
    return;
  }
  const upperId = id.toUpperCase();
  const preState = loadState(upperId);
  if (!preState) {
    logger.error(`❌ Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }
  if (preState.status === 'archived') {
    logger.info(`Mission ${upperId} is already archived.`);
    return;
  }
  if (preState.status !== 'completed' && preState.status !== 'distilling') {
    const steps: Record<string, string> = {
      planned: 'Run "start" to activate the mission first.',
      active: 'Run "verify" → "distill" to complete the mission lifecycle first.',
      validating: 'Run "distill" to extract knowledge before finishing.',
      paused: 'Run "start" to resume, then complete the lifecycle.',
      failed: 'Run "start" to retry, then complete the lifecycle.',
    };
    logger.error(`❌ Cannot finish mission ${upperId} (status: ${preState.status}). ${steps[preState.status] || ''}`);
    return;
  }

  await emitMissionLifecycleIntentSnapshot({
    missionId: upperId,
    stage: 'delivery',
    text: `Finish mission ${upperId}`,
    source: 'mission_state',
  });
  const driftSummary = evaluateMissionIntentDrift(upperId);
  if (driftSummary && !driftSummary.passed) {
    logger.error(`❌ [INTENT_DRIFT] Mission ${upperId} blocked: ${driftSummary.message}`);
    return;
  }

  const quality = await validateMissionQuality(upperId);
  if (!quality.ok) {
    logger.error(`❌ [QUALITY_REJECTION] Mission ${upperId} does not meet governance requirements: ${quality.reason}`);
    return;
  }

  const state = loadState(upperId);
  if (!state) throw new Error(`Mission ${upperId} not found.`);
  if (driftSummary) {
    state.context = {
      ...(state.context || {}),
      intent_delta_summary: driftSummary,
    };
  }

  const missionDir = findMissionPath(upperId);
  if (!missionDir) return;
  const evidenceRefs = collectMissionEvidenceRefs(missionDir);

  logger.info(`🏁 Finishing Mission: ${upperId}...`);

  try {
    safeExec('git', ['add', '.'], { cwd: missionDir });
    safeExec('git', ['commit', '-m', `feat: complete mission ${upperId}`], { cwd: missionDir });
    state.git.latest_commit = args.getGitHash(missionDir);
  } catch (_) {
    logger.info('No changes to commit in mission repo.');
  }

  if (state.status !== 'completed') {
    state.status = args.transitionStatus(state.status, 'completed');
    state.history.push({ ts: new Date().toISOString(), event: 'FINISH', note: 'Mission completed.' });
  }
  await saveState(upperId, state);
  await args.syncProjectLedgerIfLinked(upperId);

  if (seal || (state.tier === 'personal' && process.env.AUTO_SEAL === 'true')) {
    await args.sealMission(upperId);
  }

  try {
    const queued = queueMissionMemoryPromotionCandidate({
      missionId: upperId,
      missionType: state.mission_type,
      tier: state.tier,
      summary: state.outcome_contract?.requested_result || `Mission ${upperId} completed and yielded reusable operational memory.`,
      evidenceRefs,
    });
    logger.info(`🧠 [MEMORY_PROMOTION] queued candidate ${queued.candidate_id} (${queued.proposed_memory_kind}).`);
  } catch (err: any) {
    logger.warn(`⚠️ [MEMORY_PROMOTION] queue skipped for ${upperId}: ${err?.message || err}`);
  }

  ledger.record('MISSION_FINISH', {
    mission_id: upperId,
    status: 'completed',
    sealed: seal,
    archive_path: args.archiveDir,
  });

  recordAgentRuntimeEvent(args.agentRuntimeEventPath, {
    event: 'MISSION_FINISH_REFRESH_RECOMMENDED',
    mission_id: upperId,
    tier: state.tier,
    note: 'Mission finished. Control surfaces may refresh or restart mission-bound agents to reduce stale context.',
  });

  const missionTmpDir = pathResolver.sharedTmp(path.join('missions', upperId));
  if (safeExistsSync(missionTmpDir)) {
    logger.info('🧹 Purging mission runtime temp...');
    safeRmSync(missionTmpDir, { recursive: true, force: true });
  }

  if (!safeExistsSync(args.archiveDir)) safeMkdir(args.archiveDir, { recursive: true });
  const archivePath = path.join(args.archiveDir, upperId);
  if (safeExistsSync(archivePath)) safeExec('rm', ['-rf', archivePath]);
  safeExec('cp', ['-r', missionDir, archivePath]);
  safeExec('rm', ['-rf', missionDir]);

  state.status = args.transitionStatus(state.status, 'archived');
  state.history.push({ ts: new Date().toISOString(), event: 'ARCHIVE', note: `Mission archived to ${archivePath}.` });
  await saveState(upperId, state);
  logger.success(`📦 Mission ${upperId} archived and finalized.`);
}

export async function grantMissionAccess(missionId: string, serviceId: string, ttl = 30): Promise<void> {
  const upperId = missionId.toUpperCase();
  const state = loadState(upperId);
  if (!state) throw new Error(`Mission ${upperId} not found.`);
  grantAccess(upperId, serviceId, ttl);
  logger.success(`🔑 Access to "${serviceId}" granted to mission ${upperId} for ${ttl} minutes.`);
}

export async function grantMissionSudo(missionId: string, on = true, ttl = 15): Promise<void> {
  const upperId = missionId.toUpperCase();
  const state = loadState(upperId);
  if (!state) throw new Error(`Mission ${upperId} not found.`);
  if (on) {
    // Authority grants pass through the approval gate (auth:grant_authority).
    // Without an approved request on file this call throws, protecting against
    // unilateral SUDO escalation by agents.
    await grantAccessGuarded(upperId, 'SUDO', ttl, true, {
      agentId: 'mission_controller',
      correlationId: `${upperId}:SUDO`,
    });
    logger.warn(`⚠️ [SUDO] Full system authority granted to mission ${upperId} for ${ttl} minutes!`);
  } else {
    logger.info('[SUDO] Sudo will expire naturally or can be revoked by clearing auth-grants.json.');
  }
}
