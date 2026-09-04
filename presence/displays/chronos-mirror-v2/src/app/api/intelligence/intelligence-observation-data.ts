import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OsKnowledgeTier } from '@agent/core/cloudflare-os-control-plane';
import {
  getChronosAccessRoleOrThrow,
  guardRequest,
  requireChronosAccess,
  roleToMissionRole,
} from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs,
  strictViewerTier,
  ViewerContextError,
  viewerErrorResponse,
  type ViewerContext,
} from '../../../lib/viewer-context';
import { resolveApprovalTenant } from '../../../lib/su-surface-data';
import { memoryCandidateVisibleToViewer } from '../../../lib/knowledge-scope';
import { buildCompanyVisionRef, resolveCompany, type CompanyAggregate } from '@agent/core/company';
import {
  summarizeApprovalAuditDrilldown,
  summarizeApprovalAuditTrail,
  type ApprovalAuditDrilldownSummary,
} from '@agent/core/approval-audit';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import {
  resolveFinanceControllerDecision,
  type FinanceControllerDecision,
} from '@agent/core/finance-controller';
import type { OrganizationWorkLoopSummary } from '@agent/core/work-design';
import { activeCustomer } from '@agent/core/customer-resolver';
import {
  collectA2AHandoffs,
  collectAgentMessages,
  type AgentMessageSummary,
  type A2AHandoffSummary,
} from '../../../lib/agent-message-feed';
import {
  collectBrowserConversationSessions,
  collectBrowserSessions,
  type BrowserConversationSessionSummary,
  type BrowserSessionSummary,
} from '../../../lib/intelligence-observations';
import {
  extractMissionDependencies,
  normalizeMissionAssets,
  parseNextTaskRecords,
  parseTaskBoard,
  summarizeNextTasks,
} from '../../../lib/mission-progress';
import { loadMissionNextTaskObjectsAtPath } from '@agent/core/mission-next-task-reader';
import { applyBrowserSessionControl } from '../../../lib/browser-session-control';
import { buildRuntimeTopology } from '../../../lib/runtime-topology';
import {
  collectComputerSessions,
  type ComputerSessionSummary,
} from '../../../lib/computer-sessions';
import {
  buildExecutionEnv,
  buildTrackGateReadinessSummaries,
  buildTrackNextWorkProposal,
  clearSurfaceOutboxMessage,
  createDistillCandidateRecord,
  createNextActionContract,
  decideApprovalRequest,
  loadApprovalRequest,
  normalizeRejectionReasonCategory,
  enqueueSurfaceNotification,
  emitChannelSurfaceEvent,
  emitMissionOrchestrationObservation,
  enqueueMissionOrchestrationEvent,
  ledger,
  listArtifactRecords,
  listAgentRuntimeLeaseSummaries,
  listAgentRuntimeSnapshots,
  listApprovalRequests,
  listDistillCandidateRecords,
  listMemoryPromotionCandidates,
  listMissionSeedRecords,
  listProjectRecords,
  listProjectTrackRecords,
  listServiceBindingRecords,
  listSurfaceOutboxMessages,
  loadDistillCandidateRecord,
  loadMissionSeedRecord,
  loadProjectRecord,
  loadProjectTrackRecord,
  loadSurfaceManifest,
  loadSurfaceState,
  materializeTrackArtifactSkeleton,
  normalizeSurfaceDefinition,
  pathResolver,
  assertSafeRepositoryPath,
  promoteMemoryCandidateToKnowledge,
  promotePersonalMemoryCandidates,
  probeSurfaceHealth,
  restartAgentRuntime,
  safeExec,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeReaddir,
  saveDistillCandidateRecord,
  saveMissionSeedRecord,
  saveProjectRecord,
  savePromotedMemoryRecord,
  startMissionOrchestrationWorker,
  stopAgentRuntime,
  summarizeMissionSeedAssessment,
  updateDistillCandidateRecord,
  updateMemoryPromotionCandidateStatus,
} from '../../../lib/intelligence-primitives';
import { listWorkItems } from '@agent/core/work-coordination';
import { getProjectManagementView } from '@agent/core/project-management';
import { listMissionsInSearchDirs, loadState, loadStateAtPath } from '@agent/core/mission-state';

export interface RuntimeTopologySurfaceInput {
  id: string;
  kind: string;
  running: boolean;
  startupMode?: string;
  pid?: number;
}
export interface MissionSummary {
  missionId: string;
  tenantSlug?: string;
  status: string;
  tier: string;
  missionType?: string;
  projectId?: string;
  projectPath?: string;
  trackId?: string;
  trackName?: string;
  planReady: boolean;
  nextTaskCount: number;
  controlSummary: string;
  controlTone: 'planning' | 'ready' | 'attention' | 'pending';
  controlRequestedBy?: string;
}

export interface MissionProgressSummary {
  missionId: string;
  boardStatus: string;
  boardStepsTotal: number;
  boardStepsDone: number;
  boardStepsActive: number;
  boardStepsPending: number;
  nextTasksTotal: number;
  nextTasksPending: number;
  nextTasksCompleted: number;
  dependencies: string[];
  generatedAssets: Array<{
    path: string;
    category: 'deliverables' | 'artifacts' | 'outputs' | 'evidence';
    sizeBytes: number;
    updatedAt: string;
  }>;
}

export interface RuntimeLeaseSummary {
  agent_id: string;
  owner_id: string;
  owner_type: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeDoctorFinding {
  severity: 'warning' | 'critical';
  agentId: string;
  ownerId: string;
  reason: string;
  recommendedAction: 'stop_runtime' | 'restart_runtime';
}

export interface OwnerSummary {
  ts: string;
  mission_id: string;
  accepted_count: number;
  reviewed_count: number;
  completed_count: number;
  requested_count: number;
}

export interface CompanySnapshot {
  companyId: string;
  tenantSlug: string;
  name: string;
  sovereign: string | null;
  visionRef: string;
  vision: {
    sourceKind: CompanyAggregate['vision_ref']['source_kind'];
    sourcePath: string;
    title: string | null;
    soul: string[];
    steering: string[];
    destination: string[];
  };
  organizationProfile: {
    exists: boolean;
    path: string;
    name: string | null;
  };
  orgChart: {
    exists: boolean;
    path: string;
    domainCount: number;
    positionCount: number;
    topLevelRoles: string[];
  };
  financial: {
    exists: boolean;
    path: string;
    sourceKind: string | null;
    periodCount: number;
    latestPeriodId: string | null;
    latestRevenueJpy: number | null;
    latestOperatingCostJpy: number | null;
    latestGrossProfitJpy: number | null;
  };
  financeController: FinanceControllerDecision;
  okr: {
    exists: boolean;
    path: string;
    sourceKind: string | null;
    objectiveCount: number;
    keyResultCount: number;
    progressPercent: number;
    latestObjective: string | null;
  };
  approvalAudit: {
    total: number;
    allowed: number;
    denied: number;
    pending: number;
    recentCount: number;
    latestCorrelationId: string | null;
  };
  approvalAuditDrilldown: ApprovalAuditDrilldownSummary;
  decisionRights: {
    exists: boolean;
    path: string;
    sourceKind: string | null;
    ruleCount: number;
    decisionTypes: string[];
  };
}

export interface SurfaceOutboxMessage {
  message_id: string;
  surface: string;
  correlation_id: string;
  channel: string;
  thread_ts: string;
  text: string;
  source: 'surface' | 'nerve' | 'system';
  created_at: string;
}

export interface SurfaceSummary {
  id: string;
  kind: string;
  startupMode?: string;
  enabled: boolean;
  running: boolean;
  pid?: number;
  health: string;
  detail?: string;
  controlSummary: string;
  controlTone: 'stable' | 'attention' | 'offline' | 'pending';
  controlRequestedBy?: string;
}

export interface SecretApprovalSummary {
  id: string;
  title: string;
  summary: string;
  storageChannel: string;
  requestedAt: string;
  requestedBy: string;
  serviceId: string;
  secretKey: string;
  mutation: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requiresStrongAuth: boolean;
  pendingRoles: string[];
  kind?: 'secret_mutation' | 'computer_action';
}

export interface PendingApprovalSummary {
  id: string;
  kind: 'channel-approval' | 'secret_mutation' | 'mission_gate';
  channel: string;
  storageChannel: string;
  requestedAt: string;
  requestedBy: string;
  title: string;
  summary: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  pendingRoles: string[];
  missionId?: string;
  tenantSlug?: string;
  serviceId?: string;
  work_loop?: OrganizationWorkLoopSummary;
}

export interface BrowserSessionView extends BrowserSessionSummary {}
export interface BrowserConversationSessionView extends BrowserConversationSessionSummary {}
export interface ComputerSessionView extends ComputerSessionSummary {}

export interface A2AHandoffView extends A2AHandoffSummary {}

export interface ControlActionSummary {
  event_id?: string;
  ts: string;
  kind: 'mission' | 'surface';
  target: string;
  operation: string;
  status: 'queued' | 'completed' | 'failed';
  requested_by: string;
  error?: string;
}

export interface ControlActionDetail {
  ts: string;
  decision: string;
  event_type?: string;
  mission_id?: string;
  resource_id?: string;
  operation?: string;
  action_id?: string;
  outcome?: string;
  why?: string;
  error?: string;
}

export type TenantScope = string[] | 'all';

export function missionTenantSlug(missionId: string): string | undefined {
  return missionScope(missionId)?.tenant;
}

export function missionTier(missionId: string): string | undefined {
  return missionScope(missionId)?.tier;
}

function missionScope(missionId: string): { tenant?: string; tier?: string } | undefined {
  const normalized = String(missionId || '').trim();
  if (!normalized) return undefined;
  try {
    const matches = listMissionsInSearchDirs().filter((entry) => entry.missionId === normalized);
    if (matches.length !== 1) return undefined;
    const directory = path.dirname(matches[0].missionPath);
    const state = loadState(normalized, { directories: [directory] });
    if (!state) return undefined;
    return {
      tenant: state.tenant_slug || state.tenant_id,
      tier: typeof state.tier === 'string' ? state.tier : undefined,
    };
  } catch {
    return undefined;
  }
}

export function missionVisibleToTenant(
  missionId: string | undefined,
  tenantSlugs: TenantScope
): boolean {
  if (!missionId) return false;
  const tenant = missionScope(missionId)?.tenant;
  if (!tenant) return false;
  if (tenantSlugs === 'all') return true;
  return Boolean(tenant && tenantSlugs.includes(tenant));
}

export function missionVisibleToScope(
  missionId: string | undefined,
  tenantSlugs: TenantScope,
  tierAccess?: readonly string[]
): boolean {
  if (!missionId) return false;
  const scope = missionScope(missionId);
  if (!scope?.tenant) return false;
  if (tenantSlugs !== 'all' && !tenantSlugs.includes(scope.tenant)) return false;
  if (!tierAccess) return true;
  return Boolean(scope.tier && tierAccess.includes(scope.tier));
}

/** Events without a mission are global control data and are treated as confidential. */
export function observationVisibleToScope(
  missionId: string | undefined,
  tenantSlugs: TenantScope,
  tierAccess?: readonly string[]
): boolean {
  if (missionId) return missionVisibleToScope(missionId, tenantSlugs, tierAccess);
  if (tenantSlugs !== 'all') return false;
  return !tierAccess || tierAccess.includes('confidential');
}

export function projectVisibleToTenant(
  project: { tier: 'personal' | 'confidential' | 'public'; tenant_slug?: string },
  tenantSlugs: TenantScope
): boolean {
  if (tenantSlugs === 'all') return true;
  return Boolean(project.tenant_slug && tenantSlugs.includes(project.tenant_slug));
}

export function distillCandidateVisibleToTenant(
  candidate: { project_id?: string; mission_id?: string },
  tenantSlugs: TenantScope
): boolean {
  if (tenantSlugs === 'all') return true;
  if (candidate.project_id) {
    const project = loadProjectRecord(candidate.project_id);
    return Boolean(project && projectVisibleToTenant(project, tenantSlugs));
  }
  return missionVisibleToTenant(candidate.mission_id, tenantSlugs);
}

export function filterServiceBindingsToTenant(
  bindings: Array<{
    binding_id: string;
    scope: string;
    tenant_slug?: string;
    project_id?: string;
  }>,
  projects: Array<{ service_bindings?: string[] }>,
  tenantSlugs: TenantScope
) {
  if (tenantSlugs === 'all') return bindings;
  const projectBindingIds = new Set(projects.flatMap((project) => project.service_bindings || []));
  return bindings.filter((binding) => {
    if (binding.scope === 'project') return projectBindingIds.has(binding.binding_id);
    return Boolean(binding.tenant_slug && tenantSlugs.includes(binding.tenant_slug));
  });
}

export function surfaceOutboxVisibleToTenant(
  message: { correlation_id?: string },
  tenantSlugs: TenantScope,
  tierAccess?: readonly string[]
): boolean {
  if (tenantSlugs === 'all' && !tierAccess) return true;
  const correlationId = String(message.correlation_id || '')
    .trim()
    .toUpperCase();
  return (
    correlationId.startsWith('MSN-') &&
    missionVisibleToScope(correlationId, tenantSlugs, tierAccess)
  );
}

export function missionScopeError(
  viewer: ViewerContext,
  missionId: string,
  requestedTenant?: string
): NextResponse | null {
  const allowedTenants = strictViewerScopeTenantSlugs(viewer, requestedTenant);
  const tier = missionTier(missionId);
  if (
    missionVisibleToTenant(missionId, allowedTenants) &&
    tier &&
    (() => {
      try {
        strictViewerTier(viewer, tier as OsKnowledgeTier);
        return true;
      } catch {
        return false;
      }
    })()
  ) {
    return null;
  }
  return NextResponse.json(
    { error: 'Mission is outside the viewer tenant scope' },
    { status: 403 }
  );
}

export function projectScopeError(
  viewer: ViewerContext,
  project: { tier: 'personal' | 'confidential' | 'public'; tenant_slug?: string },
  requestedTenant?: string
): NextResponse | null {
  const allowedTenants = strictViewerScopeTenantSlugs(viewer, requestedTenant);
  if (
    projectVisibleToTenant(project, allowedTenants) &&
    (() => {
      try {
        strictViewerTier(viewer, project.tier);
        return true;
      } catch {
        return false;
      }
    })()
  ) {
    return null;
  }
  return NextResponse.json(
    { error: 'Project is outside the viewer tenant scope' },
    { status: 403 }
  );
}

export function safeCollect<T>(label: string, fallback: T, collect: () => T): T {
  try {
    return collect();
  } catch (err) {
    console.warn(`[chronos-mirror-v2] ${label} failed`, err);
    return fallback;
  }
}

export interface ControlActionDefinition {
  operation: string;
  label: string;
  risk: 'safe' | 'risky';
  approvalRequired: boolean;
  enabled: boolean;
  disabledReason?: string;
}

export interface ControlActionCatalog {
  mission: ControlActionDefinition[];
  surface: ControlActionDefinition[];
  globalSurface: ControlActionDefinition[];
}

export interface ControlActionAvailability {
  mission: Record<string, ControlActionDefinition[]>;
  surface: Record<string, ControlActionDefinition[]>;
  globalSurface: ControlActionDefinition[];
}

export interface NextActionSummary {
  action_id: string;
  next_action_type:
    | 'request_clarification'
    | 'approve'
    | 'inspect_evidence'
    | 'retry_delivery'
    | 'promote_mission_seed'
    | 'resume_mission';
  reason: string;
  risk: 'low' | 'medium' | 'high';
  suggested_command?: string;
  suggested_surface_action?:
    'approvals' | 'mission-seeds' | 'memory-promotion-queue' | 'next-actions';
  approval_required: boolean;
}

export interface WorkCoordinationItemSummary {
  item_id: string;
  title: string;
  status: string;
  priority: string;
  project_id: string;
  source_ref: string;
  updated_at: string;
  attempt_count: number;
  current_attempt_id?: string;
  current_attempt_status?: string;
  current_attempt_started_at?: string;
  current_attempt_summary?: string;
  blocked_reason?: string;
  failure_reason?: string;
  claimed_by_peer_id?: string;
  claimed_by_user_id?: string;
}

export interface WorkCoordinationSummary {
  total: number;
  backlog: number;
  ready: number;
  inProgress: number;
  blocked: number;
  review: number;
  done: number;
  archived: number;
  runningAttempts: number;
  recentItems: WorkCoordinationItemSummary[];
}

export function buildChronosNextActions(input: {
  pendingApprovals: number;
  missionSeeds: Array<{ promoted_mission_id?: string }>;
  memoryCandidates: Array<{ status?: string }>;
}): NextActionSummary[] {
  const actions: NextActionSummary[] = [];

  if (input.pendingApprovals > 0) {
    actions.push(
      createNextActionContract({
        actionId: 'chronos-approve-pending',
        type: 'approve',
        reason: `${input.pendingApprovals} pending approval request(s) require a decision.`,
        risk: 'medium',
        suggestedCommand: 'pnpm control chronos approvals',
        suggestedSurfaceAction: 'approvals',
        approvalRequired: true,
      })
    );
  }

  const approvedMemoryCount = input.memoryCandidates.filter(
    (item) => item.status === 'approved'
  ).length;
  if (approvedMemoryCount > 0) {
    actions.push(
      createNextActionContract({
        actionId: 'chronos-promote-memory',
        type: 'inspect_evidence',
        reason: `${approvedMemoryCount} approved memory candidate(s) are ready for governed promotion.`,
        risk: 'low',
        suggestedCommand: 'pnpm control chronos promote-memory --dry-run',
        suggestedSurfaceAction: 'memory-promotion-queue',
        approvalRequired: false,
      })
    );
  }

  const promotableSeedCount = input.missionSeeds.filter((seed) => !seed.promoted_mission_id).length;
  if (promotableSeedCount > 0) {
    actions.push(
      createNextActionContract({
        actionId: 'chronos-promote-seed',
        type: 'promote_mission_seed',
        reason: `${promotableSeedCount} mission seed(s) can be promoted into active missions.`,
        risk: 'low',
        suggestedCommand: 'pnpm control chronos mission-seeds',
        suggestedSurfaceAction: 'mission-seeds',
        approvalRequired: false,
      })
    );
  }

  return actions;
}

export function collectWorkCoordinationSummary(
  tenantSlugs: string[] | 'all' = 'all',
  tierAccess?: readonly string[]
): WorkCoordinationSummary {
  const items = listWorkItems({
    tenantSlugs: tenantSlugs === 'all' ? undefined : tenantSlugs,
  }).filter((item) => {
    if (!tierAccess) return true;
    const project = loadProjectRecord(item.project_id);
    return Boolean(project && tierAccess.includes(project.tier));
  });
  const summary: WorkCoordinationSummary = {
    total: items.length,
    backlog: 0,
    ready: 0,
    inProgress: 0,
    blocked: 0,
    review: 0,
    done: 0,
    archived: 0,
    runningAttempts: 0,
    recentItems: [],
  };

  for (const item of items) {
    switch (item.status) {
      case 'backlog':
        summary.backlog += 1;
        break;
      case 'ready':
        summary.ready += 1;
        break;
      case 'in_progress':
        summary.inProgress += 1;
        break;
      case 'blocked':
        summary.blocked += 1;
        break;
      case 'review':
        summary.review += 1;
        break;
      case 'done':
        summary.done += 1;
        break;
      case 'archived':
        summary.archived += 1;
        break;
    }
    const attempts = Array.isArray(item.attempts) ? item.attempts : [];
    summary.runningAttempts += attempts.filter((attempt) => attempt.status === 'running').length;
  }

  summary.recentItems = items.slice(0, 6).map((item) => {
    const attempts = Array.isArray(item.attempts) ? item.attempts : [];
    const currentAttempt =
      attempts.find((attempt) => attempt.run_id === item.current_attempt_id) ||
      attempts[attempts.length - 1] ||
      null;
    return {
      item_id: item.item_id,
      title: item.title,
      status: item.status,
      priority: item.priority,
      project_id: item.project_id,
      source_ref: item.source_ref,
      updated_at: item.updated_at,
      attempt_count: attempts.length,
      ...(item.current_attempt_id ? { current_attempt_id: item.current_attempt_id } : {}),
      ...(currentAttempt?.status ? { current_attempt_status: currentAttempt.status } : {}),
      ...(currentAttempt?.started_at
        ? { current_attempt_started_at: currentAttempt.started_at }
        : {}),
      ...(currentAttempt?.summary ? { current_attempt_summary: currentAttempt.summary } : {}),
      ...(currentAttempt?.blocked_reason ? { blocked_reason: currentAttempt.blocked_reason } : {}),
      ...(currentAttempt?.failure_reason ? { failure_reason: currentAttempt.failure_reason } : {}),
      ...(currentAttempt?.actor_peer_id
        ? { claimed_by_peer_id: currentAttempt.actor_peer_id }
        : {}),
      ...(currentAttempt?.actor_user_id
        ? { claimed_by_user_id: currentAttempt.actor_user_id }
        : {}),
    };
  });

  return summary;
}

export function inferMissionSeedPromotionTargetKind(seed: {
  mission_type_hint?: string;
  specialist_id?: string;
}): 'pattern' | 'sop_candidate' | 'knowledge_hint' {
  const hint = String(seed.mission_type_hint || '').toLowerCase();
  if (hint === 'verification' || seed.specialist_id === 'service-operator') {
    return 'sop_candidate';
  }
  if (hint === 'architecture' || hint === 'implementation') {
    return 'pattern';
  }
  return 'knowledge_hint';
}

export function buildMissionSeedPromotionMetadata(
  seed: {
    seed_id: string;
    title: string;
    summary: string;
    specialist_id: string;
    mission_type_hint?: string;
    source_task_session_id?: string;
  },
  project: {
    project_id: string;
    name: string;
    kickoff_brief?: string;
  }
): Record<string, unknown> {
  const targetKind = inferMissionSeedPromotionTargetKind(seed);
  if (targetKind === 'pattern') {
    return {
      promotion_source: 'mission_seed',
      applicability: [
        'durable mission promotion',
        project.name,
        seed.mission_type_hint || 'general',
      ],
      reusable_steps: [
        'Review the project kickoff and current durable work candidates.',
        'Select the mission seed with the clearest specialist and outcome fit.',
        'Promote the seed into a governed mission and capture the resulting mission id.',
      ],
      expected_outcome: `${seed.title} is promoted into a durable mission with explicit project ownership.`,
      recommended_refs: [`project:${project.project_id}`, `mission_seed:${seed.seed_id}`],
    };
  }
  if (targetKind === 'sop_candidate') {
    return {
      promotion_source: 'mission_seed',
      procedure_steps: [
        'Review the seed and confirm the project context is ready for durable execution.',
        'Start the governed mission with the appropriate mission type and project relationship.',
        'Record the promoted mission id and notify the surface.',
      ],
      safety_notes: [
        'Promote durable work only from an approved control plane action.',
        'Keep the project relationship and evidence trail attached to the promoted mission.',
      ],
      escalation_conditions: [
        'The parent project record is missing.',
        'mission_controller fails to start the durable mission.',
        'The promoted mission id cannot be written back to the seed or project.',
      ],
    };
  }
  return {
    promotion_source: 'mission_seed',
    hint_scope: 'mission promotion',
    hint_triggers: [seed.title, project.name, seed.mission_type_hint || 'durable work'],
    recommended_refs: [
      `project:${project.project_id}`,
      `mission_seed:${seed.seed_id}`,
      ...(seed.source_task_session_id ? [`task_session:${seed.source_task_session_id}`] : []),
    ],
    kickoff_brief: project.kickoff_brief || '',
  };
}

export function buildLearnedNotificationText(input: {
  projectId?: string;
  language?: SupportedLocale;
}): string {
  if (!input.projectId) return '';
  const titles = listDistillCandidateRecords()
    .filter((candidate) => candidate.project_id === input.projectId && candidate.promoted_ref)
    .map((candidate) => candidate.title)
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, 2);
  if (titles.length === 0) return '';
  if (input.language === 'ja') {
    return ` 過去の learned pattern（${titles.join('、')}）も参照できます。`;
  }
  return ` Learned patterns such as ${titles.join(', ')} are also available.`;
}

export function inferProjectIdForApproval(input: {
  missionId?: string;
  serviceId?: string;
}): string | undefined {
  const projects = listProjectRecords();
  if (input.missionId) {
    const byMission = projects.find((project) =>
      (project.active_missions || []).includes(input.missionId || '')
    );
    if (byMission) return byMission.project_id;
  }
  if (input.serviceId) {
    const byService = projects.find((project) =>
      (project.service_bindings || []).some((bindingId) =>
        bindingId.includes(input.serviceId || '')
      )
    );
    if (byService) return byService.project_id;
  }
  return undefined;
}

export function buildApprovalDecisionText(input: {
  title: string;
  decision: 'approved' | 'rejected';
  missionId?: string;
  serviceId?: string;
}): string {
  const projectId = inferProjectIdForApproval({
    missionId: input.missionId,
    serviceId: input.serviceId,
  });
  const learnedText = buildLearnedNotificationText({ projectId, language: 'en' });
  if (input.decision === 'approved') {
    return `${input.title} was approved. The requested work can proceed now.${learnedText}`;
  }
  return `${input.title} was rejected. The requested work will stay blocked until it is revised.`;
}

export function resolveProjectRootPath(
  project: ReturnType<typeof loadProjectRecord>
): string | null {
  if (!project) return null;
  const repoRoot = project.repositories?.find(
    (repo) => typeof repo.root_path === 'string' && repo.root_path.trim()
  );
  if (repoRoot?.root_path) return repoRoot.root_path;
  const metadataRoot =
    typeof project.metadata?.root_path === 'string' ? project.metadata.root_path : null;
  return metadataRoot || null;
}

function safeMissionResourcePath(filePath: string): string | null {
  try {
    return assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  } catch {
    return null;
  }
}

function loadMissionNextTasksForProjection(
  filePath: string,
  missionDirectoryName: string
): ReturnType<typeof parseNextTaskRecords> {
  try {
    return parseNextTaskRecords(loadMissionNextTaskObjectsAtPath(filePath, missionDirectoryName));
  } catch {
    return null;
  }
}

export function collectActiveMissions(): MissionSummary[] {
  const missionRoots = [
    { dir: pathResolver.active('missions/public'), tier: 'public' },
    { dir: pathResolver.active('missions/confidential'), tier: 'confidential' },
  ];
  const missions: MissionSummary[] = [];

  for (const root of missionRoots) {
    try {
      const safeRoot = safeMissionResourcePath(root.dir);
      if (!safeRoot || !safeExistsSync(safeRoot) || !safeLstat(safeRoot).isDirectory()) continue;
      for (const item of safeReaddir(safeRoot)) {
        const missionPath = safeMissionResourcePath(path.join(safeRoot, item));
        if (!missionPath || !safeExistsSync(missionPath) || !safeLstat(missionPath).isDirectory()) {
          continue;
        }
        const statePath = safeMissionResourcePath(path.join(missionPath, 'mission-state.json'));
        const state = statePath ? loadStateAtPath(statePath) : null;
        const status = state?.status;
        if (!status || !['active', 'planned', 'paused', 'failed'].includes(status)) continue;
        const nextTaskRecords =
          loadMissionNextTasksForProjection(path.join(missionPath, 'NEXT_TASKS.json'), item) || [];
        const planPath = safeMissionResourcePath(path.join(missionPath, 'PLAN.md'));
        const planReady = Boolean(
          planPath && safeExistsSync(planPath) && safeLstat(planPath).isFile()
        );
        const nextTaskCount = nextTaskRecords.length;
        const controlSummary =
          status === 'paused' || status === 'failed'
            ? `${status} mission`
            : planReady
              ? nextTaskCount > 0
                ? 'execution ready'
                : 'plan ready'
              : 'planning pending';
        const controlTone: MissionSummary['controlTone'] =
          status === 'paused' || status === 'failed'
            ? 'attention'
            : planReady
              ? nextTaskCount > 0
                ? 'ready'
                : 'planning'
              : 'attention';
        missions.push({
          missionId: state.mission_id || item,
          tenantSlug: state.tenant_slug || state.tenant_id,
          status,
          tier: state.tier || root.tier,
          missionType: state.mission_type,
          projectId: state.relationships?.project?.project_id,
          projectPath: state.relationships?.project?.project_path,
          trackId: state.relationships?.track?.track_id,
          trackName: state.relationships?.track?.track_name,
          planReady,
          nextTaskCount,
          controlSummary,
          controlTone,
        });
      }
    } catch {
      // Skip roots that are unavailable to the current authority role.
    }
  }

  return missions.sort((a, b) => a.missionId.localeCompare(b.missionId));
}

export function collectMissionProgress(activeMissions: MissionSummary[]): MissionProgressSummary[] {
  const missionRoots = [
    pathResolver.active('missions/public'),
    pathResolver.active('missions/confidential'),
  ];
  const summaries: MissionProgressSummary[] = [];

  for (const mission of activeMissions) {
    const missionPath = missionRoots
      .map((root) => path.join(root, mission.missionId))
      .map((candidate) => safeMissionResourcePath(candidate))
      .find((candidate): candidate is string =>
        Boolean(candidate && safeExistsSync(candidate) && safeLstat(candidate).isDirectory())
      );
    if (!missionPath) continue;

    const taskBoardPath = safeMissionResourcePath(path.join(missionPath, 'TASK_BOARD.md'));
    const nextTasksPath = safeMissionResourcePath(path.join(missionPath, 'NEXT_TASKS.json'));
    const statePath = safeMissionResourcePath(path.join(missionPath, 'mission-state.json'));
    const taskBoard =
      taskBoardPath && safeExistsSync(taskBoardPath) && safeLstat(taskBoardPath).isFile()
        ? String(safeReadFile(taskBoardPath, { encoding: 'utf8' }) || '')
        : '';
    const nextTasks = nextTasksPath
      ? loadMissionNextTasksForProjection(nextTasksPath, path.basename(missionPath)) || []
      : [];
    const missionState = statePath ? loadStateAtPath(statePath) : null;
    const board = parseTaskBoard(taskBoard);
    const nextTaskSummary = summarizeNextTasks(nextTasks);
    const generatedAssets: MissionProgressSummary['generatedAssets'] = [];
    for (const dirName of ['deliverables', 'artifacts', 'outputs', 'evidence'] as const) {
      const dirPath = safeMissionResourcePath(path.join(missionPath, dirName));
      if (!dirPath || !safeExistsSync(dirPath) || !safeLstat(dirPath).isDirectory()) continue;
      for (const entry of safeReaddir(dirPath)) {
        const fullPath = safeMissionResourcePath(path.join(dirPath, entry));
        if (!fullPath) continue;
        try {
          const stats = safeLstat(fullPath);
          if (stats.isFile()) {
            generatedAssets.push({
              path: `${dirName}/${entry}`,
              category: dirName,
              sizeBytes: stats.size,
              updatedAt: stats.mtime.toISOString(),
            });
          }
        } catch {
          // Ignore unreadable entries.
        }
      }
    }

    summaries.push({
      missionId: mission.missionId,
      ...board,
      ...nextTaskSummary,
      dependencies: extractMissionDependencies(
        missionState?.relationships as Record<string, unknown> | undefined
      ),
      generatedAssets: normalizeMissionAssets(generatedAssets),
    });
  }

  return summaries.sort((a, b) => a.missionId.localeCompare(b.missionId));
}
