import { MetricsCollector, listApprovalRequests, listArtifactRecords } from '@agent/core';
import type { ApprovalRequestRecord } from '@agent/core/approval-store';
import type { ArtifactRecord } from '@agent/core/artifact-record';
import { pathResolver, safeExistsSync, safeReaddir, safeReadFile } from '@agent/core';
import { type MissionState } from '../../../../../scripts/refactor/mission-types.js';

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

export interface ApprovalQueueQuery {
  query?: string;
  status?: ApprovalRequestRecord['status'] | ApprovalRequestRecord['status'][] | string | string[];
  kind?: ApprovalRequestRecord['kind'] | ApprovalRequestRecord['kind'][] | string | string[];
  missionId?: string;
  tenant?: string;
  channel?: string;
  limit?: number;
}

function readMissionManagementDirs(): string[] {
  const configPath = pathResolver.knowledge('product/governance/mission-management-config.json');
  if (safeExistsSync(configPath)) {
    try {
      const raw = JSON.parse(safeReadFile(configPath, { encoding: 'utf8' }) as string) as {
        directories?: Record<string, string>;
      };
      const dirs = raw.directories || {};
      return ['personal', 'confidential', 'public']
        .map((tier) => dirs[tier])
        .filter((value): value is string => Boolean(value))
        .map((value) => pathResolver.rootResolve(value));
    } catch {
      // fall back to the default directory layout below.
    }
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
      if (!safeExistsSync(root)) continue;
      for (const entry of safeReaddir(root)) {
        const statePath = `${root}/${entry}/mission-state.json`;
        if (!safeExistsSync(statePath)) continue;
        try {
          const state = JSON.parse(
            safeReadFile(statePath, { encoding: 'utf8' }) as string
          ) as MissionState;
          if (state?.mission_id) states.push(state);
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

function missionSearchText(
  state: MissionState,
  artifactKinds: string[],
  artifactCount: number
): string {
  return [
    state.mission_id,
    state.mission_type,
    state.assigned_persona,
    state.tenant_id,
    state.tenant_slug,
    state.intent?.source_text,
    state.intent?.goal_summary,
    state.intent?.success_condition,
    state.relationships?.project?.project_id,
    state.relationships?.track?.track_id,
    state.relationships?.track?.track_name,
    ...artifactKinds,
    artifactCount.toString(),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase();
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

function getMetricTokens(entry: Record<string, any>): number {
  const usage = entry.usage || {};
  const promptTokens = Number(entry.prompt_tokens ?? usage.prompt_tokens ?? 0);
  const completionTokens = Number(entry.completion_tokens ?? usage.completion_tokens ?? 0);
  return Math.max(0, promptTokens + completionTokens);
}

function getMetricCost(entry: Record<string, any>): number {
  const directCost = Number(
    entry.cost_usd ?? entry.sdk_cost_usd ?? entry.total_cost_usd ?? entry.estimated_cost_usd ?? 0
  );
  if (Number.isFinite(directCost) && directCost > 0) return directCost;
  const tokens = getMetricTokens(entry);
  if (tokens <= 0) return 0;
  return Number(entry.estimated_cost_usd ?? 0);
}

export function buildCostSummary(input: {
  history: Record<string, any>[];
  missionId?: string;
  since?: string;
  budgetUsd?: number;
}): CostSummary {
  const sinceIso = input.since || '';
  const missionFilter = (input.missionId || '').trim().toUpperCase();
  const entries = input.history.filter((entry) => {
    const entryMissionId = String(entry.mission_id || entry.missionId || '').toUpperCase();
    if (missionFilter && entryMissionId !== missionFilter) return false;
    if (sinceIso && String(entry.timestamp || entry.ts || '') < sinceIso) return false;
    return true;
  });

  const byMission = new Map<
    string,
    { missionId: string; tokens: number; usd: number; entryCount: number; lastSeen?: string }
  >();

  let totalTokens = 0;
  let totalUsd = 0;
  for (const entry of entries) {
    const missionId = String(entry.mission_id || entry.missionId || 'unassigned').toUpperCase();
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
    record.lastSeen = String(entry.timestamp || entry.ts || record.lastSeen || '');
    byMission.set(missionId, record);
    totalTokens += tokens;
    totalUsd += usd;
  }

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
    entryCount: entries.length,
    missionCount: byMission.size,
    since: sinceIso || undefined,
    budgetUsd,
    remainingUsd,
    overBudget: typeof budgetUsd === 'number' ? totalUsd > budgetUsd : false,
    missionBreakdown: Array.from(byMission.values()).sort((left, right) => right.usd - left.usd),
  };
}

export function collectCostSummary(
  input: {
    missionId?: string;
    since?: string;
    budgetUsd?: number;
  } = {}
): CostSummary {
  const history = new MetricsCollector({ persist: false }).loadHistory();
  return buildCostSummary({
    history,
    missionId: input.missionId,
    since: input.since,
    budgetUsd: input.budgetUsd,
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
      if (tenantFilter) {
        const tenantValue =
          `${record.requestedByContext?.actorId || ''} ${record.requestedByContext?.surface || ''} ${record.track_id || ''} ${record.track_name || ''}`.toLowerCase();
        if (!tenantValue.includes(tenantFilter)) return false;
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
      requestedAt: record.requestedAt,
      requestedBy: record.requestedBy,
      missionId: record.requestedByContext?.missionId,
      tenantId: record.requestedByContext?.actorId,
      tenantSlug: record.requestedByContext?.surface,
      riskLevel: record.risk?.level,
      serviceId: record.target?.serviceId,
      mutation: record.target?.mutation,
      correlationId: record.correlationId,
      decidedAt: record.decidedAt,
      decidedBy: record.decidedBy,
    }));
}
