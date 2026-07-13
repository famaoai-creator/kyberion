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
import {
  auditChain,
  discoverProviders,
  getInstalledReasoningMode,
  installReasoningBackends,
  customerResolver,
  listMemoryPromotionCandidates,
  listOrganizationMissionTeamTemplateCatalogSummariesForOrganization,
  loadProjectRecord,
  loadProjectTrackRecord,
  loadOrganizationProfile,
  logger,
  pathResolver,
  promoteMemoryCandidateToKnowledge,
  promotePersonalMemoryCandidates,
  resolveMissionClassification,
  resolveMissionWorkflowDesign,
  resolveOrganizationMissionTeamTemplateCatalogId,
  updateMemoryPromotionCandidateStatus,
  safeExec,
  safeReadFile,
  safeWriteFile,
  safeExistsSync,
  safeLstat,
  TraceContext,
  persistTrace,
  safeReaddir,
  findMissionPath,
  missionEvidenceDir,
  validateWritePermission,
  killSwitch,
  renderStatus,
  buildHandoffPacket,
  recordMissionGateOverride,
} from '@agent/core';

// --- Sub-module imports ---
import {
  type ResolvedMissionCliInput,
  resolveMissionStartCreateInputFromArgv,
  resolveMissionTicketDispatchOptionsFromArgv,
  resolveMissionWorkItemDispatchOptionsFromArgv,
  validateMissionStartCreateInput,
} from './refactor/mission-controller-args.js';
import { type MissionRelationships } from './refactor/mission-types.js';
import {
  extractMissionControllerPositionalArgs,
  extractMissionStartCreateOptionsFromArgv,
  extractProjectRelationshipOptionsFromArgv,
  getOptionValue,
  parseCsvOption,
} from './refactor/mission-cli-args.js';
import { withOrganizationContext } from './refactor/organization-context.js';
import {
  assertCanGrantMissionAuthority,
  normalizeRelationships,
  readFocusedMissionId as _readFocusedMissionId,
  writeFocusedMissionId as _writeFocusedMissionId,
  loadState,
  saveState,
  checkDependencies,
} from './refactor/mission-state.js';
import {
  resolveProjectLedgerJsonPath,
  resolveProjectLedgerPath,
} from './refactor/mission-project-ledger.js';
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
import { runMissionControllerAction } from './refactor/mission-controller-router.js';

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
function readFocusedMissionId(): string | null {
  return _readFocusedMissionId(MISSION_FOCUS_PATH);
}

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
  console.log(JSON.stringify(result, null, 2));
}

async function dispatchMissionWorkItems(id: string): Promise<void> {
  const result = await missionSystem.dispatchMissionWorkItems(
    id,
    resolveMissionWorkItemDispatchOptionsFromArgv()
  );
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Mission Commands
 */

async function enqueueMission(id: string, tier: string, priority: number = 5, deps: string[] = []) {
  await _enqueueMission(QUEUE_PATH, id, tier, priority, deps);
}

async function dispatchNextMission() {
  await dispatchNextQueuedMission(QUEUE_PATH, checkDependencies, async (missionId, tier) =>
    startMission(missionId, tier as any)
  );
}

function listMemoryQueue(filterStatus?: 'queued' | 'approved' | 'rejected' | 'promoted') {
  const rows = listMemoryPromotionCandidates()
    .filter((row) => (filterStatus ? row.status === filterStatus : true))
    .sort((a, b) => b.queued_at.localeCompare(a.queued_at));
  if (rows.length === 0) {
    logger.info(
      filterStatus
        ? `No memory promotion candidates with status "${filterStatus}".`
        : 'No memory promotion candidates in queue.'
    );
    return;
  }
  const header = `${'CANDIDATE_ID'.padEnd(30)} ${'STATUS'.padEnd(10)} ${'KIND'.padEnd(20)} ${'TIER'.padEnd(13)} SOURCE`;
  console.log('');
  console.log(header);
  console.log('-'.repeat(header.length + 6));
  for (const row of rows) {
    console.log(
      `${row.candidate_id.padEnd(30)} ${row.status.padEnd(10)} ${row.proposed_memory_kind.padEnd(20)} ${row.sensitivity_tier.padEnd(13)} ${row.source_ref}`
    );
  }
  console.log('');
}

function approveMemoryCandidate(candidateId: string, note?: string) {
  if (!candidateId) {
    logger.error('Usage: mission_controller memory-approve <CANDIDATE_ID> [--note <TEXT>]');
    return;
  }
  const updated = updateMemoryPromotionCandidateStatus({
    candidateId,
    status: 'approved',
    ratificationNote: note || 'Approved for promotion.',
  });
  if (!updated) {
    logger.error(`Memory promotion candidate not found: ${candidateId}`);
    return;
  }
  logger.success(`✅ Memory candidate approved: ${updated.candidate_id}`);
}

/**
 * Record an explicit operator override of a counterfactual rubric warn/poor
 * (IP-9). Does not mutate the simulation output — only emits a tamper-
 * evident audit event so reviewers can see who accepted the un-rubric'd
 * branch and why. Required by counterfactual-degradation-policy.json
 * for `warn` severity; forbidden for `poor` unless tenant_risk_officer
 * documents it separately.
 */
function acceptRubricOverride(hypothesisOrBranchId: string, reason?: string, severity?: string) {
  if (!hypothesisOrBranchId) {
    logger.error(
      'Usage: mission_controller accept-with-override <HYPOTHESIS_OR_BRANCH_ID> --reason "<text>" [--severity warn|poor]'
    );
    return;
  }
  if (!reason) {
    logger.error(
      'accept-with-override requires --reason "<text>" — overrides without reasoning are not auditable.'
    );
    process.exitCode = 1;
    return;
  }
  const sev = (severity || 'warn').toLowerCase();
  if (!['warn', 'poor'].includes(sev)) {
    logger.error('--severity must be warn or poor');
    process.exitCode = 1;
    return;
  }
  if (sev === 'poor') {
    logger.warn(
      "Override of 'poor' severity is not permitted by default per " +
        'counterfactual-degradation-policy.json; only proceed if tenant_risk_officer ' +
        'has documented the exception.'
    );
  }
  const missionId = process.env.MISSION_ID || getOptionValue('--mission-id') || '';
  const entry = auditChain.record({
    agentId: process.env.KYBERION_PERSONA || 'mission_controller',
    action: 'rubric.override_accepted',
    operation: `accept-with-override:${hypothesisOrBranchId}`,
    result: 'allowed',
    reason,
    metadata: {
      hypothesis_or_branch_id: hypothesisOrBranchId,
      severity: sev,
      mission_id: missionId || undefined,
      policy_ref: 'knowledge/product/governance/counterfactual-degradation-policy.json',
    },
    compliance: {
      framework: 'counterfactual-degradation-policy.json',
      control: `severity-${sev}-override`,
    },
  });
  logger.success(
    `✅ rubric.override_accepted recorded: ${entry.id} (severity=${sev}, branch=${hypothesisOrBranchId})`
  );
}

function rejectMemoryCandidate(candidateId: string, note?: string) {
  if (!candidateId) {
    logger.error('Usage: mission_controller memory-reject <CANDIDATE_ID> [--note <TEXT>]');
    return;
  }
  const updated = updateMemoryPromotionCandidateStatus({
    candidateId,
    status: 'rejected',
    ratificationNote: note || 'Rejected by operator review.',
  });
  if (!updated) {
    logger.error(`Memory promotion candidate not found: ${candidateId}`);
    return;
  }
  logger.success(`✅ Memory candidate rejected: ${updated.candidate_id}`);
}

async function promoteMemoryCandidate(
  candidateId: string,
  executionRole: 'mission_controller' | 'chronos_gateway' = 'mission_controller',
  note?: string,
  supersedes?: string
) {
  if (!candidateId) {
    logger.error(
      'Usage: mission_controller memory-promote <CANDIDATE_ID> [--execution-role <mission_controller|chronos_gateway>] [--note <TEXT>] [--supersedes <PATH_OR_ID>]'
    );
    return;
  }
  const result = await promoteMemoryCandidateToKnowledge({
    candidateId,
    executionRole,
    ratificationNote: note,
    supersedes,
  });
  logger.success(
    `✅ Memory candidate promoted: ${result.candidate.candidate_id} -> ${result.promotedRef}`
  );
}

async function promotePendingMemoryCandidates(input: {
  executionRole?: 'mission_controller' | 'chronos_gateway';
  dryRun?: boolean;
  note?: string;
  supersedes?: string;
}) {
  const executionRole = input.executionRole || 'mission_controller';
  const pending = listMemoryPromotionCandidates()
    .filter((row) => row.status === 'approved')
    .sort((a, b) => a.queued_at.localeCompare(b.queued_at));

  if (pending.length === 0) {
    logger.info('No approved memory candidates to promote.');
  }

  let promoted = 0;
  let failed = 0;
  if (input.dryRun && pending.length > 0) {
    logger.info(`Dry run: ${pending.length} approved memory candidate(s) would be promoted.`);
    for (const row of pending) {
      console.log(
        `- ${row.candidate_id} (${row.proposed_memory_kind}, ${row.sensitivity_tier}) ${row.source_ref}`
      );
    }
  } else {
    for (const row of pending) {
      try {
        const result = await promoteMemoryCandidateToKnowledge({
          candidateId: row.candidate_id,
          executionRole,
          ratificationNote: input.note,
          supersedes: input.supersedes,
        });
        promoted += 1;
        logger.info(`🟢 promoted ${result.candidate.candidate_id} -> ${result.promotedRef}`);
      } catch (err: any) {
        failed += 1;
        logger.warn(`⚠️ failed to promote ${row.candidate_id}: ${err?.message || err}`);
      }
    }
  }
  const autopromote = await promotePersonalMemoryCandidates({
    executionRole,
    ratificationNote: input.note,
    dryRun: input.dryRun,
  });
  if (autopromote.enabled) {
    logger.info(
      `🟣 personal autopromote: considered=${autopromote.considered}, promoted=${autopromote.promoted.length}, skipped=${autopromote.skipped.length}`
    );
  }
  logger.success(`✅ Memory bulk promotion finished. promoted=${promoted}, failed=${failed}`);
}

async function createMission(
  id: string,
  tier: 'personal' | 'confidential' | 'public' = 'confidential',
  tenantId: string = 'default',
  missionType: string = 'development',
  visionRef?: string,
  persona: string = 'worker',
  relationships: any = {},
  tenantSlug?: string,
  organizationId?: string
) {
  return withOrganizationContext(organizationId, () =>
    missionSystem.create(
      id,
      tier,
      tenantId,
      missionType,
      visionRef,
      persona,
      relationships,
      tenantSlug
    )
  );
}

function parseRoutingDecision(raw?: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return { raw };
  }
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
    ts: new Date().toISOString(),
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
  relationships: any = {},
  tenantSlug?: string,
  organizationId?: string
) {
  await withOrganizationContext(organizationId, () =>
    missionSystem.start(
      id,
      tier,
      persona,
      tenantId,
      missionType,
      visionRef,
      relationships,
      tenantSlug
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
  const output = await missionSystem.verifyMission(id, result, note);
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
  const result = await missionSystem.finishMission(id, seal);
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
  const result = await missionSystem.createCheckpoint(taskId, note, explicitMissionId);
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
  return missionSystem.resumeMission(id);
}

async function pauseMission(id: string, note?: string) {
  return missionSystem.pauseMission(id, note);
}

async function cancelMission(id: string, note?: string) {
  return missionSystem.cancelMission(id, note);
}

async function recordTask(missionId: string, description: string, details: any = {}) {
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

async function reconcileExistingWork(missionId: string, manifestPath: string, dryRun = false) {
  const result = await missionSystem.reconcileExistingWork(missionId, manifestPath, dryRun);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function reenterMissionFromReview(missionId: string) {
  const result = await missionSystem.reenterMissionFromReview(missionId);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function purgeMissions(dryRun: boolean = false) {
  return missionSystem.purgeMissions(dryRun);
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
  console.log('');
  console.log(header);
  console.log('-'.repeat(header.length + 10));
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
    console.log(
      `${missionId.padEnd(30)} ${statusIcon} ${status.padEnd(10)} ${tier.padEnd(14)} ${String(m.checkpoints).padStart(3)} ${lastEvent}`
    );
  }
  console.log('');
  logger.info(`${missions.length} mission(s) found.`);
}

function listOrganizationCatalogs(organizationId?: string, jsonOutput = false) {
  return withOrganizationContext(organizationId, () => {
    const summaryOnly = process.argv.includes('--summary') || process.argv.includes('--compact');
    const selectedOnly = process.argv.includes('--selected-only');
    const organizationProfile = loadOrganizationProfile();
    const catalogs =
      listOrganizationMissionTeamTemplateCatalogSummariesForOrganization(organizationProfile);
    const selectedCatalogId =
      resolveOrganizationMissionTeamTemplateCatalogId(organizationProfile) || 'default';
    const requestedLabel = organizationId?.trim() || 'default';
    const organizationLabel = organizationProfile
      ? `${organizationProfile.name} (${organizationProfile.organization_id})`
      : 'default';
    const filteredCatalogs = selectedOnly
      ? catalogs.filter((catalog) => catalog.selected)
      : catalogs;
    const summary = {
      total_count: filteredCatalogs.length,
      selected_count: filteredCatalogs.filter((catalog) => catalog.selected).length,
      template_count: filteredCatalogs.reduce((acc, catalog) => acc + catalog.template_count, 0),
      required_role_count: filteredCatalogs.reduce(
        (acc, catalog) => acc + catalog.required_role_count,
        0
      ),
      optional_role_count: filteredCatalogs.reduce(
        (acc, catalog) => acc + catalog.optional_role_count,
        0
      ),
    };

    if (jsonOutput) {
      const payload = {
        requested: requestedLabel,
        resolved: organizationLabel,
        selected_catalog: selectedCatalogId,
        selected_only: selectedOnly,
        summary,
        catalogs: filteredCatalogs.map((catalog) => ({
          catalog_id: catalog.catalog_id,
          organization_id: catalog.organization_id,
          selected: catalog.selected,
          template_ids: catalog.template_ids,
          template_count: catalog.template_count,
          required_role_count: catalog.required_role_count,
          optional_role_count: catalog.optional_role_count,
        })),
      };
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    if (filteredCatalogs.length === 0) {
      logger.info('No organization team template catalogs found.');
      return;
    }

    logger.info(
      `[organization] requested=${requestedLabel} resolved=${organizationLabel} selected=${selectedCatalogId || 'default'}`
    );
    if (selectedOnly) {
      logger.info('[organization] filters=selected-only');
    }
    logger.info(
      `[organization] summary total=${summary.total_count} selected=${summary.selected_count} templates=${summary.template_count} required_roles=${summary.required_role_count} optional_roles=${summary.optional_role_count}`
    );
    if (summaryOnly) {
      return;
    }

    const header = `${'SEL'.padEnd(4)} ${'CATALOG'.padEnd(20)} ${'ORG'.padEnd(14)} ${'TEMPLATES'.padEnd(10)} ${'REQ'.padStart(4)} ${'OPT'.padStart(4)} TEMPLATE IDS`;
    console.log('');
    console.log(header);
    console.log('-'.repeat(header.length + 6));
    for (const catalog of filteredCatalogs) {
      const templateIds = catalog.template_ids.length ? catalog.template_ids.join(', ') : '-';
      const marker = catalog.selected ? '*' : ' ';
      console.log(
        `${marker.padEnd(4)} ${catalog.catalog_id.padEnd(20)} ${catalog.organization_id.padEnd(14)} ${String(catalog.template_count).padEnd(10)} ${String(catalog.required_role_count).padStart(4)} ${String(catalog.optional_role_count).padStart(4)} ${templateIds}`
      );
    }
    console.log('');
    logger.info(`${filteredCatalogs.length} organization team template catalog(s) found.`);
  });
}

function listOrganizationProfiles(organizationId?: string) {
  const jsonOutput = process.argv.includes('--json');
  const summaryOnly = process.argv.includes('--summary') || process.argv.includes('--compact');
  const activeOnly = process.argv.includes('--active-only');
  const readyOnly = process.argv.includes('--ready-only');
  const missingOnly = process.argv.includes('--missing-only');
  const sourceFilter = getOptionValue('--source')?.trim();
  const customerRoot = path.join(ROOT_DIR, 'customer');
  const activeCustomer = customerResolver.activeCustomer();
  const requestedLabel = organizationId?.trim() || activeCustomer || 'default';
  const resolvedOrganizationProfile = organizationId
    ? withOrganizationContext(organizationId, () => loadOrganizationProfile())
    : null;
  const selectedOrganizationId =
    resolvedOrganizationProfile?.organization_id || organizationId || activeCustomer || 'default';
  const rows: Array<{
    slug: string;
    active: boolean;
    ready: boolean;
    profile: ReturnType<typeof loadOrganizationProfile> | null;
    source: 'customer' | 'public';
  }> = [];

  const publicProfile = loadOrganizationProfile();
  const publicProfileLabel = publicProfile
    ? `${publicProfile.name} (${publicProfile.organization_id})`
    : 'default';
  rows.push({
    slug: publicProfile?.organization_id || 'default',
    active: selectedOrganizationId === (publicProfile?.organization_id || 'default'),
    ready: Boolean(publicProfile),
    profile: publicProfile,
    source: 'public',
  });

  if (safeExistsSync(customerRoot) && safeLstat(customerRoot).isDirectory()) {
    for (const entry of safeReaddir(customerRoot).sort()) {
      if (entry === 'README.md' || entry === '_template') continue;
      const full = path.join(customerRoot, entry);
      if (!safeLstat(full).isDirectory()) continue;
      const profilePath = path.join(full, 'organization-profile.json');
      const profile = safeExistsSync(profilePath)
        ? withOrganizationContext(entry, () => loadOrganizationProfile())
        : null;
      rows.push({
        slug: entry,
        active: entry === selectedOrganizationId,
        ready: Boolean(profile),
        profile,
        source: 'customer',
      });
    }
  }

  rows.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'public' ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });

  const filteredRows = rows.filter((row) => {
    if (activeOnly && !row.active) return false;
    if (readyOnly && !row.ready) return false;
    if (missingOnly && row.ready) return false;
    if (sourceFilter && row.source !== sourceFilter) return false;
    return true;
  });

  if (filteredRows.length === 0) {
    logger.info('No organization profiles found.');
    return;
  }

  const summary = {
    total_count: filteredRows.length,
    ready_count: filteredRows.filter((row) => row.ready).length,
    missing_count: filteredRows.filter((row) => !row.ready).length,
    customer_count: filteredRows.filter((row) => row.source === 'customer').length,
    public_count: filteredRows.filter((row) => row.source === 'public').length,
    active_count: filteredRows.filter((row) => row.active).length,
  };

  const jsonRows = filteredRows.map((row) => ({
    slug: row.slug,
    source: row.source,
    active: row.active,
    ready: row.ready,
    organization_id: row.profile?.organization_id || row.slug,
    name: row.profile?.name || row.slug,
    mission_default_template:
      row.profile?.mission_defaults?.default_team_template ||
      row.profile?.team_defaults?.default_team_template ||
      'default',
    team_default_template:
      row.profile?.team_defaults?.default_team_template ||
      row.profile?.mission_defaults?.default_team_template ||
      'default',
    team_template_catalog_id: row.profile?.team_defaults?.team_template_catalog_id || 'default',
    llm_default: row.profile?.llm?.default_profile || 'default',
    operating_principles_count: row.profile?.operating_principles?.length || 0,
  }));

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          requested: requestedLabel,
          resolved: resolvedOrganizationProfile
            ? `${resolvedOrganizationProfile.name} (${resolvedOrganizationProfile.organization_id})`
            : publicProfileLabel,
          selected_organization_id: selectedOrganizationId,
          active_only: activeOnly,
          ready_only: readyOnly,
          missing_only: missingOnly,
          source_filter: sourceFilter || null,
          summary,
          profiles: jsonRows,
        },
        null,
        2
      )
    );
    return;
  }

  logger.info(`[organization] requested=${requestedLabel} selected=${selectedOrganizationId}`);
  if (activeOnly || readyOnly || missingOnly || sourceFilter) {
    logger.info(
      `[organization] filters=${[
        activeOnly ? 'active-only' : null,
        readyOnly ? 'ready-only' : null,
        missingOnly ? 'missing-only' : null,
        sourceFilter ? `source=${sourceFilter}` : null,
      ]
        .filter(Boolean)
        .join(', ')}`
    );
  }
  logger.info(
    `[organization] summary total=${summary.total_count} ready=${summary.ready_count} missing=${summary.missing_count} customer=${summary.customer_count} public=${summary.public_count} active=${summary.active_count}`
  );
  if (summaryOnly) {
    return;
  }
  const header = `${'SEL'.padEnd(4)} ${'SOURCE'.padEnd(10)} ${'ORG'.padEnd(14)} ${'TEAM'.padEnd(14)} ${'CATALOG'.padEnd(12)} ${'LLM'.padEnd(10)} STATUS`;
  console.log('');
  console.log(header);
  console.log('-'.repeat(header.length + 6));
  for (const row of jsonRows) {
    const status = row.ready ? 'ready' : 'missing profile';
    const marker = row.active ? '*' : ' ';
    console.log(
      `${marker.padEnd(4)} ${row.source.padEnd(10)} ${`${row.name} (${row.organization_id})`.padEnd(14)} ${row.team_default_template.padEnd(14)} ${row.team_template_catalog_id.padEnd(12)} ${row.llm_default.padEnd(10)} ${status}`
    );
  }
  console.log('');
  logger.info(`${jsonRows.length} organization profile(s) found.`);
}

function showOrganizationProfile(organizationId?: string, summaryOnly = false, jsonOutput = false) {
  return withOrganizationContext(organizationId, () => {
    const requestedLabel = organizationId?.trim() || 'default';
    const organizationProfile = loadOrganizationProfile();
    if (!organizationProfile) {
      const payload = {
        requested: requestedLabel,
        resolved: 'default',
        selected_catalog: 'default',
        template_catalogs: 0,
        selected_catalog_templates: [] as string[],
        profile: null,
      };
      if (jsonOutput) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      logger.info(`[organization] requested=${requestedLabel} resolved=default selected=default`);
      console.log(
        JSON.stringify(
          { organization_id: 'default', selected_catalog: 'default', profile: null },
          null,
          2
        )
      );
      return;
    }

    const selectedCatalogId =
      resolveOrganizationMissionTeamTemplateCatalogId(organizationProfile) || 'default';
    const catalogs =
      listOrganizationMissionTeamTemplateCatalogSummariesForOrganization(organizationProfile);
    const selectedCatalog = catalogs.find((catalog) => catalog.catalog_id === selectedCatalogId);
    const payload = {
      requested: requestedLabel,
      resolved: `${organizationProfile.name} (${organizationProfile.organization_id})`,
      selected_catalog: selectedCatalogId,
      mission_default_template:
        organizationProfile.mission_defaults?.default_team_template || 'default',
      agent_profile: organizationProfile.mission_defaults?.default_agent_profile || 'default',
      team_default_template: organizationProfile.team_defaults?.default_team_template || 'default',
      lifecycle: organizationProfile.team_defaults?.default_lifecycle_template || 'default',
      max_parallel_missions: organizationProfile.team_defaults?.max_parallel_missions ?? null,
      llm_default: organizationProfile.llm?.default_profile || 'default',
      template_catalogs: catalogs.length,
      selected_catalog_templates: selectedCatalog?.template_ids || [],
      operating_principles: organizationProfile.operating_principles || [],
      profile: organizationProfile,
    };
    if (jsonOutput) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    logger.info(
      `[organization] requested=${requestedLabel} resolved=${organizationProfile.name} (${organizationProfile.organization_id}) selected=${selectedCatalogId}`
    );
    logger.info(
      `[organization] mission_default_template=${payload.mission_default_template} ` +
        `agent_profile=${payload.agent_profile} ` +
        `catalog=${selectedCatalogId} llm_default=${payload.llm_default}`
    );
    logger.info(
      `[organization] team_default_template=${payload.team_default_template} ` +
        `lifecycle=${payload.lifecycle} ` +
        `max_parallel_missions=${payload.max_parallel_missions ?? 'n/a'}`
    );
    logger.info(
      `[organization] template_catalogs=${payload.template_catalogs} ` +
        `selected_catalog=${selectedCatalogId}`
    );
    logger.info(
      `[organization] selected_catalog_templates=${payload.selected_catalog_templates.length ? payload.selected_catalog_templates.join(', ') : '-'}`
    );
    if (payload.operating_principles.length) {
      logger.info(`[organization] operating_principles=${payload.operating_principles.length}`);
    }
    if (summaryOnly) {
      return;
    }
    console.log(
      JSON.stringify(
        {
          organization_id: organizationProfile.organization_id,
          selected_catalog: selectedCatalogId,
          profile: organizationProfile,
        },
        null,
        2
      )
    );
  });
}

export function buildOrganizationDiscoveryReport() {
  const documents = [
    {
      name: 'Organization Selection Guide',
      path: 'knowledge/product/orchestration/organization-selection-guide.md',
      purpose: 'Select or switch the active organization context',
      text_command:
        'node dist/scripts/mission_controller.js organization-profile --organization-id <ORG> --summary',
      json_command:
        'node dist/scripts/mission_controller.js organization-profile --organization-id <ORG> --json --summary',
    },
    {
      name: 'Organization Discovery Reports',
      path: 'knowledge/product/orchestration/organization-discovery-reports.md',
      purpose: 'Inspect inventory, readiness, and template overlays',
      text_command: 'node dist/scripts/mission_controller.js organization-profiles --summary',
      json_command:
        'node dist/scripts/mission_controller.js organization-profiles --json --summary',
    },
    {
      name: 'Organization Discovery Copy/Paste',
      path: 'knowledge/product/orchestration/README.md',
      purpose: 'Copy the most common organization discovery commands',
      text_command:
        'node dist/scripts/mission_controller.js organization-catalogs --selected-only --summary',
      json_command:
        'node dist/scripts/mission_controller.js organization-catalogs --json --selected-only --summary',
    },
  ];

  const examples = [
    {
      name: 'Organization Discovery Example',
      path: 'knowledge/product/schemas/organization-discovery-report.example.json',
      schema: 'knowledge/product/schemas/organization-discovery-report.schema.json',
      purpose: 'Validate the discovery overview contract and operator entrypoints',
    },
    {
      name: 'Organization Profile Example',
      path: 'knowledge/product/schemas/organization-profile-report.example.json',
      schema: 'knowledge/product/schemas/organization-profile-report.schema.json',
      purpose: 'Validate the resolved organization profile contract',
    },
    {
      name: 'Organization Profiles Example',
      path: 'knowledge/product/schemas/organization-profiles-report.example.json',
      schema: 'knowledge/product/schemas/organization-profiles-report.schema.json',
      purpose: 'Validate the organization roster and readiness inventory contract',
    },
    {
      name: 'Organization Catalog Example',
      path: 'knowledge/product/schemas/organization-catalog-report.example.json',
      schema: 'knowledge/product/schemas/organization-catalog-report.schema.json',
      purpose: 'Validate the selected template overlay contract',
    },
  ];

  const commonQuestions = [
    {
      question: 'What organization is selected right now?',
      command: 'node dist/scripts/mission_controller.js organization-profile --summary',
    },
    {
      question: 'Which customer orgs are missing a profile?',
      command:
        'node dist/scripts/mission_controller.js organization-profiles --missing-only --summary',
    },
    {
      question: 'Which team template overlays are active for this org?',
      command:
        'node dist/scripts/mission_controller.js organization-catalogs --selected-only --summary',
    },
    {
      question: 'Which organization profiles are ready to use?',
      command:
        'node dist/scripts/mission_controller.js organization-profiles --ready-only --summary',
    },
  ];

  return {
    title: 'Organization Discovery',
    summary:
      'Operator entrypoint for organization selection, inventory, and template overlay inspection.',
    documents,
    examples,
    common_questions: commonQuestions,
  };
}

function showOrganizationDiscovery(jsonOutput = false, summaryOnly = false) {
  const report = buildOrganizationDiscoveryReport();

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  logger.info('Organization Discovery');
  logger.info(
    'Use these entry points to switch organization context, inspect inventory, or copy commands.'
  );
  console.log('');
  for (const doc of report.documents) {
    console.log(`${doc.name}`);
    console.log(`  path: ${doc.path}`);
    console.log(`  purpose: ${doc.purpose}`);
    console.log(`  text: ${doc.text_command}`);
    console.log(`  json: ${doc.json_command}`);
    console.log('');
  }
  console.log('Canonical examples:');
  for (const example of report.examples) {
    console.log(`  - ${example.name}`);
    console.log(`    path: ${example.path}`);
    console.log(`    schema: ${example.schema}`);
    console.log(`    purpose: ${example.purpose}`);
  }
  console.log('');
  if (summaryOnly) {
    return;
  }
  console.log('Common questions:');
  for (const item of report.common_questions) {
    console.log(`  - ${item.question}`);
    console.log(`    ${item.command}`);
  }
  console.log('');
}

function showMissionStatus(id: string, follow: boolean = false) {
  if (!id) {
    logger.error('Usage: mission_controller status <MISSION_ID>');
    return;
  }
  const view = buildMissionStatusView(id);
  if (!view) {
    logger.error(`Mission ${id.toUpperCase()} not found. Run "list" to see available missions.`);
    return;
  }
  const { state, missionPath, nextAction, recentHistory } = view;

  console.log('');
  console.log(`  Mission:     ${state.mission_id}`);
  console.log(`  Status:      ${renderStatus('mission', state.status, 'en')}`);
  console.log(`  Tier:        ${state.tier}`);
  console.log(`  Persona:     ${state.assigned_persona}`);
  console.log(`  Confidence:  ${state.confidence_score}`);
  console.log(`  Priority:    ${state.priority}`);
  console.log(`  Mode:        ${state.execution_mode}`);
  if (state.classification) {
    console.log(
      `  Class:       ${state.classification.mission_class} (risk: ${state.classification.risk_profile}, shape: ${state.classification.delivery_shape})`
    );
  }
  if (state.process_template) {
    console.log(
      `  Process:     ${state.process_template.workflow_id} — ${state.process_template.phases.join(' → ')}`
    );
  }
  console.log(`  Branch:      ${state.git.branch}`);
  console.log(`  Commit:      ${state.git.latest_commit.slice(0, 8)}`);
  console.log(`  Checkpoints: ${state.git.checkpoints.length}`);
  if (missionPath) {
    console.log(`  Directory:   ${path.relative(ROOT_DIR, missionPath)}`);
  }

  if (state.delegation) {
    console.log(
      `  Delegated:   ${state.delegation.agent_id} (${state.delegation.verification_status})`
    );
  }

  if (state.relationships?.prerequisites?.length) {
    console.log(`  Prereqs:     ${state.relationships.prerequisites.join(', ')}`);
  }
  if (state.relationships?.project) {
    console.log(`  Project:     ${state.relationships.project.project_id || '-'}`);
    console.log(`  Relation:    ${state.relationships.project.relationship_type}`);
    console.log(`  Gate Impact: ${state.relationships.project.gate_impact || 'none'}`);
  }
  if (state.relationships?.track) {
    console.log(`  Track:       ${state.relationships.track.track_id || '-'}`);
    if (state.relationships.track.track_name) {
      console.log(`  Track Name:  ${state.relationships.track.track_name}`);
    }
    console.log(`  Track Rel:   ${state.relationships.track.relationship_type}`);
  }
  if (state.context?.routing_decision_summary) {
    console.log(`  Routing:     ${state.context.routing_decision_summary}`);
  }

  console.log(`  Next:        ${nextAction}`);

  // Recent history (last 5)
  console.log('');
  console.log('  Recent History:');
  for (const h of recentHistory) {
    console.log(`    ${h.ts.slice(0, 16)}  [${h.event}]  ${h.note}`);
  }
  console.log('');

  if (follow) {
    console.log(
      `  [SYS] Following mission ledger for ${id.toUpperCase()}... (Press Ctrl-C to exit)\n`
    );
    let lastHistoryLength = view.state.history.length;
    setInterval(() => {
      const current = buildMissionStatusView(id);
      if (current && current.state.history.length > lastHistoryLength) {
        const newEvents = current.state.history.slice(lastHistoryLength);
        for (const h of newEvents) {
          console.log(`    ${h.ts.slice(0, 16)}  [${h.event}]  ${h.note}`);
        }
        lastHistoryLength = current.state.history.length;
      }
    }, 2000);
  }
}

function showReasoningBackendStatus() {
  const selectedMode = getInstalledReasoningMode();
  const forceRefresh =
    process.argv.includes('--refresh-providers') ||
    process.env.KYBERION_PROVIDER_DISCOVERY_REFRESH === '1';
  const providers = discoverProviders(forceRefresh).filter((provider) =>
    ['claude', 'gemini', 'codex'].includes(provider.provider)
  );

  console.log('');
  console.log('  Reasoning Backend:');
  console.log(`    Selected: ${selectedMode || process.env.KYBERION_REASONING_BACKEND || 'auto'}`);
  console.log(
    `    Wisdom profile: ${process.env.KYBERION_WISDOM_LLM_PROFILE || 'distill policy default'}`
  );
  for (const provider of providers) {
    const state = provider.installed
      ? provider.healthy
        ? 'ready'
        : 'installed-unhealthy'
      : 'missing';
    const version = provider.version || 'n/a';
    console.log(`    ${provider.provider.padEnd(6)} ${state.padEnd(18)} ${version}`);
  }
  console.log('');
}

export function buildHelpText(): string {
  return `
Kyberion Sovereign Mission Controller (KSMC)

Usage: node dist/scripts/mission_controller.js <command> [args]

Lifecycle Commands:
  create   <ID>                  Create a new mission (status: planned)
  start    <ID>                  Activate a mission (planned/paused/failed → active)
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
  dispatch-tickets <ID>          Register NEXT_TASKS as work items / issue payloads
                                 --ticket-targets workitem,github,jira
                                 --live-ticket-targets github,jira
                                 --github-owner <OWNER> --github-repo <REPO>
                                 --jira-domain <DOMAIN> --jira-project-key <KEY>
  dispatch-workitems <ID>        Execute registered work items via agent/subagent routing
                                 --dispatch-mode auto|agent|subagent
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
  memory-approve <CANDIDATE_ID> [--note <TEXT>]
                                 Mark a memory candidate as approved
  memory-reject <CANDIDATE_ID> [--note <TEXT>]
                                 Mark a memory candidate as rejected
  memory-promote <CANDIDATE_ID> [--execution-role <mission_controller|chronos_gateway>] [--note <TEXT>] [--supersedes <PATH_OR_ID>]
                                 Promote an approved candidate to governed knowledge
  memory-promote-pending [--execution-role <mission_controller|chronos_gateway>] [--note <TEXT>] [--supersedes <PATH_OR_ID>] [--dry-run]
                                 Bulk promote approved memory candidates in queue order

Visibility Commands:
  list     [status]              List all missions (optionally filter by status)
  status   <ID> [--refresh-providers]
                                 Show detailed status of a specific mission and backend availability
  sync-project-ledger <ID>       Upsert this mission into the related project mission-ledger
  team     <ID> [--refresh]      Show or regenerate mission team composition
  staff    <ID>                  Spawn or verify runtime instances for assigned mission team roles
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
  reconcile-work <ID> --manifest <PATH> [--dry-run]
                                 Validate and adopt verified work completed outside dispatch-workitems
  review-reenter <ID>            Turn pending human review rejections into rework tasks and reactivate the mission
  scope-approve <ID> [--goal <TEXT>] [--reason <TEXT>]
                                 Approve a scope change and rebaseline the origin intent
  purge    [--execute]            Preview stale missions to archive (--execute to apply)
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
  console.log(buildHelpText());
}

function showMissionTeam(id: string, refresh = false, organizationId?: string) {
  return withOrganizationContext(organizationId, () => missionSystem.showMissionTeam(id, refresh));
}

async function staffMissionTeam(id: string, organizationId?: string) {
  return withOrganizationContext(organizationId, () => missionSystem.staffMissionTeam(id));
}

async function prewarmMissionTeam(id: string, teamRolesArg?: string, organizationId?: string) {
  return withOrganizationContext(organizationId, () =>
    missionSystem.prewarmMissionTeam(id, teamRolesArg)
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
  console.log(JSON.stringify({ mission_id: upperId, classification }, null, 2));
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
  console.log(JSON.stringify({ mission_id: upperId, classification, workflow }, null, 2));
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

async function handoffMission(id: string, nextPersona: string, note?: string): Promise<void> {
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
    ts: new Date().toISOString(),
    event: 'HANDOFF',
    from: previousPersona,
    to: nextPersona,
    note: note || `Handoff from ${previousPersona} to ${nextPersona}.`,
    handoff_packet: handoffPacket,
  });
  await saveState(upperId, state);
  await syncProjectLedgerIfLinked(upperId);
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
        agentId: process.env.KYBERION_PERSONA || 'operator',
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
    actorId: process.env.KYBERION_PERSONA || 'operator',
    evidenceDir: path.dirname(gatePath),
  });
  auditChain.record({
    agentId: process.env.KYBERION_PERSONA || 'operator',
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
        agentId: process.env.KYBERION_PERSONA || 'operator',
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
    actorId: process.env.KYBERION_PERSONA || 'operator',
    evidenceDir: path.dirname(gatePath),
  });
  auditChain.record({
    agentId: process.env.KYBERION_PERSONA || 'operator',
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
export async function main() {
  // Self-identify as mission_controller role for tier-guard resolution.
  if (!process.env.MISSION_ROLE) {
    process.env.MISSION_ROLE = 'mission_controller';
  }
  // Register reasoning backends so dispatch-workitems delegation reaches a
  // real backend (claude-cli/anthropic) instead of silently using the stub.
  installReasoningBackends();
  killSwitch.startMonitor(Number(process.env.KYBERION_KILL_SWITCH_INTERVAL_MS || 10000));

  const positionalArgs = extractMissionControllerPositionalArgs(process.argv);

  const action = positionalArgs[0];
  const arg1 = positionalArgs[1];
  const arg2 = positionalArgs[2];
  const arg3 = positionalArgs[3];
  const arg4 = positionalArgs[4];
  const arg5 = positionalArgs[5];
  const arg6 = positionalArgs[6];
  const arg7 = positionalArgs[7];

  const hasRefresh = process.argv.includes('--refresh');
  const hasDryRun = process.argv.includes('--dry-run');
  await runMissionControllerAction({
    argv: process.argv,
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
    approveMemoryCandidate,
    rejectMemoryCandidate,
    promoteMemoryCandidate,
    promotePendingMemoryCandidates,
    finishMission,
    resumeMission,
    pauseMission,
    cancelMission,
    recordTask,
    recordEvidence,
    reconcileExistingWork,
    reenterMissionFromReview,
    purgeMissions,
    listMissions,
    listOrganizationCatalogs,
    listOrganizationProfiles,
    showOrganizationProfile,
    showOrganizationDiscovery,
    showMissionStatus,
    showReasoningBackendStatus,
    syncProjectLedger,
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

main().catch((err) => {
  logger.error(err.message);
  process.exit(1);
});
