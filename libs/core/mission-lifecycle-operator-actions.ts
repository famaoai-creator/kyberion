/** Operator-facing mission controls that do not perform completion gates. */

import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import { findMissionPath } from './path-resolver.js';
import { logger } from './core.js';
import { safeExec } from './secure-io.js';
import { loadState, loadStateForRepair, saveState } from './mission-state.js';
import { readTrustLedger, recordAgentRuntimeEvent } from './mission-governance.js';
import { deriveMissionBranchName, getCurrentBranch, getGitHash } from './mission-git.js';
import { isValidTenantSlug } from './entity-scope.js';
import { grantAccess, grantAccessGuarded } from './secret-guard.js';

export async function delegateMission(
  id: string,
  agentId: string,
  a2aMessageId: string,
  syncProjectLedgerIfLinked: (missionId: string) => Promise<void>
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

  const agent = readTrustLedger()[agentId];
  if (
    agent &&
    agent.current_score < 300 &&
    (state.tier === 'personal' || state.tier === 'confidential')
  ) {
    throw new Error(
      `CRITICAL: Agent ${agentId} has insufficient trust score (${agent.current_score}) for ${state.tier} tier mission.`
    );
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
  syncProjectLedgerIfLinked: (missionId: string) => Promise<void>
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

export async function pauseMission(id: string, note?: string): Promise<void> {
  if (!id) {
    logger.error('Usage: mission_controller pause <MISSION_ID> [--note "..."]');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found.`);
    return;
  }
  if (state.status === 'completed' || state.status === 'archived') {
    logger.info(`Mission ${upperId} is already ${state.status}.`);
    return;
  }
  if (state.status === 'paused') {
    logger.info(`Mission ${upperId} is already paused.`);
    return;
  }
  state.status = 'paused';
  state.context = {
    ...(state.context || {}),
    next_step: 'Resume the mission when the operator is ready.',
  };
  state.history.push({
    ts: new Date().toISOString(),
    event: 'PAUSE',
    note: note || 'Mission paused by operator request.',
  });
  await saveState(upperId, state);
  recordAgentRuntimeEvent(
    pathResolver.shared('observability/mission-control/agent-runtime-events.jsonl'),
    {
      event: 'MISSION_PAUSED',
      mission_id: upperId,
      note: note || 'Mission paused by operator request.',
    }
  );
  logger.warn(`⏸️ Mission ${upperId} paused.`);
}

export async function cancelMission(id: string, note?: string): Promise<void> {
  if (!id) {
    logger.error('Usage: mission_controller cancel <MISSION_ID> [--note "..."]');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found.`);
    return;
  }
  if (state.status === 'completed' || state.status === 'archived') {
    logger.info(`Mission ${upperId} is already ${state.status}.`);
    return;
  }
  state.status = 'failed';
  const reason = note || 'Mission cancelled by operator request.';
  state.context = {
    ...(state.context || {}),
    cancelled: true,
    cancel_reason: reason,
    next_step: 'Create a replacement mission if the work should continue.',
  };
  state.history.push({ ts: new Date().toISOString(), event: 'CANCEL', note: reason });
  await saveState(upperId, state);
  recordAgentRuntimeEvent(
    pathResolver.shared('observability/mission-control/agent-runtime-events.jsonl'),
    { event: 'MISSION_CANCELLED', mission_id: upperId, note: reason }
  );
  logger.warn(`🛑 Mission ${upperId} cancelled.`);
}

function inferMissionTierFromPath(
  missionPath: string
): 'personal' | 'confidential' | 'public' | null {
  const relative = path
    .relative(pathResolver.rootDir(), path.resolve(missionPath))
    .split(path.sep)
    .filter(Boolean);
  if (relative[0] === 'knowledge' && relative[1] === 'personal' && relative[2] === 'missions')
    return 'personal';
  if (
    relative[0] === 'active' &&
    relative[1] === 'missions' &&
    (relative[2] === 'confidential' || relative[2] === 'public')
  )
    return relative[2];
  if (relative[0] === 'active' && relative[1] === 'missions' && relative.length === 3)
    return 'public';
  return null;
}

export async function repairLegacyMissionState(id: string, note?: string): Promise<void> {
  if (!id) {
    logger.error('Usage: mission_controller repair <MISSION_ID> [--note "..."]');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadStateForRepair(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found.`);
    return;
  }
  const missionPath = findMissionPath(upperId);
  if (!missionPath) {
    logger.error(`Mission ${upperId} directory not found.`);
    return;
  }
  let latestCommit = state.git?.latest_commit || '';
  if (!latestCommit) {
    try {
      latestCommit = getGitHash(missionPath);
    } catch {
      latestCommit = 'legacy-repair';
    }
  }
  let branch = state.git?.branch || getCurrentBranch(missionPath);
  if (!branch || branch === 'HEAD' || branch === 'detached')
    branch = deriveMissionBranchName(upperId);
  const tierFromPath = inferMissionTierFromPath(missionPath);
  if (!tierFromPath)
    throw new Error(
      `[MISSION_STATE_TIER] Cannot infer a governed tier from mission path: ${missionPath}`
    );
  if (state.tier && state.tier !== tierFromPath) {
    throw new Error(
      `[MISSION_STATE_TIER] Mission tier '${state.tier}' conflicts with governed path tier '${tierFromPath}'`
    );
  }
  state.tier = tierFromPath;
  if (state.tenant_id && !isValidTenantSlug(state.tenant_id)) delete state.tenant_id;
  if (state.tenant_slug && !isValidTenantSlug(state.tenant_slug)) delete state.tenant_slug;
  state.execution_mode = state.execution_mode === 'delegated' ? 'delegated' : 'local';
  state.priority = typeof state.priority === 'number' ? state.priority : 3;
  state.assigned_persona = state.assigned_persona || 'operator';
  state.confidence_score = typeof state.confidence_score === 'number' ? state.confidence_score : 1;
  state.git = {
    branch,
    start_commit: state.git?.start_commit || latestCommit,
    latest_commit: latestCommit,
    checkpoints: Array.isArray(state.git?.checkpoints) ? state.git.checkpoints : [],
  };
  state.history = [
    ...(Array.isArray(state.history) ? state.history : []),
    {
      ts: new Date().toISOString(),
      event: 'LEGACY_STATE_REPAIRED',
      note:
        note || 'Repaired legacy mission state to the current schema before lifecycle transition.',
    },
  ];
  await saveState(upperId, state);
  logger.success(`✅ Repaired legacy mission state for ${upperId}.`);
}

export async function grantMissionAccess(
  missionId: string,
  serviceId: string,
  ttl = 30
): Promise<void> {
  const upperId = missionId.toUpperCase();
  if (!loadState(upperId)) throw new Error(`Mission ${upperId} not found.`);
  grantAccess(upperId, serviceId, ttl);
  logger.success(`🔑 Access to "${serviceId}" granted to mission ${upperId} for ${ttl} minutes.`);
}

export async function grantMissionSudo(missionId: string, on = true, ttl = 15): Promise<void> {
  const upperId = missionId.toUpperCase();
  if (!loadState(upperId)) throw new Error(`Mission ${upperId} not found.`);
  if (on) {
    await grantAccessGuarded(upperId, 'SUDO', ttl, true, {
      agentId: 'mission_controller',
      correlationId: `${upperId}:SUDO`,
    });
    logger.warn(
      `⚠️ [SUDO] Full system authority granted to mission ${upperId} for ${ttl} minutes!`
    );
  } else {
    logger.info(
      '[SUDO] Sudo will expire naturally or can be revoked by clearing auth-grants.json.'
    );
  }
}
