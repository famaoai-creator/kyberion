import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getChronosAccessRoleOrThrow,
  guardRequest,
  requireChronosAccess,
  roleToMissionRole,
} from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs,
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
  parseTaskBoard,
  summarizeNextTasks,
} from '../../../lib/mission-progress';
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
  assertSafeRepositoryPath,
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
  promoteMemoryCandidateToKnowledge,
  promotePersonalMemoryCandidates,
  probeSurfaceHealth,
  restartAgentRuntime,
  safeExec,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  loadJson,
  safeReaddir,
  safeStat,
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
import { listMissionsInSearchDirs, loadState } from '@agent/core/mission-state';
import * as intelligenceData from './intelligence-observation-data';
import {
  parseDashboardJsonRecord,
  parseDashboardOwnerSummaryLine,
} from '@agent/core/dashboard-event-parser';

export function readSafeObservationFile(filePath: string): string | null {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return null;
    return safeReadFile(safePath, { encoding: 'utf8' }) as string;
  } catch {
    return null;
  }
}

const CONTROL_EVENT_STRING_KEYS = [
  'ts',
  'decision',
  'event_type',
  'event_id',
  'mission_id',
  'resource_id',
  'operation',
  'requested_by',
  'error',
  'action_id',
  'outcome',
  'why',
] as const;
const CONTROL_PAYLOAD_STRING_KEYS = ['surfaceId', 'operation'] as const;

function controlEventText(event: Record<string, unknown>, key: string): string | undefined {
  const value = event[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseControlEventLine(line: string): Record<string, unknown> | null {
  const event = parseDashboardJsonRecord(line);
  if (!event) return null;
  if (!controlEventTimestamp(event)) return null;
  if (CONTROL_EVENT_STRING_KEYS.some((key) => key in event && typeof event[key] !== 'string')) {
    return null;
  }
  if (event.payload !== undefined) {
    const payload = event.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const payloadRecord = payload as Record<string, unknown>;
    if (
      CONTROL_PAYLOAD_STRING_KEYS.some(
        (key) => key in payloadRecord && typeof payloadRecord[key] !== 'string'
      )
    ) {
      return null;
    }
  }
  return event;
}

function controlEventTimestamp(event: Record<string, unknown>): string | null {
  const timestamp = controlEventText(event, 'ts');
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

function controlPayloadText(event: Record<string, unknown>, key: string): string | undefined {
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return undefined;
  }
  return controlEventText(event.payload as Record<string, unknown>, key);
}

export function collectRecentEvents(
  tenantSlugs: intelligenceData.TenantScope = 'all',
  tierAccess?: readonly string[]
) {
  const files = [
    pathResolver.shared('observability/channels/slack/missions.jsonl'),
    pathResolver.shared('observability/mission-control/orchestration-events.jsonl'),
  ];
  const lines: Array<{ ts: string; decision: string; mission_id?: string; why?: string }> = [];
  for (const file of files) {
    const raw = readSafeObservationFile(file);
    if (raw === null) continue;
    for (const line of raw.trim().split('\n')) {
      if (!line.trim()) continue;
      const event = parseControlEventLine(line);
      if (!event) continue;
      const ts = controlEventTimestamp(event);
      const decision = controlEventText(event, 'decision') || controlEventText(event, 'event_type');
      if (!ts || !decision) continue;
      lines.push({
        ts,
        decision,
        mission_id: controlEventText(event, 'mission_id') || controlEventText(event, 'resource_id'),
        why: controlEventText(event, 'why'),
      });
    }
  }
  return lines
    .filter((event) =>
      intelligenceData.observationVisibleToScope(event.mission_id, tenantSlugs, tierAccess)
    )
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 8);
}
export function collectControlActions(
  tenantSlugs: intelligenceData.TenantScope = 'all',
  tierAccess?: readonly string[]
): intelligenceData.ControlActionSummary[] {
  const file = pathResolver.shared('observability/mission-control/orchestration-events.jsonl');
  const raw = readSafeObservationFile(file);
  if (raw === null) return [];

  const lifecycle = new Map<string, intelligenceData.ControlActionSummary>();

  for (const line of raw.trim().split('\n')) {
    if (!line.trim()) continue;
    const event = parseControlEventLine(line);
    if (!event) continue;
    const decision = controlEventText(event, 'decision') || controlEventText(event, 'event_type');
    const eventType = controlEventText(event, 'event_type');
    const eventId = controlEventText(event, 'event_id');
    const ts = controlEventTimestamp(event);
    if (!decision || !ts) continue;

    if (
      decision === 'mission_orchestration_event_enqueued' &&
      (eventType === 'mission_control_requested' || eventType === 'surface_control_requested') &&
      eventId
    ) {
      const queuedTarget =
        eventType === 'surface_control_requested'
          ? controlPayloadText(event, 'surfaceId') || 'surface-runtime'
          : controlEventText(event, 'mission_id') || 'system';
      lifecycle.set(eventId, {
        event_id: eventId,
        ts,
        kind: eventType === 'mission_control_requested' ? 'mission' : 'surface',
        target: queuedTarget,
        operation: controlPayloadText(event, 'operation') || eventType,
        status: 'queued',
        requested_by: controlEventText(event, 'requested_by') || 'unknown',
      });
      continue;
    }

    if (
      (decision === 'mission_control_action_applied' ||
        decision === 'surface_control_action_applied') &&
      Boolean(controlEventText(event, 'operation'))
    ) {
      const operation = controlEventText(event, 'operation')!;
      const target =
        controlEventText(event, 'mission_id') || controlEventText(event, 'resource_id') || 'system';
      const syntheticId = `${decision}:${target}:${operation}:${ts}`;
      lifecycle.set(syntheticId, {
        event_id: eventId,
        ts,
        kind: decision === 'mission_control_action_applied' ? 'mission' : 'surface',
        target,
        operation,
        status: 'completed',
        requested_by: controlEventText(event, 'requested_by') || 'unknown',
      });
      continue;
    }

    if (decision === 'memory_promote_pending_applied') {
      const target = controlEventText(event, 'resource_id') || 'memory-promotion-queue';
      const syntheticId = `${decision}:${target}:${ts}`;
      lifecycle.set(syntheticId, {
        event_id: eventId,
        ts,
        kind: 'surface',
        target,
        operation: 'memory_promote_pending',
        status: 'completed',
        requested_by: controlEventText(event, 'requested_by') || 'unknown',
        error: controlEventText(event, 'error'),
      });
      continue;
    }

    if (decision === 'next_action_executed') {
      const operation = controlEventText(event, 'operation') || 'next_action_execute';
      const target = controlEventText(event, 'resource_id') || 'next-actions';
      const syntheticId = `${decision}:${target}:${operation}:${ts}`;
      lifecycle.set(syntheticId, {
        event_id: eventId,
        ts,
        kind: 'surface',
        target,
        operation,
        status: controlEventText(event, 'outcome') === 'failed' ? 'failed' : 'completed',
        requested_by: controlEventText(event, 'requested_by') || 'unknown',
        error: controlEventText(event, 'error'),
      });
      continue;
    }

    if (
      decision === 'mission_orchestration_event_failed' &&
      (eventType === 'mission_control_requested' || eventType === 'surface_control_requested') &&
      eventId
    ) {
      const failedTarget =
        eventType === 'surface_control_requested'
          ? controlPayloadText(event, 'surfaceId') || 'surface-runtime'
          : controlEventText(event, 'mission_id') || 'system';
      lifecycle.set(eventId, {
        event_id: eventId,
        ts,
        kind: eventType === 'mission_control_requested' ? 'mission' : 'surface',
        target: failedTarget,
        operation: controlPayloadText(event, 'operation') || eventType,
        status: 'failed',
        requested_by: controlEventText(event, 'requested_by') || 'unknown',
        error: controlEventText(event, 'error'),
      });
    }
  }

  return Array.from(lifecycle.values())
    .filter(
      (action) =>
        (action.kind === 'mission' &&
          intelligenceData.missionVisibleToScope(action.target, tenantSlugs, tierAccess)) ||
        (action.kind === 'surface' && tenantSlugs === 'all')
    )
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 10);
}

export function applyPendingActionSummaries(
  activeMissions: intelligenceData.MissionSummary[],
  surfaces: intelligenceData.SurfaceSummary[],
  controlActions: intelligenceData.ControlActionSummary[]
): {
  activeMissions: intelligenceData.MissionSummary[];
  surfaces: intelligenceData.SurfaceSummary[];
} {
  const pendingMissionTargets = new Map(
    controlActions
      .filter((action) => action.kind === 'mission' && action.status === 'queued')
      .map((action) => [
        action.target,
        { operation: action.operation, requestedBy: action.requested_by },
      ])
  );
  const pendingSurfaceTargets = new Map(
    controlActions
      .filter((action) => action.kind === 'surface' && action.status === 'queued')
      .map((action) => [
        action.target,
        { operation: action.operation, requestedBy: action.requested_by },
      ])
  );

  return {
    activeMissions: activeMissions.map((mission) =>
      pendingMissionTargets.has(mission.missionId)
        ? {
            ...mission,
            controlSummary: `${pendingMissionTargets.get(mission.missionId)?.operation} pending`,
            controlTone: 'pending',
            controlRequestedBy: pendingMissionTargets.get(mission.missionId)?.requestedBy,
          }
        : mission
    ),
    surfaces: surfaces.map((surface) =>
      pendingSurfaceTargets.has(surface.id) || pendingSurfaceTargets.has('surface-runtime')
        ? {
            ...surface,
            controlSummary: `${pendingSurfaceTargets.get(surface.id)?.operation || pendingSurfaceTargets.get('surface-runtime')?.operation} pending`,
            controlTone: 'pending',
            controlRequestedBy:
              pendingSurfaceTargets.get(surface.id)?.requestedBy ||
              pendingSurfaceTargets.get('surface-runtime')?.requestedBy,
          }
        : surface
    ),
  };
}

export function createControlActionDefinition(input: {
  operation: string;
  label: string;
  risk: 'safe' | 'risky';
  enabled: boolean;
  disabledReason?: string;
  approvalRequired?: boolean;
}): intelligenceData.ControlActionDefinition {
  return {
    operation: input.operation,
    label: input.label,
    risk: input.risk,
    approvalRequired: input.approvalRequired === true,
    enabled: input.enabled,
    disabledReason: input.disabledReason,
  };
}

export function collectControlActionCatalog(
  accessRole: 'readonly' | 'localadmin'
): intelligenceData.ControlActionCatalog {
  const controlEnabled = accessRole === 'localadmin';
  const disabledReason = controlEnabled
    ? undefined
    : 'Requires localadmin access. Readonly mode can observe but cannot execute control actions.';
  return {
    mission: [
      createControlActionDefinition({
        operation: 'refresh_team',
        label: 'refresh team',
        risk: 'safe',
        enabled: controlEnabled,
        disabledReason,
      }),
      createControlActionDefinition({
        operation: 'prewarm_team',
        label: 'prewarm',
        risk: 'safe',
        enabled: controlEnabled,
        disabledReason,
      }),
      createControlActionDefinition({
        operation: 'staff_team',
        label: 'staff',
        risk: 'safe',
        enabled: controlEnabled,
        disabledReason,
      }),
      createControlActionDefinition({
        operation: 'resume',
        label: 'resume',
        risk: 'safe',
        enabled: controlEnabled,
        disabledReason,
      }),
      createControlActionDefinition({
        operation: 'pause',
        label: 'pause',
        risk: 'safe',
        enabled: controlEnabled,
        disabledReason,
      }),
      createControlActionDefinition({
        operation: 'finish',
        label: 'finish',
        risk: 'risky',
        approvalRequired: true,
        enabled: controlEnabled,
        disabledReason,
      }),
      createControlActionDefinition({
        operation: 'cancel',
        label: 'cancel',
        risk: 'risky',
        approvalRequired: true,
        enabled: controlEnabled,
        disabledReason,
      }),
    ],
    surface: [
      createControlActionDefinition({
        operation: 'start',
        label: 'start',
        risk: 'safe',
        enabled: controlEnabled,
        disabledReason,
      }),
      createControlActionDefinition({
        operation: 'stop',
        label: 'stop',
        risk: 'risky',
        approvalRequired: true,
        enabled: controlEnabled,
        disabledReason,
      }),
    ],
    globalSurface: [
      createControlActionDefinition({
        operation: 'reconcile',
        label: 'reconcile surfaces',
        risk: 'safe',
        enabled: controlEnabled,
        disabledReason,
      }),
      createControlActionDefinition({
        operation: 'status',
        label: 'status refresh',
        risk: 'safe',
        enabled: controlEnabled,
        disabledReason,
      }),
    ],
  };
}

export function collectControlActionAvailability(
  accessRole: 'readonly' | 'localadmin',
  activeMissions: intelligenceData.MissionSummary[],
  surfaces: intelligenceData.SurfaceSummary[]
): intelligenceData.ControlActionAvailability {
  const baseCatalog = collectControlActionCatalog(accessRole);
  const mission: Record<string, intelligenceData.ControlActionDefinition[]> = {};
  const surface: Record<string, intelligenceData.ControlActionDefinition[]> = {};

  for (const item of activeMissions) {
    mission[item.missionId] = baseCatalog.mission.map((action) => {
      if (accessRole !== 'localadmin') return action;
      if (action.operation === 'resume') {
        if (item.status === 'active') {
          return createControlActionDefinition({
            ...action,
            enabled: false,
            disabledReason: 'Mission is already active.',
          });
        }
        return createControlActionDefinition({
          ...action,
          enabled: item.status === 'paused' || item.status === 'failed',
          disabledReason:
            item.status === 'paused' || item.status === 'failed'
              ? undefined
              : `Mission status is ${item.status}; resume is only available after a pause or failure.`,
        });
      }
      if (action.operation === 'pause') {
        return createControlActionDefinition({
          ...action,
          enabled: item.status === 'active',
          disabledReason:
            item.status === 'active'
              ? undefined
              : `Mission status is ${item.status}; pause is only available for active missions.`,
        });
      }
      if (action.operation === 'cancel') {
        return createControlActionDefinition({
          ...action,
          enabled: item.status !== 'completed' && item.status !== 'archived',
          disabledReason:
            item.status === 'completed' || item.status === 'archived'
              ? 'Completed missions cannot be cancelled from the control plane.'
              : undefined,
        });
      }
      return action;
    });
  }

  for (const item of surfaces) {
    surface[item.id] = baseCatalog.surface.map((action) => {
      if (accessRole !== 'localadmin') return action;
      if (action.operation === 'start' && item.running) {
        return createControlActionDefinition({
          ...action,
          enabled: false,
          disabledReason: 'Surface is already running.',
        });
      }
      if (action.operation === 'stop' && !item.running) {
        return createControlActionDefinition({
          ...action,
          enabled: false,
          disabledReason: 'Surface is already stopped.',
        });
      }
      return action;
    });
  }

  const globalSurface = baseCatalog.globalSurface.map((action) => {
    if (accessRole !== 'localadmin') return action;
    if (surfaces.length === 0) {
      return createControlActionDefinition({
        ...action,
        enabled: false,
        disabledReason: 'No managed surfaces are registered.',
      });
    }
    return action;
  });

  return { mission, surface, globalSurface };
}

export function collectControlActionDetails(
  tenantSlugs: intelligenceData.TenantScope = 'all',
  tierAccess?: readonly string[]
): Record<string, intelligenceData.ControlActionDetail[]> {
  const file = pathResolver.shared('observability/mission-control/orchestration-events.jsonl');
  const raw = readSafeObservationFile(file);
  if (raw === null) return {};

  const details: Record<string, intelligenceData.ControlActionDetail[]> = {};

  for (const line of raw.trim().split('\n')) {
    if (!line.trim()) continue;
    const event = parseControlEventLine(line);
    if (!event) continue;
    const eventId = controlEventText(event, 'event_id');
    const eventType = controlEventText(event, 'event_type');
    const decision = controlEventText(event, 'decision');
    const ts = controlEventTimestamp(event);
    if (!eventId || !ts) continue;
    if (
      eventType !== 'mission_control_requested' &&
      eventType !== 'surface_control_requested' &&
      decision !== 'mission_control_action_applied' &&
      decision !== 'surface_control_action_applied' &&
      decision !== 'next_action_executed' &&
      decision !== 'memory_promote_pending_applied' &&
      decision !== 'mission_orchestration_event_started' &&
      decision !== 'mission_orchestration_event_completed' &&
      decision !== 'mission_orchestration_event_failed'
    ) {
      continue;
    }

    if (!details[eventId]) {
      details[eventId] = [];
    }
    details[eventId].push({
      ts,
      decision: decision || 'event',
      event_type: eventType,
      mission_id: controlEventText(event, 'mission_id'),
      resource_id: controlEventText(event, 'resource_id'),
      operation: controlEventText(event, 'operation'),
      action_id: controlEventText(event, 'action_id'),
      outcome: controlEventText(event, 'outcome'),
      why: controlEventText(event, 'why'),
      error: controlEventText(event, 'error'),
    });
  }

  for (const key of Object.keys(details)) {
    details[key] = details[key].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 8);
  }

  if (tenantSlugs !== 'all' || tierAccess) {
    for (const key of Object.keys(details)) {
      const scoped = details[key].filter((detail) =>
        intelligenceData.observationVisibleToScope(detail.mission_id, tenantSlugs, tierAccess)
      );
      if (scoped.length > 0) details[key] = scoped;
      else delete details[key];
    }
  }

  return details;
}

export function collectOwnerSummaries(
  tenantSlugs: intelligenceData.TenantScope = 'all',
  tierAccess?: readonly string[]
): intelligenceData.OwnerSummary[] {
  const summaries: intelligenceData.OwnerSummary[] = [];
  const files = [
    pathResolver.shared('observability/channels/slack/missions.jsonl'),
    pathResolver.shared('observability/mission-control/orchestration-events.jsonl'),
  ];

  for (const file of files) {
    const raw = readSafeObservationFile(file);
    if (raw === null) continue;
    for (const line of raw.trim().split('\n')) {
      if (!line.trim()) continue;
      const summary = parseDashboardOwnerSummaryLine(line);
      if (!summary) continue;
      if (!intelligenceData.missionVisibleToScope(summary.mission_id, tenantSlugs, tierAccess)) {
        continue;
      }
      summaries.push(summary);
    }
  }
  return summaries.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 6);
}

export function resolveChronosTenantSlug(): string | null {
  try {
    return activeCustomer();
  } catch {
    return null;
  }
}

export function summarizeCompany(company: CompanyAggregate): intelligenceData.CompanySnapshot {
  const approvalAudit = summarizeApprovalAuditTrail(6);
  const financeController = resolveFinanceControllerDecision({ tenantSlug: company.tenant_slug });
  const approvalAuditDrilldown = summarizeApprovalAuditDrilldown(6);
  return {
    companyId: company.company_id,
    tenantSlug: company.tenant_slug,
    name: company.name,
    sovereign: company.sovereign,
    visionRef: buildCompanyVisionRef(company.tenant_slug),
    vision: {
      sourceKind: company.vision_ref.source_kind,
      sourcePath: company.vision_ref.source_path,
      title: company.vision_ref.title,
      soul: company.vision_ref.sections.soul,
      steering: company.vision_ref.sections.steering,
      destination: company.vision_ref.sections.destination,
    },
    organizationProfile: {
      exists: company.organization_profile_ref.exists,
      path: company.organization_profile_ref.path,
      name:
        typeof company.organization_profile_ref.data?.name === 'string'
          ? company.organization_profile_ref.data.name
          : null,
    },
    orgChart: {
      exists: company.org_chart_ref.exists,
      path: company.org_chart_ref.path,
      domainCount: company.org_chart_ref.data?.domains.length || 0,
      positionCount: company.org_chart_ref.data?.positions.length || 0,
      topLevelRoles:
        company.org_chart_ref.data?.positions
          ?.filter((position) => position.reports_to == null)
          .map((position) => position.role_id)
          .sort() || [],
    },
    financial: {
      exists: company.financial_ref.exists,
      path: company.financial_ref.path,
      sourceKind: company.financial_ref.data?.source_kind || null,
      periodCount: company.financial_ref.data?.periods.length || 0,
      latestPeriodId: company.financial_ref.data?.periods.at(-1)?.period_id || null,
      latestRevenueJpy: company.financial_ref.data?.periods.at(-1)?.revenue_jpy ?? null,
      latestOperatingCostJpy:
        company.financial_ref.data?.periods.at(-1)?.operating_cost_jpy ?? null,
      latestGrossProfitJpy: company.financial_ref.data?.periods.at(-1)?.gross_profit_jpy ?? null,
    },
    financeController,
    okr: {
      exists: company.okr_ref.exists,
      path: company.okr_ref.path,
      sourceKind: company.okr_ref.data?.source_kind || null,
      objectiveCount: company.okr_ref.data?.objectives.length || 0,
      keyResultCount:
        company.okr_ref.data?.objectives.reduce(
          (count, objective) => count + objective.key_results.length,
          0
        ) || 0,
      progressPercent: (() => {
        const keyResults =
          company.okr_ref.data?.objectives.flatMap((objective) => objective.key_results) || [];
        const completeCount = keyResults.filter((keyResult) => {
          if (typeof keyResult.current === 'number' && typeof keyResult.target === 'number') {
            return keyResult.current >= keyResult.target;
          }
          if (typeof keyResult.current === 'string' && typeof keyResult.target === 'string') {
            return keyResult.current === keyResult.target;
          }
          return false;
        }).length;
        return keyResults.length > 0 ? Math.round((completeCount / keyResults.length) * 100) : 0;
      })(),
      latestObjective: company.okr_ref.data?.objectives.at(-1)?.objective || null,
    },
    approvalAudit: {
      total: approvalAudit.total,
      allowed: approvalAudit.allowed,
      denied: approvalAudit.denied,
      pending: approvalAudit.pending,
      recentCount: approvalAudit.recent.length,
      latestCorrelationId: approvalAudit.recent[0]?.correlationId || null,
    },
    approvalAuditDrilldown,
    decisionRights: {
      exists: company.decision_rights_ref.exists,
      path: company.decision_rights_ref.path,
      sourceKind: company.decision_rights_ref.data?.source_kind || null,
      ruleCount: company.decision_rights_ref.data?.decisions.length || 0,
      decisionTypes:
        company.decision_rights_ref.data?.decisions
          .map((decision) => decision.decision_type)
          .sort() || [],
    },
  };
}

export function collectRecentSurfaceOutbox(): intelligenceData.SurfaceOutboxMessage[] {
  return [
    ...listSurfaceOutboxMessages('slack', { includeTenantNamespaces: true }),
    ...listSurfaceOutboxMessages('chronos', { includeTenantNamespaces: true }),
  ]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 8);
}

export function approvalVisibleToScope(
  input: { tenantSlug?: string; missionId?: string },
  tenantSlugs: intelligenceData.TenantScope,
  tierAccess?: readonly string[]
): boolean {
  if (tenantSlugs !== 'all' && (!input.tenantSlug || !tenantSlugs.includes(input.tenantSlug))) {
    return false;
  }
  if (!tierAccess) return true;
  if (input.missionId) {
    return intelligenceData.missionVisibleToScope(input.missionId, tenantSlugs, tierAccess);
  }
  return tierAccess.includes('confidential');
}

export function collectPendingSecretApprovals(
  tenantSlugs: string[] | 'all',
  tierAccess?: readonly string[]
): intelligenceData.SecretApprovalSummary[] {
  const secretApprovals = listApprovalRequests({
    kind: 'secret_mutation',
    status: 'pending',
  })
    .filter((request) =>
      approvalVisibleToScope(
        {
          tenantSlug: resolveApprovalTenant(request) || undefined,
          missionId: request.requestedByContext?.missionId,
        },
        tenantSlugs,
        tierAccess
      )
    )
    .map((request) => ({
      id: request.id,
      title: request.title,
      summary: request.summary,
      storageChannel: request.storageChannel,
      requestedAt: request.requestedAt,
      requestedBy: request.requestedBy,
      serviceId: request.target?.serviceId || 'unknown',
      secretKey: request.target?.secretKey || 'unknown',
      mutation: request.target?.mutation || 'set',
      riskLevel: request.risk?.level || 'medium',
      requiresStrongAuth: request.risk?.requiresStrongAuth === true,
      pendingRoles:
        request.workflow?.approvals
          .filter((approval) => approval.status === 'pending')
          .map((approval) => approval.role) || [],
      kind: 'secret_mutation' as const,
    }));

  const computerApprovals = listApprovalRequests({
    storageChannels: ['computer'],
    kind: 'channel-approval',
    status: 'pending',
  })
    .filter((request) =>
      approvalVisibleToScope(
        {
          tenantSlug: resolveApprovalTenant(request) || undefined,
          missionId: request.requestedByContext?.missionId,
        },
        tenantSlugs,
        tierAccess
      )
    )
    .map((request) => ({
      id: request.id,
      title: request.title,
      summary: request.summary,
      storageChannel: request.storageChannel,
      requestedAt: request.requestedAt,
      requestedBy: request.requestedBy,
      serviceId: 'computer',
      secretKey: 'n/a',
      mutation: request.justification?.requestedEffects?.[0] || 'computer_action',
      riskLevel: request.risk?.level || 'medium',
      requiresStrongAuth: request.risk?.requiresStrongAuth === true,
      pendingRoles:
        request.workflow?.approvals
          .filter((approval) => approval.status === 'pending')
          .map((approval) => approval.role) || [],
      kind: 'computer_action' as const,
    }));

  return [...secretApprovals, ...computerApprovals]
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    .slice(0, 20);
}

export function collectPendingApprovals(
  tenantSlugs: string[] | 'all',
  tierAccess?: readonly string[]
): intelligenceData.PendingApprovalSummary[] {
  return listApprovalRequests({ status: 'pending' })
    .filter((request) =>
      approvalVisibleToScope(
        {
          tenantSlug: resolveApprovalTenant(request) || undefined,
          missionId: request.requestedByContext?.missionId,
        },
        tenantSlugs,
        tierAccess
      )
    )
    .map((request) => ({
      id: request.id,
      kind: request.kind,
      channel: request.channel,
      storageChannel: request.storageChannel,
      requestedAt: request.requestedAt,
      requestedBy: request.requestedBy,
      title: request.title,
      summary: request.summary,
      riskLevel: request.risk?.level || 'medium',
      pendingRoles:
        request.workflow?.approvals
          .filter((approval) => approval.status === 'pending')
          .map((approval) => approval.role) || [],
      missionId: request.requestedByContext?.missionId,
      tenantSlug: resolveApprovalTenant(request),
      trackId: request.track_id,
      serviceId: request.target?.serviceId,
      work_loop: request.work_loop,
    }))
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    .slice(0, 24);
}

export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function collectSurfaceSummaries(): Promise<intelligenceData.SurfaceSummary[]> {
  const manifest = loadSurfaceManifest();
  const state = loadSurfaceState();
  const summaries: intelligenceData.SurfaceSummary[] = [];

  for (const entry of manifest.surfaces.map(normalizeSurfaceDefinition)) {
    const record = state.surfaces[entry.id];
    const pidAlive = record ? isPidAlive(record.pid) : false;
    const health = await probeSurfaceHealth(entry);
    const trulyRunning = pidAlive || health.status === 'healthy';
    const controlSummary = !trulyRunning
      ? 'stopped'
      : health.status === 'healthy'
        ? 'stable'
        : health.status === 'unhealthy'
          ? 'needs attention'
          : 'needs restart';
    const controlTone: intelligenceData.SurfaceSummary['controlTone'] = !trulyRunning
      ? 'offline'
      : health.status === 'healthy'
        ? 'stable'
        : 'attention';
    summaries.push({
      id: entry.id,
      kind: entry.kind,
      startupMode: entry.startupMode,
      enabled: entry.enabled !== false,
      running: trulyRunning,
      pid: pidAlive ? record?.pid : undefined,
      health: health.status,
      detail: health.detail,
      controlSummary,
      controlTone,
    });
  }

  return summaries;
}

export function collectRuntimeTopologySurfaces(
  surfaces: intelligenceData.SurfaceSummary[]
): intelligenceData.RuntimeTopologySurfaceInput[] {
  return surfaces
    .filter((surface) => surface.enabled)
    .map((surface) => ({
      id: surface.id,
      kind: surface.kind,
      running: surface.running,
      startupMode: surface.startupMode,
      pid: surface.pid,
    }));
}

export function buildRuntimeDoctor(
  runtimeLeases: intelligenceData.RuntimeLeaseSummary[],
  activeMissions: intelligenceData.MissionSummary[],
  runtimeSnapshots: ReturnType<typeof listAgentRuntimeSnapshots>
): intelligenceData.RuntimeDoctorFinding[] {
  const activeMissionIds = new Set(activeMissions.map((mission) => mission.missionId));
  const runtimeByAgent = new Map(
    runtimeSnapshots.map((snapshot) => [snapshot.agent.agentId, snapshot])
  );
  const findings: intelligenceData.RuntimeDoctorFinding[] = [];

  for (const lease of runtimeLeases) {
    const runtime = runtimeByAgent.get(lease.agent_id);
    if (!runtime) continue;

    if (lease.owner_type === 'mission' && !activeMissionIds.has(lease.owner_id)) {
      findings.push({
        severity: 'critical',
        agentId: lease.agent_id,
        ownerId: lease.owner_id,
        reason: 'Mission-scoped runtime lease without an active mission owner.',
        recommendedAction: 'stop_runtime',
      });
      continue;
    }

    if (runtime.agent.status === 'error') {
      findings.push({
        severity: 'warning',
        agentId: lease.agent_id,
        ownerId: lease.owner_id,
        reason: 'Runtime lease is attached to an agent in error state.',
        recommendedAction: 'restart_runtime',
      });
      continue;
    }

    const executionMode =
      typeof lease.metadata?.execution_mode === 'string'
        ? lease.metadata.execution_mode
        : undefined;
    const channel =
      typeof lease.metadata?.channel === 'string' ? lease.metadata.channel : undefined;
    if (
      executionMode === 'conversation' &&
      channel === 'slack' &&
      runtime.runtime?.idleForMs &&
      runtime.runtime.idleForMs > 5 * 60 * 1000
    ) {
      findings.push({
        severity: 'warning',
        agentId: lease.agent_id,
        ownerId: lease.owner_id,
        reason: 'Conversation-scoped lease appears stale (>5m idle).',
        recommendedAction: 'stop_runtime',
      });
    }
  }

  return findings.slice(0, 12);
}

export function recordRuntimeRemediationArtifacts(input: {
  action: 'cleanup_runtime_lease' | 'restart_runtime_lease';
  agentId: string;
  lease?: intelligenceData.RuntimeLeaseSummary;
}) {
  const lease = input.lease;
  if (!lease) return;

  if (lease.owner_type === 'mission') {
    ledger.record('MISSION_RUNTIME_REMEDIATION', {
      mission_id: lease.owner_id,
      role: 'chronos_localadmin',
      agent_id: input.agentId,
      remediation_action: input.action,
      owner_type: lease.owner_type,
      metadata: lease.metadata || {},
    });
  }

  const channel = typeof lease.metadata?.channel === 'string' ? lease.metadata.channel : undefined;
  if (channel) {
    emitChannelSurfaceEvent('chronos_gateway', channel, 'runtime-remediation', {
      correlation_id:
        typeof lease.metadata?.thread === 'string' ? lease.metadata.thread : input.agentId,
      decision: 'runtime_lease_remediation_applied',
      why: 'Chronos operator applied runtime remediation to a leased agent runtime.',
      policy_used: 'mission_orchestration_control_plane_v1',
      mission_id: lease.owner_type === 'mission' ? lease.owner_id : undefined,
      agent_id: input.agentId,
      resource_id: input.agentId,
      action: input.action,
      owner_type: lease.owner_type,
      owner_id: lease.owner_id,
      thread: typeof lease.metadata?.thread === 'string' ? lease.metadata.thread : undefined,
    });
  }
}
