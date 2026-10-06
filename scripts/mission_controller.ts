/**
 * scripts/mission_controller.ts
 * Kyberion Sovereign Mission Controller (KSMC) v2.0
 * [SECURE-IO COMPLIANT]
 *
 * Architecture: Thin orchestration layer.
 * Domain logic lives in scripts/refactor/:
 *   - mission-types.ts           → Type definitions & constants
 *   - mission-cli-args.ts        → CLI argument parsing
 *   - mission-git.ts             → Git micro-repo operations
 *   - mission-state.ts           → State management & prerequisites
 *   - mission-project-ledger.ts  → Project ledger synchronization
 *   - mission-llm.ts             → LLM resolution & invocation
 *   - mission-distill.ts         → Knowledge distillation (Wisdom)
 *   - mission-seal.ts            → Cryptographic sealing (AES+RSA)
 */

import * as path from 'node:path';
import { auditChain } from '@agent/core/governance/audit-chain';
import { getRegisteredEnvText, setRegisteredEnv } from '@agent/core/foundation/env';
import { nowIso } from '@agent/core/foundation/time';
import { logger } from '@agent/core/core';
import { pathResolver, missionEvidenceDir } from '@agent/core/path-resolver';
import { safeExec, safeExistsSync, safeReaddir } from '@agent/core/secure-io';
import { killSwitch } from '@agent/core/governance/kill-switch';
import { buildHandoffPacket } from '@agent/core/mesh/handoff-packet';
import type { ArtifactReviewFinding } from '@agent/core/workforce/artifact-review';
import type * as MissionTriageCommands from './refactor/mission-triage-commands.js';
import type * as MissionMemoryCommands from './refactor/mission-memory-commands.js';
import type * as MissionOrganizationCommands from './refactor/mission-organization-commands.js';
import type * as MissionProcessPlanning from './refactor/mission-process-planning.js';
import type { HumanDecidedBy } from '@agent/core/mission/mission-types';

type Print = (value: unknown) => void;

function registeredEnv(name: string): string | undefined {
  return getRegisteredEnvText(name);
}

let activeMissionControllerArgs: string[] = [];
let activePrint: Print = () => undefined;

function printOutput(value: unknown): void {
  activePrint(value);
}

// --- Sub-module imports ---
import {
  resolveMissionStartCreateInputFromArgv,
  resolveMissionTicketDispatchOptionsFromArgv,
  resolveMissionWorkItemDispatchOptionsFromArgv,
  validateMissionStartCreateInput,
} from './refactor/mission-controller-args.js';
import { currentProcessArgv, defineScript, isDirectScript } from './lib/harness.js';
import { buildHelpText } from './refactor/mission-controller-help.js';
export { buildHelpText } from './refactor/mission-controller-help.js';
import {
  extractMissionControllerPositionalArgs,
  extractMissionStartCreateOptionsFromArgv,
  extractProjectRelationshipOptionsFromArgv,
  getOptionValue,
  parseCsvOption,
} from './refactor/mission-cli-args.js';
import {
  assertCanGrantMissionAuthority,
  writeFocusedMissionId as _writeFocusedMissionId,
  loadState,
  saveState,
  checkDependencies,
} from './refactor/mission-state.js';
import {
  assertMissionIdArgument,
  runMissionControllerAction,
} from './refactor/mission-controller-router.js';

// Re-export public API for backward compatibility (tests import these directly)
export {
  extractMissionControllerPositionalArgs,
  extractProjectRelationshipOptionsFromArgv,
  extractMissionStartCreateOptionsFromArgv,
  assertCanGrantMissionAuthority,
  resolveMissionStartCreateInputFromArgv,
  validateMissionStartCreateInput,
  resolveMissionTicketDispatchOptionsFromArgv,
  resolveMissionWorkItemDispatchOptionsFromArgv,
};
export type { ResolvedMissionCliInput } from './refactor/mission-controller-args.js';

// ─── Constants ───────────────────────────────────────────────────────────────
const ROOT_DIR = pathResolver.rootDir();
const QUEUE_PATH = pathResolver.shared('runtime/mission_queue.jsonl');
const MISSION_FOCUS_PATH = pathResolver.shared('runtime/current_mission_focus.json');

// ─── Focus helpers (thin wrappers binding MISSION_FOCUS_PATH) ────────────────
function writeFocusedMissionId(missionId: string): void {
  _writeFocusedMissionId(MISSION_FOCUS_PATH, missionId);
}

// ─── Project ledger helpers (bind ROOT_DIR) ───────────────────────────────────
async function syncProjectLedger(id: string): Promise<unknown> {
  const { missionSystem } = await import('./refactor/mission-system.js');
  return missionSystem.syncProjectLedger(id);
}

async function syncProjectLedgerIfLinked(id: string): Promise<unknown> {
  const { missionSystem } = await import('./refactor/mission-system.js');
  return missionSystem.syncProjectLedgerIfLinked(id);
}

async function reassignMissionProject(
  missionId: string,
  options: {
    projectId?: string;
    projectPath?: string;
    tier?: 'personal' | 'confidential' | 'public';
    trackId?: string;
    trackName?: string;
    relationshipType?: 'belongs_to' | 'supports' | 'governs' | 'independent';
    note?: string;
    force?: boolean;
    dryRun?: boolean;
  }
): Promise<unknown> {
  const { reassignMissionToProject } = await import('@agent/core/project/project-management');
  if (!options.projectId) throw new Error('reassign-project requires --project-id');
  const result = await reassignMissionToProject({
    mission_id: missionId,
    project_id: options.projectId,
    ...(options.projectPath ? { project_path: options.projectPath } : {}),
    ...(options.tier ? { tier: options.tier } : {}),
    ...(options.trackId ? { track_id: options.trackId } : {}),
    ...(options.trackName ? { track_name: options.trackName } : {}),
    ...(options.relationshipType ? { relationship_type: options.relationshipType } : {}),
    ...(options.note ? { note: options.note } : {}),
    ...(options.force ? { force: true } : {}),
    ...(options.dryRun ? { dry_run: true } : {}),
  });
  printOutput(JSON.stringify(result, null, 2));
  return result;
}

// ─── Mission seal / distill wrappers ─────────────────────────────────────────
async function sealMission(id: string): Promise<unknown> {
  const { missionSystem } = await import('./refactor/mission-system.js');
  return missionSystem.sealMission(id);
}

async function distillMission(id: string): Promise<void> {
  const { missionSystem } = await import('./refactor/mission-system.js');
  return missionSystem.distillMission(id);
}

async function dispatchMissionTickets(id: string): Promise<void> {
  const { missionSystem } = await import('./refactor/mission-system.js');
  const result = await missionSystem.dispatchMissionTickets(
    id,
    resolveMissionTicketDispatchOptionsFromArgv()
  );
  printOutput(JSON.stringify(result, null, 2));
}

async function dispatchMissionWorkItems(id: string): Promise<void> {
  const { missionLifecycleService } = await import('@agent/core/mission/mission-lifecycle-service');
  try {
    const result = await missionLifecycleService.dispatch(
      id,
      resolveMissionWorkItemDispatchOptionsFromArgv()
    );
    printOutput(JSON.stringify(result, null, 2));
  } finally {
    try {
      const { getReasoningBackend } = await import('@agent/core/reasoning/reasoning-backend');
      await getReasoningBackend().resetSession?.();
    } catch (error) {
      logger.warn(
        `[MISSION] reasoning backend session cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/**
 * Mission Commands
 */

async function enqueueMission(
  id: string,
  tier: 'personal' | 'confidential' | 'public',
  priority: number = 5,
  deps: string[] = []
) {
  const { enqueueMission: _enqueueMission } = await import('./refactor/mission-queue.js');
  await _enqueueMission(QUEUE_PATH, id, tier, priority, deps);
}

async function dispatchNextMission() {
  const { dispatchNextQueuedMission } = await import('./refactor/mission-queue.js');
  await dispatchNextQueuedMission(QUEUE_PATH, checkDependencies, async (missionId, tier) =>
    startMission(missionId, tier)
  );
}

async function createMission(
  id: string,
  tier: 'personal' | 'confidential' | 'public' = 'confidential',
  tenantId: string = 'default',
  missionType: string = 'development',
  visionRef?: string,
  persona: string = 'worker',
  relationships: Partial<import('./refactor/mission-types.js').MissionRelationships> = {},
  tenantSlug?: string,
  organizationId?: string,
  options?: { ephemeral?: boolean; intentGoal?: string }
) {
  const { missionLifecycleService } = await import('@agent/core/mission/mission-lifecycle-service');
  const { withOrganizationContext } = await import('./refactor/organization-context.js');
  return withOrganizationContext(organizationId, () =>
    missionLifecycleService.create(
      id,
      tier,
      tenantId,
      missionType,
      visionRef,
      persona,
      relationships,
      tenantSlug,
      { ...options, organizationId }
    )
  );
}

function formatRoutingDecisionSummary(
  routingDecision: Record<string, unknown> | null
): string | undefined {
  if (!routingDecision) return undefined;
  const mode = typeof routingDecision.mode === 'string' ? routingDecision.mode : 'unknown';
  const owner =
    typeof routingDecision.owner === 'string' && routingDecision.owner.trim()
      ? routingDecision.owner.trim()
      : undefined;
  const fanout =
    typeof routingDecision.fanout === 'string' && routingDecision.fanout !== 'none'
      ? routingDecision.fanout
      : undefined;
  const parts = [mode];
  if (owner) parts.push(`owner=${owner}`);
  if (fanout) parts.push(`fanout=${fanout}`);
  return parts.join(', ');
}

async function recordRoutingDecisionInMissionState(
  missionId: string,
  routingDecision: Record<string, unknown> | null,
  event: 'CREATE' | 'START'
): Promise<void> {
  if (!routingDecision) return;
  const targetId = missionId.toUpperCase();
  const state = loadState(targetId);
  if (!state) return;
  const summary = formatRoutingDecisionSummary(routingDecision);
  state.context = {
    ...(state.context || {}),
    routing_decision_summary: summary,
  };
  state.history.push({
    ts: nowIso(),
    event: 'ROUTE',
    note: `${event} routing decision: ${summary || 'unknown'}`,
  });
  await saveState(targetId, state);
}

/**
 * 4.5. Mission Directory Search Helper
 * Returns only the active tier directories (personal, confidential, public)
 * from mission-management-config.json — excludes archive, exports, and ledger paths.
 */
async function startMission(
  id: string,
  tier: 'personal' | 'confidential' | 'public' = 'confidential',
  persona: string = 'worker',
  tenantId: string = 'default',
  missionType: string = 'development',
  visionRef?: string,
  relationships: Partial<import('./refactor/mission-types.js').MissionRelationships> = {},
  tenantSlug?: string,
  organizationId?: string,
  options?: {
    ephemeral?: boolean;
    intentGoal?: string;
    force?: boolean;
    decidedBy?: HumanDecidedBy;
  }
) {
  const { missionLifecycleService } = await import('@agent/core/mission/mission-lifecycle-service');
  const { withOrganizationContext } = await import('./refactor/organization-context.js');
  await withOrganizationContext(organizationId, () =>
    missionLifecycleService.start(
      id,
      tier,
      persona,
      tenantId,
      missionType,
      visionRef,
      relationships,
      tenantSlug,
      { ...options, organizationId }
    )
  );
  const targetId = id.toUpperCase();
  const state = loadState(targetId);
  if (state?.status === 'active') {
    writeFocusedMissionId(targetId);
  }
}

// syncProjectLedger and syncProjectLedgerIfLinked are defined as wrappers
// earlier in this file (lines 97-104), delegating to mission-project-ledger.ts

async function delegateMission(id: string, agentId: string, a2aMessageId: string) {
  const { missionSystem } = await import('./refactor/mission-system.js');
  return missionSystem.delegateMission(id, agentId, a2aMessageId);
}

async function importMission(id: string, remoteUrl: string) {
  const { missionSystem } = await import('./refactor/mission-system.js');
  return missionSystem.importMission(id, remoteUrl);
}

async function verifyMission(id: string, result: 'verified' | 'rejected', note: string) {
  const { missionLifecycleService } = await import('@agent/core/mission/mission-lifecycle-service');
  const output = await missionLifecycleService.verify(id, result, note);
  if (result === 'verified') {
    syncIntentContractMemorySnapshot(id, 'verify');
  }
  return output;
}

// distillMission, sealMission and all LLM/distillation helpers are defined
// as thin wrappers at the top of this file, delegating to:
//   - scripts/refactor/mission-distill.ts (distillMission, helpers)
//   - scripts/refactor/mission-llm.ts (LLM resolution)
//   - scripts/refactor/mission-seal.ts (sealMission)

async function finishMission(id: string, seal: boolean = false) {
  const { missionLifecycleService } = await import('@agent/core/mission/mission-lifecycle-service');
  const result = await missionLifecycleService.finish(id, seal);
  const finalState = loadState(id.toUpperCase());
  const archivedPath = pathResolver.archivedMissionDir(id.toUpperCase());
  const finishReason = String(
    (finalState?.context as Record<string, unknown> | undefined)?.mission_finish_gate_last_reason ||
      ''
  );
  if (
    (finalState && finalState.status !== 'archived') ||
    (!finalState && !safeExistsSync(archivedPath))
  ) {
    printOutput(
      JSON.stringify({
        status: 'blocked',
        mission_id: id.toUpperCase(),
        gate_id: finishReason ? 'finish-gate' : 'lifecycle',
        reason: finishReason || `Mission archive was not confirmed at ${archivedPath}`,
      })
    );
    throw new Error(
      `Mission ${id.toUpperCase()} finish gate did not pass (status: ${finalState?.status || 'unknown'}).`
    );
  }
  syncIntentContractMemorySnapshot(id, 'finish');
  return result;
}

function syncIntentContractMemorySnapshot(id: string, stage: 'verify' | 'finish'): void {
  try {
    const upperId = id.toUpperCase();
    const reportPath = pathResolver.shared(
      `runtime/reports/intent-contract-memory-sync-${upperId}-${stage}.json`
    );
    const exportDir = pathResolver.shared(`exports/intent-contract-memory-sync/${upperId}`);
    safeExec(
      process.execPath,
      [
        'dist/scripts/sync_intent_contract_memory.js',
        '--report',
        reportPath,
        '--mission-id',
        upperId,
        '--stage',
        stage,
        '--persist-export',
        '--export-dir',
        exportDir,
      ],
      {
        cwd: ROOT_DIR,
        timeoutMs: 20_000,
        maxOutputMB: 5,
      }
    );
    logger.info(
      `🧠 Intent-contract memory synced (${stage}) report=${path.relative(ROOT_DIR, reportPath)}`
    );
  } catch (error: any) {
    logger.warn(`⚠️ Intent-contract memory sync skipped (${stage}): ${error?.message || error}`);
  }
}

async function createCheckpoint(taskId: string, note: string, explicitMissionId?: string) {
  const { missionLifecycleService } = await import('@agent/core/mission/mission-lifecycle-service');
  const { TraceContext, persistTrace } = await import('@agent/core/trace');
  const result = await missionLifecycleService.createCheckpoint(taskId, note, explicitMissionId);
  try {
    const tc = new TraceContext('mission:checkpoint', {
      missionId: explicitMissionId || (result as any)?.missionId || undefined,
    });
    tc.addEvent('checkpoint.recorded', {
      task_id: String(taskId),
      note: String(note).slice(0, 200),
      ...(explicitMissionId ? { mission_id: String(explicitMissionId) } : {}),
    });
    persistTrace(tc.finalize());
  } catch (_) {
    /* non-critical */
  }
  return result;
}

async function resumeMission(id?: string) {
  const { missionLifecycleService } = await import('@agent/core/mission/mission-lifecycle-service');
  const { resumeAiDlcPhaseState } = await import('@agent/core/aidlc-phase-state');
  const result = await missionLifecycleService.resume(id);
  if (id) {
    try {
      resumeAiDlcPhaseState(id);
    } catch {
      // Older missions may not have HO-02 state yet; lifecycle resume remains valid.
    }
  }
  return result;
}

async function pauseMission(id: string, note?: string, decidedBy?: HumanDecidedBy) {
  const { missionLifecycleService } = await import('@agent/core/mission/mission-lifecycle-service');
  return missionLifecycleService.pause(id, note, { decidedBy });
}

async function cancelMission(id: string, note?: string, decidedBy?: HumanDecidedBy) {
  const { missionSystem } = await import('./refactor/mission-system.js');
  return missionSystem.cancelMission(id, note, decidedBy);
}

async function repairLegacyMissionState(id: string, note?: string) {
  const { missionSystem } = await import('./refactor/mission-system.js');
  return missionSystem.repairLegacyMissionState(id, note);
}

async function recordTask(
  missionId: string,
  description: string,
  details: Record<string, unknown> = {}
) {
  const { missionSystem } = await import('./refactor/mission-system.js');
  return missionSystem.recordTask(missionId, description, details);
}

async function recordEvidence(
  missionId: string,
  taskId: string,
  note: string,
  evidence?: string[],
  teamRole?: string,
  actorId?: string,
  actorType?: 'agent' | 'human' | 'service'
) {
  const { missionSystem } = await import('./refactor/mission-system.js');
  const { TraceContext, persistTrace } = await import('@agent/core/trace');
  const result = await missionSystem.recordEvidence(
    missionId,
    taskId,
    note,
    evidence,
    teamRole,
    actorId,
    actorType
  );
  try {
    const tc = new TraceContext('mission:evidence', { missionId: missionId.toUpperCase() });
    const attrs: Record<string, string | number | boolean> = {
      mission_id: missionId.toUpperCase(),
      task_id: String(taskId),
      note: String(note).slice(0, 200),
    };
    if (teamRole) attrs.team_role = String(teamRole);
    if (actorId) attrs.actor_id = String(actorId);
    if (actorType) attrs.actor_type = String(actorType);
    if (evidence?.length) attrs.evidence_count = evidence.length;
    tc.addEvent('evidence.recorded', attrs);
    persistTrace(tc.finalize());
  } catch (_) {
    /* non-critical */
  }
  return result;
}

async function recordArtifactReview(
  missionId: string,
  reviewTaskId: string,
  reviewerAgentId: string,
  findings?: unknown[],
  reviewerTeamRole?: 'reviewer' | 'qa',
  specialistRoles?: string[]
) {
  const { missionSystem } = await import('./refactor/mission-system.js');
  const result = await missionSystem.recordArtifactReview(
    missionId,
    reviewTaskId,
    reviewerAgentId,
    (findings || []) as ArtifactReviewFinding[],
    reviewerTeamRole,
    specialistRoles
  );
  logger.info(
    `[review-task] ${reviewTaskId}: status=${result.status}${result.taskCompleted ? ' (task completed)' : ''}${
      result.reasons.length ? ` — ${result.reasons.join('; ')}` : ''
    }`
  );
  return result;
}

async function requestMissionWorkReconciliationApproval(
  missionId: string,
  manifestPath: string,
  requestedBy?: string
) {
  const { createMissionWorkReconciliationApprovalRequest } =
    await import('@agent/core/mission/mission-work-reconciliation');
  const result = createMissionWorkReconciliationApprovalRequest({
    missionId,
    manifestPath,
    requestedBy,
  });
  printOutput(JSON.stringify(result, null, 2));
  return result;
}

async function reconcileExistingWork(
  missionId: string,
  manifestPath: string,
  dryRun = false,
  approvalRequestId?: string
) {
  const { missionSystem } = await import('./refactor/mission-system.js');
  const result = await missionSystem.reconcileExistingWork(
    missionId,
    manifestPath,
    dryRun,
    approvalRequestId
  );
  printOutput(JSON.stringify(result, null, 2));
  return result;
}

async function reenterMissionFromReview(missionId: string) {
  const { missionSystem } = await import('./refactor/mission-system.js');
  const result = await missionSystem.reenterMissionFromReview(missionId);
  printOutput(JSON.stringify(result, null, 2));
  return result;
}

async function purgeMissions(dryRun: boolean = false): Promise<void> {
  const { missionSystem } = await import('./refactor/mission-system.js');
  // AL-01: purgeMissions now returns a structured PurgeMissionsResult; the
  // CLI router's context type is (dryRun?) => Awaitable<void> and never
  // consumed a return value, so drop it here to keep the thin-router contract.
  await missionSystem.purgeMissions(dryRun);
}

async function archiveMissions(
  options: { missionId?: string; execute?: boolean } = {}
): Promise<void> {
  const { missionLifecycleService } = await import('@agent/core/mission/mission-lifecycle-service');
  // AL-03: the archive verb is governed by the mission-lifecycle-service
  // facade (gate + audit). `--mission <ID>` archives one completed/failed
  // mission immediately (explicit operator action, age-independent);
  // otherwise it is the policy-driven sweep with the same dry-run-by-default
  // contract as `purge`.
  const result = options.missionId
    ? await missionLifecycleService.archive({ missionId: options.missionId })
    : await missionLifecycleService.archive({ dryRun: !options.execute });
  printOutput(JSON.stringify(result, null, 2));
}

/**
 * 6. Visibility Commands
 */
async function listMissions(filterStatus?: string, jsonOutput = false) {
  const { renderStatus } = await import('@agent/core/ux-vocabulary');
  const { listMissionSummaries } = await import('./refactor/mission-read-model.js');
  const missions = listMissionSummaries(filterStatus);

  if (jsonOutput) {
    // Machine-readable: always a JSON array on stdout, `[]` when nothing matches.
    printOutput(JSON.stringify(missions, null, 2));
    return;
  }

  if (missions.length === 0) {
    logger.info(filterStatus ? `No missions with status "${filterStatus}".` : 'No missions found.');
    return;
  }

  // Table header
  const header = `${'ID'.padEnd(30)} ${'STATUS'.padEnd(12)} ${'TIER'.padEnd(14)} ${'CP'.padStart(3)} LAST EVENT`;
  printOutput('');
  printOutput(header);
  printOutput('-'.repeat(header.length + 10));
  for (const m of missions) {
    const missionId = String(m.id ?? '-');
    const statusRaw = String(m.status ?? '-');
    const status = renderStatus('mission', statusRaw, 'en');
    const tier = String(m.tier ?? '-');
    const lastEvent = String(m.lastEvent ?? '-');
    const statusIcon =
      {
        active: '🟢',
        planned: '⚪',
        completed: '✅',
        paused: '⏸️ ',
        failed: '❌',
        validating: '🔍',
        distilling: '🧠',
        archived: '📦',
      }[statusRaw] || '  ';
    printOutput(
      `${missionId.padEnd(30)} ${statusIcon} ${status.padEnd(10)} ${tier.padEnd(14)} ${String(m.checkpoints).padStart(3)} ${lastEvent}`
    );
  }
  printOutput('');
  logger.info(`${missions.length} mission(s) found.`);
}

async function showMissionStatus(id: string, follow: boolean = false) {
  const { missionLifecycleService } = await import('@agent/core/mission/mission-lifecycle-service');
  const { renderStatus } = await import('@agent/core/ux-vocabulary');
  const { buildMissionStatusView } = await import('./refactor/mission-read-model.js');
  if (!id) {
    logger.error('Usage: mission_controller status <MISSION_ID>');
    return;
  }
  const view = missionLifecycleService.status(id);
  if (!view) {
    logger.error(`Mission ${id.toUpperCase()} not found. Run "list" to see available missions.`);
    return;
  }
  const { state, missionPath, nextAction, recentHistory } = view;

  printOutput('');
  printOutput(`  Mission:     ${state.mission_id}`);
  printOutput(`  Status:      ${renderStatus('mission', state.status, 'en')}`);
  printOutput(`  Tier:        ${state.tier}`);
  printOutput(`  Persona:     ${state.assigned_persona}`);
  printOutput(`  Confidence:  ${state.confidence_score}`);
  printOutput(`  Priority:    ${state.priority}`);
  printOutput(`  Mode:        ${state.execution_mode}`);
  if (state.classification) {
    printOutput(
      `  Class:       ${state.classification.mission_class} (risk: ${state.classification.risk_profile}, shape: ${state.classification.delivery_shape})`
    );
  }
  if (state.process_template) {
    printOutput(
      `  Process:     ${state.process_template.workflow_id} — ${state.process_template.phases.join(' → ')}`
    );
  }
  printOutput(`  Branch:      ${state.git.branch}`);
  printOutput(`  Commit:      ${state.git.latest_commit.slice(0, 8)}`);
  printOutput(`  Checkpoints: ${state.git.checkpoints.length}`);
  if (missionPath) {
    printOutput(`  Directory:   ${path.relative(ROOT_DIR, missionPath)}`);
  }

  if (state.delegation) {
    printOutput(
      `  Delegated:   ${state.delegation.agent_id} (${state.delegation.verification_status})`
    );
  }

  if (state.relationships?.prerequisites?.length) {
    printOutput(`  Prereqs:     ${state.relationships.prerequisites.join(', ')}`);
  }
  if (state.relationships?.project) {
    printOutput(`  Project:     ${state.relationships.project.project_id || '-'}`);
    printOutput(`  Relation:    ${state.relationships.project.relationship_type}`);
    printOutput(`  Gate Impact: ${state.relationships.project.gate_impact || 'none'}`);
  }
  if (state.relationships?.track) {
    printOutput(`  Track:       ${state.relationships.track.track_id || '-'}`);
    if (state.relationships.track.track_name) {
      printOutput(`  Track Name:  ${state.relationships.track.track_name}`);
    }
    printOutput(`  Track Rel:   ${state.relationships.track.relationship_type}`);
  }
  if (state.context?.routing_decision_summary) {
    printOutput(`  Routing:     ${state.context.routing_decision_summary}`);
  }

  printOutput(`  Next:        ${nextAction}`);

  // Recent history (last 5)
  printOutput('');
  printOutput('  Recent History:');
  for (const h of recentHistory) {
    printOutput(`    ${h.ts.slice(0, 16)}  [${h.event}]  ${h.note}`);
  }
  printOutput('');

  if (follow) {
    printOutput(
      `  [SYS] Following mission ledger for ${id.toUpperCase()}... (Press Ctrl-C to exit)\n`
    );
    let lastHistoryLength = view.state.history.length;
    setInterval(() => {
      const current = buildMissionStatusView(id);
      if (current && current.state.history.length > lastHistoryLength) {
        const newEvents = current.state.history.slice(lastHistoryLength);
        for (const h of newEvents) {
          printOutput(`    ${h.ts.slice(0, 16)}  [${h.event}]  ${h.note}`);
        }
        lastHistoryLength = current.state.history.length;
      }
    }, 2000);
  }
}

async function showReasoningBackendStatus(): Promise<void> {
  const [{ getInstalledReasoningMode }, { discoverProviders }, { discoverReasoningEndpoints }] =
    await Promise.all([
      import('@agent/core/reasoning/reasoning-bootstrap'),
      import('@agent/core/provider/provider-discovery'),
      import('@agent/core/reasoning/reasoning-endpoint-discovery'),
    ]);
  const selectedMode = getInstalledReasoningMode();
  const forceRefresh =
    activeMissionControllerArgs.includes('--refresh-providers') ||
    registeredEnv('KYBERION_PROVIDER_DISCOVERY_REFRESH') === '1';
  const providers = discoverProviders(forceRefresh).filter((provider) =>
    ['claude', 'gemini', 'codex'].includes(provider.provider)
  );

  printOutput('');
  printOutput('  Reasoning Backend:');
  printOutput(
    `    Selected: ${selectedMode || registeredEnv('KYBERION_REASONING_BACKEND') || 'auto'}`
  );
  printOutput(
    `    Wisdom profile: ${registeredEnv('KYBERION_WISDOM_LLM_PROFILE') || 'distill policy default'}`
  );
  for (const provider of providers) {
    const state = provider.installed
      ? provider.healthy
        ? 'ready'
        : 'installed-unhealthy'
      : 'missing';
    const version = provider.version || 'n/a';
    printOutput(`    ${provider.provider.padEnd(6)} ${state.padEnd(18)} ${version}`);
  }
  printOutput('    Endpoint runtimes:');
  for (const endpoint of discoverReasoningEndpoints()) {
    const state = endpoint.configured ? 'configured' : 'not-configured';
    printOutput(
      `      ${endpoint.runtime.padEnd(14)} ${state.padEnd(18)} ${endpoint.configuration_env.join(' | ')}`
    );
  }
  printOutput('');
}

function showHelp() {
  printOutput(buildHelpText());
}

async function showMissionTeam(
  id: string,
  refresh = false,
  organizationId?: string,
  providerPreference?: { provider: string; modelId?: string }
) {
  const { missionSystem } = await import('./refactor/mission-system.js');
  const { withOrganizationContext } = await import('./refactor/organization-context.js');
  return withOrganizationContext(organizationId, () =>
    missionSystem.showMissionTeam(id, refresh, providerPreference)
  );
}

async function staffMissionTeam(
  id: string,
  organizationId?: string,
  providerPreference?: { provider: string; modelId?: string }
) {
  const { missionLifecycleService } = await import('@agent/core/mission/mission-lifecycle-service');
  const { withOrganizationContext } = await import('./refactor/organization-context.js');
  return withOrganizationContext(organizationId, () =>
    missionLifecycleService.staff(id, { providerPreference })
  );
}

async function adviseMission(
  id: string,
  input: { topic: string; question: string; context?: string; roles?: string[] },
  organizationId?: string
) {
  const { missionLifecycleService } = await import('@agent/core/mission/mission-lifecycle-service');
  const { withOrganizationContext } = await import('./refactor/organization-context.js');
  return withOrganizationContext(organizationId, () => missionLifecycleService.advise(id, input));
}

async function proposeMissionRoster(
  id: string,
  options: { missionContext?: string; force?: boolean },
  organizationId?: string
) {
  const { missionLifecycleService } = await import('@agent/core/mission/mission-lifecycle-service');
  const { withOrganizationContext } = await import('./refactor/organization-context.js');
  return withOrganizationContext(organizationId, () =>
    missionLifecycleService.proposeRoster(id, options)
  );
}

async function prewarmMissionTeam(id: string, teamRolesArg?: string, organizationId?: string) {
  const { missionLifecycleService } = await import('@agent/core/mission/mission-lifecycle-service');
  const { withOrganizationContext } = await import('./refactor/organization-context.js');
  return withOrganizationContext(organizationId, () =>
    missionLifecycleService.prewarm(id, teamRolesArg)
  );
}

async function restaffMissionTeam(
  id: string,
  teamRole: string,
  options: { requiredCapabilities?: string[]; excludeAgentIds?: string[]; reason?: string },
  organizationId?: string
) {
  const { missionLifecycleService } = await import('@agent/core/mission/mission-lifecycle-service');
  const { withOrganizationContext } = await import('./refactor/organization-context.js');
  return withOrganizationContext(organizationId, () =>
    missionLifecycleService.restaff(id, teamRole, options)
  );
}

async function classifyMission(id: string, intentId?: string, taskType?: string): Promise<void> {
  const { resolveMissionClassification } =
    await import('@agent/core/mission/mission-classification');
  if (!id) {
    logger.error('Usage: mission_controller classify <MISSION_ID> [intent_id] [task_type]');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found.`);
    return;
  }
  const classification = resolveMissionClassification({
    missionTypeHint: state.mission_type,
    intentId,
    taskType,
    shape: 'mission',
    utterance: `${state.mission_type || ''} ${state.vision_ref || ''}`.trim(),
  });
  printOutput(JSON.stringify({ mission_id: upperId, classification }, null, 2));
}

async function selectMissionWorkflow(
  id: string,
  intentId?: string,
  taskType?: string
): Promise<void> {
  const { resolveMissionClassification } =
    await import('@agent/core/mission/mission-classification');
  const { resolveMissionWorkflowDesign } =
    await import('@agent/core/mission/mission-workflow-catalog');
  if (!id) {
    logger.error('Usage: mission_controller workflow-select <MISSION_ID> [intent_id] [task_type]');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found.`);
    return;
  }
  const classification = resolveMissionClassification({
    missionTypeHint: state.mission_type,
    intentId,
    taskType,
    shape: 'mission',
    utterance: `${state.mission_type || ''} ${state.vision_ref || ''}`.trim(),
  });
  const workflow = resolveMissionWorkflowDesign({
    missionClass: classification.mission_class,
    deliveryShape: classification.delivery_shape,
    riskProfile: classification.risk_profile,
    stage: classification.stage,
    executionShape: 'mission',
    missionTypeHint: state.mission_type,
    intentId,
    taskType,
  });
  printOutput(JSON.stringify({ mission_id: upperId, classification, workflow }, null, 2));
}

async function reviewWorkerOutput(
  id: string,
  result: 'verified' | 'rejected' = 'verified',
  note?: string
): Promise<void> {
  if (!id) {
    logger.error(
      'Usage: mission_controller review-worker-output <MISSION_ID> [verified|rejected] [note]'
    );
    return;
  }
  await verifyMission(id, result, note || `Worker output ${result} by operator review.`);
}

export async function handoffMission(
  id: string,
  nextPersona: string,
  note?: string
): Promise<void> {
  const { releaseOrchestratorSessionForMissionBestEffort } =
    await import('@agent/core/mission/orchestrator-session');
  const { recordMissionHandoff } = await import('@agent/core/workforce/work-coordination');
  if (!id || !nextPersona) {
    logger.error('Usage: mission_controller handoff <MISSION_ID> <NEXT_PERSONA> [note]');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found.`);
    return;
  }
  const previousPersona = state.assigned_persona;
  const handoffPacket = buildHandoffPacket({
    kind: 'mission',
    correlationId: `${upperId}:${previousPersona}->${nextPersona}:${Date.now().toString(36)}`,
    outgoingSummary:
      note ||
      state.context?.context_pack_summary ||
      state.context?.last_action ||
      `Mission ${upperId} handed off from ${previousPersona} to ${nextPersona}.`,
    rationale:
      note ||
      state.context?.intent_delta_summary?.message ||
      `Continue mission ${upperId} under ${nextPersona}.`,
    openDecisions: [
      ...(state.context?.blockers || []),
      ...(state.context?.mission_completion_summary?.gaps || []),
      ...(state.context?.mission_completion_next_action?.gaps || []),
    ],
    partialArtifacts: [
      ...(state.context?.mission_completion_summary?.delivered || []),
      ...(state.context?.mission_completion_next_action?.delivered || []),
      ...(state.context?.associated_projects || []),
    ],
    remainingAcceptanceCriteria: [
      ...(state.context?.mission_completion_summary?.gaps || []),
      ...(state.context?.mission_completion_next_action?.gaps || []),
      ...(state.context?.next_step ? [state.context.next_step] : []),
      ...(state.context?.mission_completion_next_action?.next_step
        ? [state.context.mission_completion_next_action.next_step]
        : []),
    ],
    sourceRef: `persona:${previousPersona}`,
    targetRef: `persona:${nextPersona}`,
  });
  state.assigned_persona = nextPersona;
  state.history.push({
    ts: nowIso(),
    event: 'HANDOFF',
    from: previousPersona,
    to: nextPersona,
    note: note || `Handoff from ${previousPersona} to ${nextPersona}.`,
    handoff_packet: handoffPacket,
  });
  await saveState(upperId, state);
  // Keep mission-level and WorkItem-level handoff state in the same durable
  // coordination ledger. This is metadata-only: active leases remain owned by
  // their current worker until an explicit WorkItem handoff is requested.
  recordMissionHandoff({
    missionId: upperId,
    fromPersona: previousPersona,
    toPersona: nextPersona,
    handoffPacket,
  });
  await syncProjectLedgerIfLinked(upperId);
  // SO-02: the CLI orchestrator taking over means any conversation-thread
  // owner steps down — release its orchestrator session (if any).
  // Best-effort: a release failure must never fail a handoff that already
  // completed (state is already saved above).
  releaseOrchestratorSessionForMissionBestEffort(upperId, 'handoff');
  logger.success(`✅ Mission ${upperId} handoff complete: ${previousPersona} -> ${nextPersona}`);
}

async function grantMissionAccess(missionId: string, serviceId: string, ttl: number = 30) {
  const { missionSystem } = await import('./refactor/mission-system.js');
  assertCanGrantMissionAuthority();
  return missionSystem.grantMissionAccess(missionId, serviceId, ttl);
}

async function resolveGate(missionId: string, gateFile?: string): Promise<string> {
  const evidDir = missionEvidenceDir(missionId.toUpperCase());
  if (!evidDir) throw new Error(`Mission ${missionId} evidence directory not found.`);
  if (gateFile) {
    const abs = path.isAbsolute(gateFile) ? gateFile : path.resolve(evidDir, gateFile);
    if (!safeExistsSync(abs)) throw new Error(`Gate file not found: ${abs}`);
    return abs;
  }
  const files = safeReaddir(evidDir) as string[];
  const gates = files.filter((f) => f.endsWith('-gate.json'));
  if (gates.length === 0) throw new Error(`No gate files found in ${evidDir}`);
  if (gates.length > 1)
    throw new Error(`Multiple gates found — specify gate file: ${gates.join(', ')}`);
  return path.join(evidDir, gates[0]);
}

async function gatePass(missionId: string, gateFile?: string, note?: string): Promise<void> {
  const { recordMissionGateOverride } = await import('@agent/core/mission/mission-gate-engine');
  const {
    activateMissionOnGateProgress,
    advanceCurrentPhase,
    evaluateStoredMissionGate,
    markPhaseTasksCompleted,
  } = await import('./refactor/mission-process-planning.js');
  if (!missionId) {
    logger.error(
      'Usage: mission_controller gate-pass <MISSION_ID> [gate-file.json|GATE_ID] [--note "..."]'
    );
    return;
  }
  // Process-template gates (MO-01/MO-02): when a stored gate definition
  // exists, machine-evaluate its checks instead of recording a bare override.
  // The operator command itself satisfies reviewer/human confirmation checks.
  if (gateFile && !gateFile.endsWith('.json')) {
    const stored = await evaluateStoredMissionGate({
      missionId,
      gateId: gateFile,
      humanConfirmed: true,
    });
    if (stored.found && stored.evaluation) {
      const upperId = missionId.toUpperCase();
      auditChain.record({
        agentId: registeredEnv('KYBERION_PERSONA') || 'operator',
        action: stored.evaluation.verdict === 'pass' ? 'gate.passed' : 'gate.rejected',
        operation: `gate-pass:${gateFile}`,
        result: 'completed',
        metadata: {
          mission_id: upperId,
          gate_id: gateFile,
          verdict: stored.evaluation.verdict,
          reasons: stored.evaluation.reasons,
          evidence_path: stored.evaluation.evidence_path,
          note,
        },
      });
      if (stored.evaluation.verdict === 'pass') {
        if (stored.position === 'exit' && stored.phase) {
          await advanceCurrentPhase(upperId, stored.phase);
          const completed = markPhaseTasksCompleted(upperId, stored.phase);
          if (completed > 0) {
            logger.info(`   ${completed} task(s) in phase ${stored.phase} marked completed.`);
          }
        }
        if (await activateMissionOnGateProgress(upperId)) {
          logger.info('   Mission status: planned → active (first gate passed).');
        }
        logger.success(`✅ [GATE] ${gateFile} → passed (mission: ${upperId})`);
      } else {
        logger.warn(`❌ [GATE] ${gateFile} checks failed (mission: ${upperId}):`);
        for (const reason of stored.evaluation.reasons) logger.warn(`   - ${reason}`);
        logger.info(
          '   Resolve the failing checks, or record a legacy override via a gate evidence file.'
        );
      }
      return;
    }
  }
  const gatePath = await resolveGate(missionId, gateFile);
  const overridePath = recordMissionGateOverride({
    missionId: missionId.toUpperCase(),
    gateId: path.basename(gatePath).replace(/-\w+\.json$/u, ''),
    outcome: 'passed',
    note,
    actorId: registeredEnv('KYBERION_PERSONA') || 'operator',
    evidenceDir: path.dirname(gatePath),
  });
  auditChain.record({
    agentId: registeredEnv('KYBERION_PERSONA') || 'operator',
    action: 'gate.passed',
    operation: `gate-pass:${path.basename(gatePath)}`,
    result: 'completed',
    metadata: {
      mission_id: missionId.toUpperCase(),
      gate_file: gatePath,
      override_path: overridePath,
      note,
    },
  });
  logger.success(
    `✅ [GATE] ${path.basename(gatePath)} → passed (mission: ${missionId.toUpperCase()})`
  );
  logger.info(`   Override record: ${overridePath}`);
}

async function gateFail(missionId: string, gateFile?: string, note?: string): Promise<void> {
  const { recordMissionGateOverride } = await import('@agent/core/mission/mission-gate-engine');
  const { evaluateStoredMissionGate, markPhaseTasksForRework } =
    await import('./refactor/mission-process-planning.js');
  if (!missionId) {
    logger.error(
      'Usage: mission_controller gate-fail <MISSION_ID> [gate-file.json|GATE_ID] [--note "..."]'
    );
    return;
  }
  // Process-template gates: record the failure and flip the phase's tasks to
  // rework so dependency-first dispatch re-executes them.
  if (gateFile && !gateFile.endsWith('.json')) {
    const stored = await evaluateStoredMissionGate({ missionId, gateId: gateFile });
    if (stored.found) {
      const upperId = missionId.toUpperCase();
      const reworked = stored.phase ? markPhaseTasksForRework(upperId, stored.phase) : 0;
      auditChain.record({
        agentId: registeredEnv('KYBERION_PERSONA') || 'operator',
        action: 'gate.rejected',
        operation: `gate-fail:${gateFile}`,
        result: 'completed',
        metadata: {
          mission_id: upperId,
          gate_id: gateFile,
          phase: stored.phase,
          reworked_tasks: reworked,
          note,
        },
      });
      logger.warn(`❌ [GATE] ${gateFile} → rejected (mission: ${upperId})`);
      if (reworked > 0) {
        logger.info(`   ${reworked} task(s) in phase ${stored.phase} flipped to rework.`);
      }
      if (note) logger.info(`   Reason: ${note}`);
      return;
    }
  }
  const gatePath = await resolveGate(missionId, gateFile);
  const overridePath = recordMissionGateOverride({
    missionId: missionId.toUpperCase(),
    gateId: path.basename(gatePath).replace(/-\w+\.json$/u, ''),
    outcome: 'rejected',
    note,
    actorId: registeredEnv('KYBERION_PERSONA') || 'operator',
    evidenceDir: path.dirname(gatePath),
  });
  auditChain.record({
    agentId: registeredEnv('KYBERION_PERSONA') || 'operator',
    action: 'gate.rejected',
    operation: `gate-fail:${path.basename(gatePath)}`,
    result: 'completed',
    metadata: {
      mission_id: missionId.toUpperCase(),
      gate_file: gatePath,
      override_path: overridePath,
      note,
    },
  });
  logger.warn(
    `❌ [GATE] ${path.basename(gatePath)} → rejected (mission: ${missionId.toUpperCase()})`
  );
  logger.info(`   Override record: ${overridePath}`);
  if (note) logger.info(`   Reason: ${note}`);
}

async function grantMissionSudo(missionId: string, on: boolean = true, ttl: number = 15) {
  const { missionSystem } = await import('./refactor/mission-system.js');
  assertCanGrantMissionAuthority();
  return missionSystem.grantMissionSudo(missionId, on, ttl);
}

async function approveScopeChange(
  missionId: string,
  options?: {
    approvedBy?: string;
    reason?: string;
    goalSummary?: string;
    successCondition?: string;
    approvalRequestId?: string;
  }
): Promise<void> {
  const { missionSystem } = await import('./refactor/mission-system.js');
  // The approval-mediated path validates the human approval inside
  // approveScopeChange; SUDO is only required for the direct path.
  if (!options?.approvalRequestId?.trim()) {
    assertCanGrantMissionAuthority();
  }
  return missionSystem.approveScopeChange(missionId, options);
}

/**
 * Journal-only actions that never delegate to a reasoning backend.
 * Skipping the reasoning bootstrap (~3s of CLI availability probes per
 * spawn) keeps high-frequency per-task `record-task`/`record-evidence`
 * spawns cheap. Unknown actions fail safe toward installing: delegation
 * must never silently fall back to the stub.
 */
const REASONING_FREE_ACTIONS: ReadonlySet<string> = new Set([
  'help',
  'record-task',
  'record-evidence',
  // Journal/state-only verbs: they never delegate to a reasoning backend, so
  // skipping the ~3s backend bootstrap keeps the triage loop cheap.
  'triage',
  'scope-approve',
  // Read-only views: they read mission/organization/outbox/memory state from disk and
  // never delegate. (`status` only reports the backend; it does not need it installed.)
  'list',
  'status',
  'outbox',
  'suggestions',
  'hygiene',
  'organization-catalogs',
  'organization-profiles',
  'organization-profile',
  'organization-discovery',
  'memory-queue',
  'memory-review',
]);

/** Whether this action may skip the reasoning-backend bootstrap. Exported for tests. */
export function shouldSkipReasoningBootstrap(action: string | undefined): boolean {
  return !!action && REASONING_FREE_ACTIONS.has(action);
}

function triageCommands(): Promise<typeof MissionTriageCommands> {
  return import('./refactor/mission-triage-commands.js');
}

function memoryCommands(): Promise<typeof MissionMemoryCommands> {
  return import('./refactor/mission-memory-commands.js');
}

function organizationCommands(): Promise<typeof MissionOrganizationCommands> {
  return import('./refactor/mission-organization-commands.js');
}

function processPlanning(): Promise<typeof MissionProcessPlanning> {
  return import('./refactor/mission-process-planning.js');
}

/**
 * 7. Main Entry
 */
async function mainImpl(
  args: string[] = currentProcessArgv(),
  print: Print = () => undefined
): Promise<void> {
  activeMissionControllerArgs = [...args];
  const requestedAction = args[0];
  const isHelpFlag = args.includes('--help') || args.includes('-h');
  if (isHelpFlag && requestedAction !== 'help') {
    showHelp();
    return;
  }

  const earlyPositionalArgs = extractMissionControllerPositionalArgs(args);
  assertMissionIdArgument(earlyPositionalArgs[0], earlyPositionalArgs[1]);
  if (earlyPositionalArgs[1]) {
    setRegisteredEnv('MISSION_ID', earlyPositionalArgs[1].toUpperCase());
  }

  // Self-identify as mission_controller role for tier-guard resolution.
  if (!getRegisteredEnvText('MISSION_ROLE')) {
    setRegisteredEnv('MISSION_ROLE', 'mission_controller');
  }
  // Register reasoning backends so dispatch-workitems delegation reaches a
  // real backend (claude-cli/anthropic) instead of silently using the stub.
  // Journal-only actions never delegate; skip their probe cost.
  if (!shouldSkipReasoningBootstrap(earlyPositionalArgs[0] ?? 'help')) {
    const { installReasoningBackends } = await import('@agent/core/reasoning/reasoning-bootstrap');
    installReasoningBackends();
    // Import side effects: the canonical A2A route (without it every
    // agent_runtime dispatch fails with "has no A2A/runtime route") and pane
    // prompt escalation into approval requests. Journal-only verbs never
    // dispatch agents, so they skip this graph with the reasoning bootstrap.
    await import('@agent/core/mesh/a2a-bridge');
    await import('@agent/core/agent/agent-prompt-approval');
  }
  killSwitch.startMonitor(Number(registeredEnv('KYBERION_KILL_SWITCH_INTERVAL_MS') || 10000));

  const positionalArgs = extractMissionControllerPositionalArgs(args);

  const action = positionalArgs[0];
  const arg1 = positionalArgs[1];
  const arg2 = positionalArgs[2];
  const arg3 = positionalArgs[3];
  const arg4 = positionalArgs[4];
  const arg5 = positionalArgs[5];
  const arg6 = positionalArgs[6];
  const arg7 = positionalArgs[7];

  const hasRefresh = args.includes('--refresh');
  const hasDryRun = args.includes('--dry-run');
  await runMissionControllerAction({
    argv: args,
    print,
    action,
    arg1,
    arg2,
    arg3,
    arg4,
    arg5,
    arg6,
    arg7,
    hasRefresh,
    hasDryRun,
    getOptionValue,
    parseCsvOption,
    validateMissionStartCreateInput,
    createMission,
    startMission,
    recordRoutingDecisionInMissionState,
    grantMissionAccess,
    grantMissionSudo,
    approveScopeChange,
    requestMissionScopeApproval: async (
      id: string,
      options?: Parameters<typeof MissionTriageCommands.runScopeApproveRequestApproval>[1]
    ) => (await triageCommands()).runScopeApproveRequestApproval(id, options, printOutput),
    triageMission: async (
      id: string,
      options?: Parameters<typeof MissionTriageCommands.runMissionTriage>[1]
    ) => (await triageCommands()).runMissionTriage(id, options, printOutput),
    createCheckpoint,
    delegateMission,
    importMission,
    verifyMission,
    distillMission,
    dispatchMissionTickets,
    dispatchMissionWorkItems,
    sealMission,
    enqueueMission,
    dispatchNextMission,
    acceptRubricOverride: async (
      ...input: Parameters<typeof MissionMemoryCommands.acceptRubricOverride>
    ) => (await memoryCommands()).acceptRubricOverride(...input),
    listMemoryQueue: async (...input: Parameters<typeof MissionMemoryCommands.listMemoryQueue>) =>
      (await memoryCommands()).listMemoryQueue(...input),
    showMemoryReview: async (...input: Parameters<typeof MissionMemoryCommands.showMemoryReview>) =>
      (await memoryCommands()).showMemoryReview(...input),
    approveMemoryCandidate: async (
      ...input: Parameters<typeof MissionMemoryCommands.approveMemoryCandidate>
    ) => (await memoryCommands()).approveMemoryCandidate(...input),
    rejectMemoryCandidate: async (
      ...input: Parameters<typeof MissionMemoryCommands.rejectMemoryCandidate>
    ) => (await memoryCommands()).rejectMemoryCandidate(...input),
    promoteMemoryCandidate: async (
      ...input: Parameters<typeof MissionMemoryCommands.promoteMemoryCandidate>
    ) => (await memoryCommands()).promoteMemoryCandidate(...input),
    promotePendingMemoryCandidates: async (
      ...input: Parameters<typeof MissionMemoryCommands.promotePendingMemoryCandidates>
    ) => (await memoryCommands()).promotePendingMemoryCandidates(...input),
    finishMission,
    resumeMission,
    pauseMission,
    cancelMission,
    repairLegacyMissionState,
    recordTask,
    recordEvidence,
    recordArtifactReview,
    requestMissionWorkReconciliationApproval,
    reconcileExistingWork,
    reenterMissionFromReview,
    purgeMissions,
    archiveMissions,
    listMissions,
    listOrganizationCatalogs: async (organizationId, jsonOutput, output) =>
      (await organizationCommands()).listOrganizationCatalogs(
        organizationId,
        jsonOutput,
        args,
        output
      ),
    listOrganizationProfiles: async (organizationId, output) =>
      (await organizationCommands()).listOrganizationProfiles(
        organizationId,
        args,
        ROOT_DIR,
        output
      ),
    showOrganizationProfile: async (organizationId, summaryOnly, jsonOutput, output) =>
      (await organizationCommands()).showOrganizationProfile(
        organizationId,
        summaryOnly,
        jsonOutput,
        output
      ),
    showOrganizationDiscovery: async (jsonOutput, summaryOnly, output) =>
      (await organizationCommands()).showOrganizationDiscovery(jsonOutput, summaryOnly, output),
    showMissionStatus,
    showReasoningBackendStatus,
    syncProjectLedger,
    reassignMissionProject,
    showMissionTeam,
    staffMissionTeam,
    prewarmMissionTeam,
    restaffMissionTeam,
    proposeMissionRoster,
    adviseMission,
    classifyMission,
    selectMissionWorkflow,
    planProcessTemplateTasks: async (
      ...input: Parameters<typeof MissionProcessPlanning.planProcessTemplateTasks>
    ) => (await processPlanning()).planProcessTemplateTasks(...input),
    reviewWorkerOutput,
    handoffMission,
    gatePass,
    gateFail,
    showHelp,
  });
}

export async function main(
  args: string[] = currentProcessArgv(),
  print: Print = () => undefined
): Promise<void> {
  const previousPrint = activePrint;
  activePrint = print;
  try {
    await mainImpl(args, print);
  } finally {
    activePrint = previousPrint;
  }
}

export const runMissionController = defineScript({
  name: 'mission:controller',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});

if (
  isDirectScript(import.meta.url, 'mission_controller.ts') ||
  isDirectScript(import.meta.url, 'mission_controller.js')
)
  void runMissionController();
