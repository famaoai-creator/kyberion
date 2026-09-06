import { MetricsCollector } from '@agent/core/metrics';
import { eventScopeMatches, type EventScopeFilter } from '@agent/core/event-scope';
import {
  listGenerationCostSettlements,
  type GenerationCostSettlement,
} from '@agent/core/generation-cost-settlement';
import { resolveScopeForRecord } from '@agent/core/scope-migration';
import { listApprovalRequests } from '@agent/core/approval-store';
import { listArtifactRecords } from '@agent/core/artifact-record';
import { loadMissionManagementConfig } from '@agent/core/mission-management-config';
import { loadState, loadStateAtPath } from '@agent/core/mission-state';
import type { ApprovalRequestRecord } from '@agent/core/approval-store';
import type { ArtifactRecord } from '@agent/core/artifact-record';
import * as pathResolver from '@agent/core/path-resolver';
import { findMissionPath } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';
import { type MissionState } from '../../../../../scripts/refactor/mission-types.js';
import { recordField, stringField } from './json-record';

export interface MissionHistoryEntry {
  missionId: string;
  status: MissionState['status'];
  tier: MissionState['tier'];
  missionType?: string;
  tenantSlug?: string;
  tenantId?: string;
  persona?: string;
  projectId?: string;
  trackId?: string;
  trackName?: string;
  updatedAt?: string;
  startedAt?: string;
  lastEvent?: string;
  intentText?: string;
  goalSummary?: string;
  successCondition?: string;
  artifactKinds: string[];
  artifactCount: number;
  correlationId?: string;
}

export interface MissionHistoryQuery {
  query?: string;
  status?: string;
  tier?: string;
  tenant?: string;
  tenantSlugs?: string[] | 'all';
  kind?: string;
  missionId?: string;
  limit?: number;
}

export interface CostSummary {
  totalTokens: number;
  totalUsd: number;
  entryCount: number;
  missionCount: number;
  since?: string;
  budgetUsd?: number;
  remainingUsd?: number | null;
  overBudget: boolean;
  generation: {
    actualUsd: number;
    settledJobs: number;
    awaitingActualCost: number;
  };
  missionBreakdown: Array<{
    missionId: string;
    tokens: number;
    usd: number;
    entryCount: number;
    lastSeen?: string;
  }>;
}

export interface ApprovalQueueItem {
  id: string;
  channel: string;
  storageChannel: string;
  status: ApprovalRequestRecord['status'];
  kind: ApprovalRequestRecord['kind'];
  title: string;
  summary: string;
  details?: string;
  sourceText?: string;
  target?: ApprovalRequestRecord['target'];
  justification?: ApprovalRequestRecord['justification'];
  risk?: ApprovalRequestRecord['risk'];
  workLoop?: ApprovalRequestRecord['work_loop'];
  requestedAt: string;
  requestedBy: string;
  missionId?: string;
  tenantId?: string;
  tenantSlug?: string;
  riskLevel?: string;
  serviceId?: string;
  mutation?: string;
  correlationId?: string;
  decidedAt?: string;
  decidedBy?: string;
}

export function resolveApprovalTenant(record: ApprovalRequestRecord): string | undefined {
  const context = record.requestedByContext as
    | (ApprovalRequestRecord['requestedByContext'] & {
        tenant_slug?: string;
        tenantSlug?: string;
      })
    | undefined;
  const loopContext = record.work_loop?.context as Record<string, unknown> | undefined;
  const direct =
    context?.tenant_slug ||
    context?.tenantSlug ||
    (typeof loopContext?.tenant_slug === 'string' ? loopContext.tenant_slug : undefined);
  if (direct) return direct;
  const missionId = context?.missionId || record.steering?.missionId;
  if (!missionId) return undefined;
  const missionPath = findMissionPath(missionId);
  if (!missionPath) return undefined;
  try {
    const state = loadState(missionId);
    return state?.tenant_slug || state?.tenant_id;
  } catch {
    return undefined;
  }
}

export interface ApprovalQueueQuery {
  query?: string;
  status?: ApprovalRequestRecord['status'] | ApprovalRequestRecord['status'][] | string | string[];
  kind?: ApprovalRequestRecord['kind'] | ApprovalRequestRecord['kind'][] | string | string[];
  missionId?: string;
  tenant?: string;
  tenantSlugs?: string[] | 'all';
  channel?: string;
  limit?: number;
}

function readMissionManagementDirs(): string[] {
  const config = loadMissionManagementConfig();
  if (config) {
    return ['personal', 'confidential', 'public']
      .map((tier) => config.directories[tier])
      .filter((value): value is string => Boolean(value))
      .map((value) => pathResolver.rootResolve(value));
  }

  return [
    pathResolver.active('missions/public'),
    pathResolver.active('missions/confidential'),
    pathResolver.knowledge('personal/missions'),
    pathResolver.active('archive/missions'),
  ];
}

function collectMissionStates(): MissionState[] {
  const states: MissionState[] = [];
  for (const root of readMissionManagementDirs()) {
    try {
      const safeRoot = assertSafeRepositoryPath(root, { allowMissingLeaf: true });
      if (!safeExistsSync(safeRoot) || !safeLstat(safeRoot).isDirectory()) continue;
      for (const entry of safeReaddir(safeRoot)) {
        const statePath = assertSafeRepositoryPath(`${safeRoot}/${entry}/mission-state.json`, {
          allowMissingLeaf: true,
        });
        if (!safeExistsSync(statePath) || !safeLstat(statePath).isFile()) continue;
        try {
          const state = loadStateAtPath(statePath);
          if (state) states.push(state);
        } catch {
          // Ignore malformed mission state files.
        }
      }
    } catch {
      // Ignore unauthorized or inaccessible mission roots.
    }
  }
  return states;
}

function missionSearchTextFromEntry(item: MissionHistoryEntry): string {
  return [
    item.missionId,
    item.status,
    item.tier,
    item.missionType,
    item.tenantId,
    item.tenantSlug,
    item.persona,
    item.projectId,
    item.trackId,
    item.trackName,
    item.intentText,
    item.goalSummary,
    item.successCondition,
    ...item.artifactKinds,
    String(item.artifactCount),
    item.correlationId,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase();
}

export function projectMissionHistoryItems(
  states: MissionState[],
  artifacts: ArtifactRecord[],
  query: MissionHistoryQuery = {}
): MissionHistoryEntry[] {
  const artifactMap = new Map<string, ArtifactRecord[]>();
  for (const artifact of artifacts) {
    if (!artifact.mission_id) continue;
    const items = artifactMap.get(artifact.mission_id) || [];
    items.push(artifact);
    artifactMap.set(artifact.mission_id, items);
  }

  const filterText = (query.query || '').trim().toLowerCase();
  const missionIdFilter = (query.missionId || '').trim().toUpperCase();
  const tenantFilter = (query.tenant || '').trim().toLowerCase();
  const kindFilter = (query.kind || '').trim().toLowerCase();
  const statusFilter = (query.status || '').trim().toLowerCase();
  const tierFilter = (query.tier || '').trim().toLowerCase();

  return states
    .map((state) => {
      const missionArtifacts = artifactMap.get(state.mission_id) || [];
      const artifactKinds = Array.from(
        new Set(missionArtifacts.map((artifact) => artifact.kind).filter(Boolean))
      );
      const lastEvent = state.history[state.history.length - 1];
      const startedAt = state.history[0]?.ts;
      const updatedAt = lastEvent?.ts || startedAt;
      const item: MissionHistoryEntry = {
        missionId: state.mission_id,
        status: state.status,
        tier: state.tier,
        missionType: state.mission_type,
        tenantId: state.tenant_id,
        tenantSlug: state.tenant_slug,
        persona: state.assigned_persona,
        projectId: state.relationships?.project?.project_id,
        trackId: state.relationships?.track?.track_id,
        trackName: state.relationships?.track?.track_name,
        updatedAt,
        startedAt,
        lastEvent: lastEvent?.event,
        intentText: state.intent?.source_text,
        goalSummary: state.intent?.goal_summary,
        successCondition: state.intent?.success_condition,
        artifactKinds,
        artifactCount: missionArtifacts.length,
        correlationId: state.context?.mission_finish_trace_summary?.traceId,
      };
      return item;
    })
    .filter((item) => {
      if (missionIdFilter && item.missionId.toUpperCase() !== missionIdFilter) return false;
      if (statusFilter && item.status.toLowerCase() !== statusFilter) return false;
      if (tierFilter && item.tier.toLowerCase() !== tierFilter) return false;
      if (tenantFilter) {
        const tenantValue = `${item.tenantSlug || ''} ${item.tenantId || ''}`.toLowerCase();
        if (!tenantValue.includes(tenantFilter)) return false;
      }
      if (query.tenantSlugs && query.tenantSlugs !== 'all') {
        const tenantValue = item.tenantSlug || item.tenantId;
        if (!tenantValue || !query.tenantSlugs.includes(tenantValue)) return false;
      }
      if (
        kindFilter &&
        !item.artifactKinds.some((value) => value.toLowerCase().includes(kindFilter))
      ) {
        return false;
      }
      if (filterText) {
        const haystack = missionSearchTextFromEntry(item);
        if (!haystack.includes(filterText)) return false;
      }
      return true;
    })
    .sort((left, right) => (right.updatedAt || '').localeCompare(left.updatedAt || ''))
    .slice(0, Math.max(1, query.limit || 24));
}

export function buildMissionHistoryItems(query: MissionHistoryQuery = {}): MissionHistoryEntry[] {
  return projectMissionHistoryItems(collectMissionStates(), listArtifactRecords(), query);
}

function numericMetricValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestampForMetricEntry(entry: Record<string, unknown>): string {
  return stringField(entry, 'timestamp') || stringField(entry, 'ts');
}

function getMetricTokens(entry: Record<string, unknown>): number {
  const usage = recordField(entry.usage);
  const promptTokens = numericMetricValue(entry.prompt_tokens ?? usage.prompt_tokens);
  const completionTokens = numericMetricValue(entry.completion_tokens ?? usage.completion_tokens);
  return Math.max(0, promptTokens + completionTokens);
}

function getMetricCost(entry: Record<string, unknown>): number {
  const directCost = numericMetricValue(
    entry.cost_usd ?? entry.sdk_cost_usd ?? entry.total_cost_usd ?? entry.estimated_cost_usd
  );
  if (Number.isFinite(directCost) && directCost > 0) return directCost;
  const tokens = getMetricTokens(entry);
  if (tokens <= 0) return 0;
  return numericMetricValue(entry.estimated_cost_usd);
}

export function buildCostSummary(input: {
  history: Array<Record<string, unknown>>;
  generationSettlements?: GenerationCostSettlement[];
  missionId?: string;
  missionIds?: string[];
  since?: string;
  budgetUsd?: number;
  scopeFilter?: EventScopeFilter;
}): CostSummary {
  const sinceIso = input.since || '';
  const missionFilter = (input.missionId || '').trim().toUpperCase();
  const missionFilters = new Set(
    (input.missionIds || []).map((missionId) => missionId.trim().toUpperCase()).filter(Boolean)
  );
  const entries = input.history.filter((entry) => {
    const entryMissionId = (
      stringField(entry, 'mission_id') || stringField(entry, 'missionId')
    ).toUpperCase();
    if (missionFilter && entryMissionId !== missionFilter) return false;
    if (input.missionIds !== undefined && !missionFilters.has(entryMissionId)) return false;
    const timestamp = timestampForMetricEntry(entry);
    if (sinceIso && timestamp < sinceIso) return false;
    if (
      input.scopeFilter &&
      !eventScopeMatches(
        resolveScopeForRecord(entry as Record<string, unknown>).scope,
        input.scopeFilter
      )
    ) {
      return false;
    }
    return true;
  });

  const byMission = new Map<
    string,
    { missionId: string; tokens: number; usd: number; entryCount: number; lastSeen?: string }
  >();

  let totalTokens = 0;
  let totalUsd = 0;
  for (const entry of entries) {
    const missionId = (
      stringField(entry, 'mission_id') || stringField(entry, 'missionId', 'unassigned')
    ).toUpperCase();
    const tokens = getMetricTokens(entry);
    const usd = getMetricCost(entry);
    const record = byMission.get(missionId) || {
      missionId,
      tokens: 0,
      usd: 0,
      entryCount: 0,
      lastSeen: undefined,
    };
    record.tokens += tokens;
    record.usd += usd;
    record.entryCount += 1;
    record.lastSeen = timestampForMetricEntry(entry) || record.lastSeen || '';
    byMission.set(missionId, record);
    totalTokens += tokens;
    totalUsd += usd;
  }

  let generationActualUsd = 0;
  let settledGenerationJobs = 0;
  let awaitingGenerationCost = 0;
  const seenGenerationSettlements = new Set<string>();
  for (const settlement of input.generationSettlements || []) {
    if (seenGenerationSettlements.has(settlement.settlement_id)) continue;
    seenGenerationSettlements.add(settlement.settlement_id);
    const settlementMissionId = String(settlement.scope.mission_id || 'unassigned').toUpperCase();
    if (missionFilter && settlementMissionId !== missionFilter) continue;
    if (input.missionIds !== undefined && !missionFilters.has(settlementMissionId)) continue;
    if (sinceIso && settlement.observed_at < sinceIso) continue;
    if (input.scopeFilter && !eventScopeMatches(settlement.scope, input.scopeFilter)) continue;
    if (settlement.status === 'unavailable') {
      awaitingGenerationCost += 1;
      continue;
    }
    const usd = Number(settlement.actual_cost_usd);
    if (!Number.isFinite(usd) || usd < 0) continue;
    const record = byMission.get(settlementMissionId) || {
      missionId: settlementMissionId,
      tokens: 0,
      usd: 0,
      entryCount: 0,
      lastSeen: undefined,
    };
    record.usd += usd;
    record.entryCount += 1;
    record.lastSeen = settlement.observed_at;
    byMission.set(settlementMissionId, record);
    generationActualUsd += usd;
    settledGenerationJobs += 1;
    totalUsd += usd;
  }

  const generationEntryCount = settledGenerationJobs;

  const budgetUsd =
    typeof input.budgetUsd === 'number' && Number.isFinite(input.budgetUsd) && input.budgetUsd > 0
      ? input.budgetUsd
      : undefined;
  const remainingUsd =
    typeof budgetUsd === 'number'
      ? Math.max(0, Math.round((budgetUsd - totalUsd) * 1000) / 1000)
      : null;

  return {
    totalTokens,
    totalUsd: Math.round(totalUsd * 1000) / 1000,
    entryCount: entries.length + generationEntryCount,
    missionCount: byMission.size,
    since: sinceIso || undefined,
    budgetUsd,
    remainingUsd,
    overBudget: typeof budgetUsd === 'number' ? totalUsd > budgetUsd : false,
    generation: {
      actualUsd: Math.round(generationActualUsd * 1000) / 1000,
      settledJobs: settledGenerationJobs,
      awaitingActualCost: awaitingGenerationCost,
    },
    missionBreakdown: Array.from(byMission.values()).sort((left, right) => right.usd - left.usd),
  };
}

export function collectCostSummary(
  input: {
    missionId?: string;
    missionIds?: string[];
    since?: string;
    budgetUsd?: number;
    scopeFilter?: EventScopeFilter;
  } = {}
): CostSummary {
  const history = new MetricsCollector({ persist: false }).loadHistory();
  const generationSettlements = listGenerationCostSettlements({
    scopeFilter: input.scopeFilter,
    since: input.since,
  });
  return buildCostSummary({
    history,
    generationSettlements,
    missionId: input.missionId,
    missionIds: input.missionIds,
    since: input.since,
    budgetUsd: input.budgetUsd,
    scopeFilter: input.scopeFilter,
  });
}

export function buildApprovalQueueItems(query: ApprovalQueueQuery = {}): ApprovalQueueItem[] {
  const statusFilter = query.status
    ? new Set(Array.isArray(query.status) ? query.status : [query.status])
    : null;
  const kindFilter = query.kind
    ? new Set(Array.isArray(query.kind) ? query.kind : [query.kind])
    : null;
  const missionFilter = (query.missionId || '').trim().toUpperCase();
  const tenantFilter = (query.tenant || '').trim().toLowerCase();
  const channelFilter = (query.channel || '').trim().toLowerCase();
  const textFilter = (query.query || '').trim().toLowerCase();

  return listApprovalRequests()
    .filter((record) => {
      if (statusFilter && !statusFilter.has(record.status)) return false;
      if (kindFilter && !kindFilter.has(record.kind)) return false;
      if (missionFilter && record.requestedByContext?.missionId?.toUpperCase() !== missionFilter)
        return false;
      const resolvedTenant = resolveApprovalTenant(record);
      if (tenantFilter) {
        const tenantValue =
          `${resolvedTenant || ''} ${record.requestedByContext?.actorId || ''} ${record.requestedByContext?.surface || ''} ${record.track_id || ''} ${record.track_name || ''}`.toLowerCase();
        if (!tenantValue.includes(tenantFilter)) return false;
      }
      if (query.tenantSlugs && query.tenantSlugs !== 'all') {
        if (!resolvedTenant || !query.tenantSlugs.includes(resolvedTenant)) return false;
      }
      if (
        channelFilter &&
        !`${record.channel} ${record.storageChannel}`.toLowerCase().includes(channelFilter)
      ) {
        return false;
      }
      if (textFilter) {
        const haystack = [
          record.title,
          record.summary,
          record.details,
          record.requestedBy,
          record.requestedByContext?.missionId,
          record.target?.serviceId,
          record.target?.mutation,
          record.correlationId,
          record.storageChannel,
          record.channel,
        ]
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(textFilter)) return false;
      }
      return true;
    })
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
    .slice(0, Math.max(1, query.limit || 24))
    .map((record) => ({
      id: record.id,
      channel: record.channel,
      storageChannel: record.storageChannel,
      status: record.status,
      kind: record.kind,
      title: record.title,
      summary: record.summary,
      details: record.details,
      sourceText: record.sourceText,
      target: record.target,
      justification: record.justification,
      risk: record.risk,
      workLoop: record.work_loop,
      requestedAt: record.requestedAt,
      requestedBy: record.requestedBy,
      missionId: record.requestedByContext?.missionId,
      tenantId: record.requestedByContext?.actorId,
      tenantSlug: resolveApprovalTenant(record),
      riskLevel: record.risk?.level,
      serviceId: record.target?.serviceId,
      mutation: record.target?.mutation,
      correlationId: record.correlationId,
      decidedAt: record.decidedAt,
      decidedBy: record.decidedBy,
    }));
}
