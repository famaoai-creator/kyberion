import * as path from 'node:path';
import { MetricsCollector } from './metrics.js';
import { listApprovalRequests } from './approval-store.js';
import { listArtifactRecords } from './artifact-record.js';
import { buildNextAction, type NextAction } from './next-action.js';
import { listInboxEntries, type DeliverableInboxEntry } from './deliverable-inbox.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeReaddir } from './secure-io.js';

export interface OperatorHomeMissionItem {
  missionId: string;
  status: string;
  tier: 'personal' | 'confidential' | 'public';
  missionType?: string;
  tenantSlug?: string;
  tenantId?: string;
  persona?: string;
  projectId?: string;
  trackId?: string;
  trackName?: string;
  updatedAt?: string;
  goalSummary?: string;
  successCondition?: string;
  artifactKinds: string[];
  artifactCount: number;
}

export interface OperatorHomeCostSummary {
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

export type OperatorHomeApprovalItem = ReturnType<typeof listApprovalRequests>[number];

export interface OperatorHomeSummary {
  generatedAt: string;
  status: 'ready' | 'attention' | 'blocked';
  statusLabel: string;
  statusDetail: string;
  counts: {
    activeMissions: number;
    /** Active missions with any state change in the last 7 days — the honest
     * "actually moving" number (long-lived active states accumulate). */
    recentlyActiveMissions: number;
    blockedMissions: number;
    pendingApprovals: number;
    clarificationQuestions: number;
    unreadInbox: number;
    totalInbox: number;
  };
  activeMissions: OperatorHomeMissionItem[];
  pendingApprovals: OperatorHomeApprovalItem[];
  inboxEntries: DeliverableInboxEntry[];
  costSummary: OperatorHomeCostSummary;
  nextAction: NextAction;
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
      // fall back to defaults
    }
  }

  return [
    pathResolver.active('missions/public'),
    pathResolver.active('missions/confidential'),
    pathResolver.knowledge('personal/missions'),
    pathResolver.active('archive/missions'),
  ];
}

function collectMissionStates(): OperatorHomeMissionItem[] {
  const missions: OperatorHomeMissionItem[] = [];
  const artifactRecords = listArtifactRecords();
  for (const root of readMissionManagementDirs()) {
    if (!safeExistsSync(root)) continue;
    try {
      for (const entry of safeReaddir(root)) {
        const statePath = path.join(root, entry, 'mission-state.json');
        if (!safeExistsSync(statePath)) continue;
        try {
          const state = JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string) as {
            mission_id: string;
            status: string;
            tier: 'personal' | 'confidential' | 'public';
            mission_type?: string;
            tenant_id?: string;
            tenant_slug?: string;
            assigned_persona?: string;
            relationships?: {
              project?: { project_id?: string };
              track?: { track_id?: string; track_name?: string };
            };
            history?: Array<{ ts: string; event: string }>;
            intent?: {
              goal_summary?: string;
              success_condition?: string;
            };
          };
          if (!state?.mission_id) continue;
          const lastEvent = state.history?.[state.history.length - 1];
          const missionArtifacts = artifactRecords.filter(
            (artifact) => artifact.mission_id === state.mission_id
          );
          missions.push({
            missionId: state.mission_id,
            status: state.status,
            tier: state.tier,
            missionType: state.mission_type,
            tenantSlug: state.tenant_slug,
            tenantId: state.tenant_id,
            persona: state.assigned_persona,
            projectId: state.relationships?.project?.project_id,
            trackId: state.relationships?.track?.track_id,
            trackName: state.relationships?.track?.track_name,
            updatedAt: lastEvent?.ts || state.history?.[0]?.ts,
            goalSummary: state.intent?.goal_summary,
            successCondition: state.intent?.success_condition,
            artifactKinds: Array.from(
              new Set(missionArtifacts.map((artifact) => artifact.kind).filter(Boolean))
            ),
            artifactCount: missionArtifacts.length,
          });
        } catch {
          // ignore malformed mission state files
        }
      }
    } catch {
      // ignore inaccessible roots
    }
  }
  return missions.sort((left, right) =>
    (right.updatedAt || '').localeCompare(left.updatedAt || '')
  );
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

function collectCostSummary(
  input: {
    missionId?: string;
    since?: string;
    budgetUsd?: number;
  } = {}
): OperatorHomeCostSummary {
  const history = new MetricsCollector({ persist: false }).loadHistory();
  const sinceIso = input.since || '';
  const missionFilter = (input.missionId || '').trim().toUpperCase();
  const entries = history.filter((entry) => {
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
    const missionId = String(entry.mission_id || entry.missionId || 'UNASSIGNED').toUpperCase();
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

export function collectOperatorHomeSummary(
  input: {
    budgetUsd?: number;
    since?: string;
    limit?: number;
  } = {}
): OperatorHomeSummary {
  const missionItems = collectMissionStates();
  const activeMissions = missionItems.filter((item) => item.status === 'active');
  const blockedMissions = missionItems.filter(
    (item) => item.status === 'paused' || item.status === 'failed'
  );
  const pendingApprovals = listApprovalRequests({ status: 'pending' }).slice(0, input.limit || 8);
  const inboxEntries = listInboxEntries({ limit: input.limit || 8 });
  const unreadInbox = inboxEntries.filter((entry) => entry.status === 'unread').length;
  const clarificationQuestions = 0;
  const costSummary = collectCostSummary({
    budgetUsd: input.budgetUsd,
    since: input.since,
  });
  const status =
    blockedMissions.length > 0
      ? 'blocked'
      : pendingApprovals.length > 0 || unreadInbox > 0
        ? 'attention'
        : 'ready';
  const statusLabel =
    status === 'blocked' ? 'blocked' : status === 'attention' ? 'attention required' : 'ready';
  const statusDetail =
    status === 'blocked'
      ? `${blockedMissions.length} mission(s) are paused or failed.`
      : status === 'attention'
        ? `${pendingApprovals.length} approval(s) and ${unreadInbox} inbox item(s) need attention.`
        : 'No blocking issues detected.';

  const nextAction =
    blockedMissions.length > 0
      ? buildNextAction({
          title: 'Inspect blocked missions',
          reason: `${blockedMissions.length} mission(s) need recovery before the surface should be treated as clear.`,
          next_action_type: 'inspect_artifact',
          suggested_command: 'pnpm mission list --active',
        })
      : pendingApprovals.length > 0
        ? buildNextAction({
            title: 'Review the approval queue',
            reason: `${pendingApprovals.length} approval request(s) are waiting for operator review.`,
            next_action_type: 'run_command',
            suggested_command: 'pnpm kyberion approvals',
          })
        : unreadInbox > 0
          ? buildNextAction({
              title: 'Acknowledge new deliverables',
              reason: `${unreadInbox} inbox item(s) were delivered and are still unread.`,
              next_action_type: 'inspect_artifact',
              suggested_command: 'pnpm kyberion inbox',
            })
          : buildNextAction({
              title: 'Keep monitoring the surface',
              reason: 'No immediate operator action is pending.',
              next_action_type: 'open_docs',
              suggested_command: 'pnpm doctor',
            });

  return {
    generatedAt: new Date().toISOString(),
    status,
    statusLabel,
    statusDetail,
    counts: {
      activeMissions: activeMissions.length,
      recentlyActiveMissions: activeMissions.filter((item) => {
        const updated = Date.parse(String(item.updatedAt || ''));
        return Number.isFinite(updated) && Date.now() - updated < 7 * 24 * 60 * 60 * 1000;
      }).length,
      blockedMissions: blockedMissions.length,
      pendingApprovals: pendingApprovals.length,
      clarificationQuestions,
      unreadInbox,
      totalInbox: inboxEntries.length,
    },
    activeMissions: activeMissions.slice(0, input.limit || 8),
    pendingApprovals,
    inboxEntries,
    costSummary,
    nextAction,
  };
}
