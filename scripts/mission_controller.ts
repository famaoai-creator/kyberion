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
import { auditChain } from '@agent/core/audit-chain';
import { discoverProviders } from '@agent/core/provider-discovery';
import { discoverReasoningEndpoints } from '@agent/core/reasoning-endpoint-discovery';
import {
  getInstalledReasoningMode,
  installReasoningBackends,
} from '@agent/core/reasoning-bootstrap';
import { getRegisteredEnv } from '@agent/core/foundation/env';
import { nowIso } from '@agent/core/foundation';
import { getReasoningBackend } from '@agent/core/reasoning-backend';
import { logger } from '@agent/core/core';
import { pathResolver, missionEvidenceDir } from '@agent/core/path-resolver';
import { resolveMissionClassification } from '@agent/core/mission-classification';
import { resolveMissionWorkflowDesign } from '@agent/core/mission-workflow-catalog';
import { safeExec, safeExistsSync, safeReaddir } from '@agent/core/secure-io';
import { TraceContext, persistTrace } from '@agent/core/trace';
import { killSwitch } from '@agent/core/kill-switch';
import { renderStatus } from '@agent/core/ux-vocabulary';
import { buildHandoffPacket } from '@agent/core/handoff-packet';
import { recordMissionGateOverride } from '@agent/core/mission-gate-engine';
import { missionLifecycleService } from '@agent/core/mission-lifecycle-service';
import { releaseOrchestratorSessionForMissionBestEffort } from '@agent/core/orchestrator-session';
import { resumeAiDlcPhaseState } from '@agent/core/aidlc-phase-state';
import { reassignMissionToProject } from '@agent/core/project-management';
import { recordMissionHandoff } from '@agent/core/work-coordination';
import type { ArtifactReviewFinding } from '@agent/core/artifact-review';
import { createMissionWorkReconciliationApprovalRequest } from '@agent/core/mission-work-reconciliation';

type Print = (value: unknown) => void;

function registeredEnv(name: string): string | undefined {
  return getRegisteredEnv<string>(name) as string | undefined;
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
import {
  extractMissionControllerPositionalArgs,
  extractMissionStartCreateOptionsFromArgv,
  extractProjectRelationshipOptionsFromArgv,
  getOptionValue,
  parseCsvOption,
} from './refactor/mission-cli-args.js';
import { withOrganizationContext } from './refactor/organization-context.js';
import {
  listOrganizationCatalogs,
  listOrganizationProfiles,
  showOrganizationDiscovery,
  showOrganizationProfile,
} from './refactor/mission-organization-commands.js';
import {
  acceptRubricOverride,
  approveMemoryCandidate,
  listMemoryQueue,
  promoteMemoryCandidate,
  promotePendingMemoryCandidates,
  rejectMemoryCandidate,
  showMemoryReview,
} from './refactor/mission-memory-commands.js';
import {
  assertCanGrantMissionAuthority,
  writeFocusedMissionId as _writeFocusedMissionId,
  loadState,
  saveState,
  checkDependencies,
} from './refactor/mission-state.js';
import {
  dispatchNextQueuedMission,
  enqueueMission as _enqueueMission,
} from './refactor/mission-queue.js';
import { buildMissionStatusView, listMissionSummaries } from './refactor/mission-read-model.js';
import { missionSystem } from './refactor/mission-system.js';
import {
  activateMissionOnGateProgress,
  advanceCurrentPhase,
  evaluateStoredMissionGate,
  markPhaseTasksCompleted,
  markPhaseTasksForRework,
  planProcessTemplateTasks,
} from './refactor/mission-process-planning.js';
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
export { buildOrganizationDiscoveryReport } from './refactor/mission-organization-commands.js';

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
  return missionSystem.syncProjectLedger(id);
}

async function syncProjectLedgerIfLinked(id: string): Promise<unknown> {
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
  return missionSystem.sealMission(id);
}

async function distillMission(id: string): Promise<void> {
  return missionSystem.distillMission(id);
}

async function dispatchMissionTickets(id: string): Promise<void> {
  const result = await missionSystem.dispatchMissionTickets(
    id,
    resolveMissionTicketDispatchOptionsFromArgv()
  );
  printOutput(JSON.stringify(result, null, 2));
}

async function dispatchMissionWorkItems(id: string): Promise<void> {
  try {
    const result = await missionLifecycleService.dispatch(
      id,
      resolveMissionWorkItemDispatchOptionsFromArgv()
    );
    printOutput(JSON.stringify(result, null, 2));
  } finally {
    try {
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
  await _enqueueMission(QUEUE_PATH, id, tier, priority, deps);
}

async function dispatchNextMission() {
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
  options?: { ephemeral?: boolean; intentGoal?: string; force?: boolean }
) {
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
  return missionSystem.delegateMission(id, agentId, a2aMessageId);
}

async function importMission(id: string, remoteUrl: string) {
  return missionSystem.importMission(id, remoteUrl);
}

async function verifyMission(id: string, result: 'verified' | 'rejected', note: string) {
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
  const result = await missionLifecycleService.finish(id, seal);
  const finalState = loadState(id.toUpperCase());
  const archivedPath = path.join(pathResolver.active('archive/missions'), id.toUpperCase());
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

async function pauseMission(id: string, note?: string) {
  return missionLifecycleService.pause(id, note);
}

async function cancelMission(id: string, note?: string) {
  return missionSystem.cancelMission(id, note);
}

async function repairLegacyMissionState(id: string, note?: string) {
  return missionSystem.repairLegacyMissionState(id, note);
}

async function recordTask(
  missionId: string,
  description: string,
  details: Record<string, unknown> = {}
) {
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
  const result = await missionSystem.reenterMissionFromReview(missionId);
  printOutput(JSON.stringify(result, null, 2));
  return result;
}

async function purgeMissions(dryRun: boolean = false): Promise<void> {
  // AL-01: purgeMissions now returns a structured PurgeMissionsResult; the
  // CLI router's context type is (dryRun?) => Awaitable<void> and never
  // consumed a return value, so drop it here to keep the thin-router contract.
  await missionSystem.purgeMissions(dryRun);
}

async function archiveMissions(
  options: { missionId?: string; execute?: boolean } = {}
): Promise<void> {
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
function listMissions(filterStatus?: string) {
  const missions = listMissionSummaries(filterStatus);

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

function showMissionStatus(id: string, follow: boolean = false) {
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

function showReasoningBackendStatus() {
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

export function buildHelpText(): string {
  return `
Kyberion Sovereign Mission Controller (KSMC)

Usage: node dist/scripts/mission_controller.js <command> [args]

Lifecycle Commands:
  create   <ID>                  Create a new mission (status: planned)
  start    <ID>                  Activate a mission (planned/paused/failed → active)
                                 --goal <TEXT> carries the user goal into the intent baseline
                                 --success-condition <TEXT> records the acceptance condition
                                 --intent-goal <PATH> accepts an existing governed handoff file
  checkpoint [task_id] [note]    Record a checkpoint on the focused mission
  checkpoint <ID> <task_id> <note>
                                 Record a checkpoint on an explicit mission
  verify   <ID> <verified|rejected> <note>
                                 Verify a mission (active → distilling or back to active)
  distill  <ID>                  Extract knowledge via LLM (distilling → completed)
  finish   <ID> [--seal]         Archive a completed mission (optionally encrypt)
  resume   [ID]                  Resume the last active mission and replay orchestration journal (or specify ID)
  pause    <ID> [--note <TEXT>]  Pause an active mission without losing state
  cancel   <ID> [--note <TEXT>]  Cancel a mission and mark it failed for follow-up
  repair   <ID> [--note <TEXT>]  Repair legacy mission state via the governed controller
  dispatch-tickets <ID>          Register NEXT_TASKS as work items / issue payloads
                                 --ticket-targets workitem,github,jira
                                 --live-ticket-targets github,jira
                                 --github-owner <OWNER> --github-repo <REPO>
                                 --jira-domain <DOMAIN> --jira-project-key <KEY>
  dispatch-workitems <ID>        Execute registered work items via agent/subagent routing
                                 --dispatch-mode auto|agent|subagent
                                 --dispatch-execution-surface cli_subagent|agent_runtime|hybrid
                                 --dispatch-review-execution-surface cli_subagent|agent_runtime|hybrid
                                 --dispatch-statuses ready,backlog
                                 --dispatch-rounds N (auto-retry blocked items, bounded)
                                 --dispatch-sources local,github,jira
                                 --dispatch-final-status review|done
  hygiene [--notify]             List stuck planned missions with per-mission remediation
                                 --stale-days N (default 2) --abandoned-days N (default 14)

Delegation Commands:
  delegate <ID> <agent_id> <a2a_message_id>
                                 Delegate a mission to an external agent
  import   <ID> <remote_url>     Import results from a delegated mission
  seal     <ID>                  Encrypt a mission for archival (AES+RSA)

Queue Commands:
  enqueue  <ID> <tier> [priority] [deps]
                                 Add a mission to the dispatch queue
  dispatch                       Start the next queued mission
  memory-queue [status]          List memory promotion candidates
                                 Show readiness, blockers, and physical duplicate count
  memory-review <CANDIDATE_ID> [--tenant-slug <SLUG>] [--json]
                                 Show summary, target, evidence, scope, audit, and next action
  memory-approve <CANDIDATE_ID> [--tenant-slug <SLUG>] [--note <TEXT>]
                                 Approve only when review preflight is clear
  memory-reject <CANDIDATE_ID> [--tenant-slug <SLUG>] [--all-duplicates] [--note <TEXT>]
                                 Mark a memory candidate as rejected
  memory-promote <CANDIDATE_ID> [--tenant-slug <SLUG>] [--execution-role <mission_controller|chronos_gateway>] [--note <TEXT>] [--supersedes <PATH_OR_ID>]
                                 Promote an approved candidate to governed knowledge
  memory-promote-pending [--execution-role <mission_controller|chronos_gateway>] [--note <TEXT>] [--supersedes <PATH_OR_ID>] [--dry-run]
                                 Bulk promote approved memory candidates in queue order

Visibility Commands:
  list     [status]              List all missions (optionally filter by status)
  status   <ID> [--refresh-providers]
                                 Show detailed status of a specific mission and backend availability
  outbox   [ID] [--ack]          Show mission results delivered to the terminal surface (--ack to clear)
  sync-project-ledger <ID>       Upsert this mission into the related project mission-ledger
  reassign-project <ID> --project-id <PROJECT_ID> [--project-path <PATH>] [--track-id <TRACK_ID>] [--dry-run] [--force]
                                 Safely move a paused/planned mission to another project and reconcile both sides
  team     <ID> [--refresh] [--provider <ID>] [--model <ID>]
                                 Show or regenerate mission team composition
  staff    <ID> [--provider <ID>] [--model <ID>]
                                 Spawn or verify runtime instances for assigned mission team roles
  classify <ID> [intent] [task]  Classify mission context into class/delivery/risk/stage
  workflow-select <ID> [intent] [task]
                                 Resolve workflow template from mission classification
  plan-tasks <ID> [--force] [--refresh-catalog]
                                 Expand process template phases into NEXT_TASKS.json + gates (--refresh-catalog re-resolves from the current catalog)
  review-worker-output <ID> [verified|rejected] [note]
                                 Record worker-output review result via mission verification
  handoff <ID> <persona> [note]  Transfer mission persona ownership with audit history

Governance Commands:
  accept-with-override <HYPOTHESIS_OR_BRANCH_ID> --reason "<text>" [--severity warn|poor]
                                 Record a rubric override (counterfactual warn/poor accepted by operator).
                                 Emits the rubric.override_accepted audit event per
                                 counterfactual-degradation-policy.json. Required for warn-severity
                                 acceptance; forbidden for poor unless tenant_risk_officer documents
                                 the exception separately.

Maintenance Commands:
  record-task <ID> <description> Record a task intention (flight recorder)
  record-evidence <ID> <task_id> <note>
                                 Append an execution-ledger evidence entry and commit it
  review-task <ID> <review_task_id> <reviewer_agent_id> [--findings <JSON>] [--reviewer-team-role reviewer|qa] [--specialist-roles <CSV>]
                                 Record a real ArtifactReviewReceipt for a review-kind task (required before it
                                 can complete — bare record-evidence is not enough for review tasks). Independence
                                 from the implementer is computed from the execution ledger, not self-declared.
  reconcile-work <ID> --manifest <PATH> [--dry-run] [--approval-request-id <UUID>]
                                 --request-approval [--requested-by <ACTOR>] creates a hash-bound human approval request
                                 --generate [--output <PATH>] scaffolds a manifest from current git state
                                 Validate and adopt verified work completed outside dispatch-workitems
  review-reenter <ID>            Turn pending human review rejections into rework tasks and reactivate the mission
  scope-approve <ID> [--goal <TEXT>] [--reason <TEXT>]
                                 Approve a scope change and rebaseline the origin intent
  purge    [--execute]            Preview stale missions to archive (--execute to apply)
  archive  [--execute] [--mission <ID>]
                                 Governed archive verb: policy-driven sweep like purge (dry-run by
                                 default), or archive one completed/failed mission now via --mission
    sync                           Sync mission registry
  organization-catalogs [--json] [--organization-id <ORG>] [--selected-only] [--summary]
                                 List available organization team template catalogs
  organization-profiles [--json] [--organization-id <ORG>] [--active-only] [--ready-only] [--missing-only] [--source <customer|public>] [--summary]
                                 List available organization profiles
  organization-profile [--json] [--organization-id <ORG>] [--summary]
                                 Show the resolved organization profile and defaults
  organization-discovery [--json] [--summary]
                                 Show the discovery overview and common paths
                                 Guide: knowledge/product/orchestration/organization-discovery.md
                                 Examples: knowledge/product/schemas/organization-discovery-report.example.json
                                           knowledge/product/schemas/organization-profile-report.example.json
                                           knowledge/product/schemas/organization-profiles-report.example.json
                                           knowledge/product/schemas/organization-catalog-report.example.json

  Typical Workflow:
  start → checkpoint (repeat) → verify → distill → finish

Mission Input Contract:
  Positionals:
    <ID>                         Only the mission ID should be positional for create/start
  Preferred named options:
    --tier <personal|confidential|public>
    --tenant-id <TENANT>
    --tenant-slug <slug>           # multi-tenant isolation (^[a-z][a-z0-9-]{1,30}$)
    --organization-id <ORG>        # selects KYBERION_CUSTOMER for org-specific defaults
    --org <ORG>                    # alias for --organization-id
    --mission-type <TYPE>
    --vision-ref <REF>            Defaults to the active customer vision when KYBERION_CUSTOMER is set
    --persona <NAME>
    --dry-run
    --relationships <JSON>
    --relationships-file <PATH>
    --mission-id <ID>            Explicit mission target for checkpoint

Organization Selection:
  --organization-id <ORG>        Select a specific organization profile and template catalog
  --org <ORG>                    Alias for --organization-id
  --summary                      Print only the resolved organization summary (organization-profile)
  --active-only                  Filter organization-profiles to the selected organization only
  --ready-only                   Filter organization-profiles to ready profiles only
  --missing-only                 Filter organization-profiles to missing profiles only
  --source <customer|public>     Filter organization-profiles by source
  Guide: knowledge/product/orchestration/organization-selection-guide.md

Organization Discovery:
  organization-profiles --json --summary
                                 Inventory organization readiness as JSON
  organization-profile --json --summary
                                 Inspect one resolved organization profile as JSON
  organization-catalogs --json --selected-only --summary
                                 Inspect the selected team template overlay as JSON
  Reports: knowledge/product/orchestration/organization-discovery-reports.md
  Examples: knowledge/product/schemas/organization-discovery-report.example.json
            knowledge/product/schemas/organization-profile-report.example.json
            knowledge/product/schemas/organization-profiles-report.example.json
            knowledge/product/schemas/organization-catalog-report.example.json

  Validation:
    Linked project missions must point to a project_path whose 04_control ledger
    is writable under the current authority. Unsafe targets like libs/core will fail fast.

  Project Traceability Options:
  --project-id <ID>              Link mission to a project identifier
  --project-path <PATH>          Record the related project-os path
  --project-relationship <TYPE>  belongs_to | supports | governs | independent
  --affected-artifacts <CSV>     Comma-separated project artifacts impacted by the mission
  --gate-impact <TYPE>           none | informational | review_required | blocking
  --traceability-refs <CSV>      Comma-separated evidence or document refs
  --project-note <TEXT>          Free-text note for the project relationship
                                 Linked missions auto-sync to active/projects/<tier>/<tenant_or_shared>/<project_id>/state/
                                 and later distill into knowledge/product/evolution/ or knowledge/product/incidents/

Intent-to-Track Gate Options:
  --intent-id <ID>               Resolve the intent to a governed project track before create/start
  --intent-confidence <0..1>     Confidence score; below policy threshold requires confirmation
  --confirm-intent-track <REASON> Explicitly confirm low-confidence track provisioning
  --execution-shape <SHAPE>      Gate only mission/project_bootstrap shapes when specified

Track Traceability Options:
  --track-id <ID>                Link mission to a project track identifier
  --track-name <NAME>            Human-readable track name
  --track-type <TYPE>            delivery | release | change | incident | operations | governance
  --lifecycle-model <MODEL>      Track lifecycle profile (for example default-sdlc)
  --track-relationship <TYPE>    belongs_to | supports | governs | independent
  --track-traceability-refs <CSV> Comma-separated track-level refs
  --track-note <TEXT>            Free-text note for the track relationship
`;
}

function showHelp() {
  printOutput(buildHelpText());
}

function showMissionTeam(
  id: string,
  refresh = false,
  organizationId?: string,
  providerPreference?: { provider: string; modelId?: string }
) {
  return withOrganizationContext(organizationId, () =>
    missionSystem.showMissionTeam(id, refresh, providerPreference)
  );
}

async function staffMissionTeam(
  id: string,
  organizationId?: string,
  providerPreference?: { provider: string; modelId?: string }
) {
  return withOrganizationContext(organizationId, () =>
    missionLifecycleService.staff(id, { providerPreference })
  );
}

async function prewarmMissionTeam(id: string, teamRolesArg?: string, organizationId?: string) {
  return withOrganizationContext(organizationId, () =>
    missionLifecycleService.prewarm(id, teamRolesArg)
  );
}

async function classifyMission(id: string, intentId?: string, taskType?: string): Promise<void> {
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
  }
): Promise<void> {
  assertCanGrantMissionAuthority();
  return missionSystem.approveScopeChange(missionId, options);
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
    process.env.MISSION_ID = earlyPositionalArgs[1].toUpperCase();
  }

  // Self-identify as mission_controller role for tier-guard resolution.
  if (!process.env.MISSION_ROLE) {
    process.env.MISSION_ROLE = 'mission_controller';
  }
  // Register reasoning backends so dispatch-workitems delegation reaches a
  // real backend (claude-cli/anthropic) instead of silently using the stub.
  installReasoningBackends();
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
    acceptRubricOverride,
    listMemoryQueue,
    showMemoryReview,
    approveMemoryCandidate,
    rejectMemoryCandidate,
    promoteMemoryCandidate,
    promotePendingMemoryCandidates,
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
    listOrganizationCatalogs: (organizationId, jsonOutput, output) =>
      listOrganizationCatalogs(organizationId, jsonOutput, args, output),
    listOrganizationProfiles: (organizationId, output) =>
      listOrganizationProfiles(organizationId, args, ROOT_DIR, output),
    showOrganizationProfile: (organizationId, summaryOnly, jsonOutput, output) =>
      showOrganizationProfile(organizationId, summaryOnly, jsonOutput, output),
    showOrganizationDiscovery: (jsonOutput, summaryOnly, output) =>
      showOrganizationDiscovery(jsonOutput, summaryOnly, output),
    showMissionStatus,
    showReasoningBackendStatus,
    syncProjectLedger,
    reassignMissionProject,
    showMissionTeam,
    staffMissionTeam,
    prewarmMissionTeam,
    classifyMission,
    selectMissionWorkflow,
    planProcessTemplateTasks,
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
