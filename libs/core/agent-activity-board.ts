/**
 * Agent Activity Board — 「どのエージェントが今何をしていて、どこが
 * ブロッカーか」を1つの集約で返す(chronos の可視化ビュー用)。
 *
 * ソース: work-coordination の WorkItem(ticket dispatch が mission:ラベル、
 * metadata に task_id/phase/team_role/dependencies を載せる)+ ミッション
 * state(tenant_slug)。純関数 compose + impure build の2層。
 */

import { listWorkItems, type WorkItem } from './work-coordination.js';
import {
  buildWorkVisibilityProjection,
  resolveWorkItemContext,
  type WorkVisibilityViewer,
} from './work-visibility.js';
import { loadState } from './mission-state.js';

export interface AgentActivityBlocker {
  kind: 'blocked' | 'dependency' | 'review_wait' | 'unassigned';
  reason: string;
}

export interface AgentActivityEntry {
  agent_id: string;
  team_role?: string;
  mission_id?: string;
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  task_id?: string;
  work_shape?: string;
  item_id: string;
  title: string;
  status: string;
  phase?: string;
  blockers: AgentActivityBlocker[];
  updated_at: string;
}

export interface AgentActivitySummaryRow {
  agent_id: string;
  active: number;
  blocked: number;
  in_review: number;
}

export interface AgentActivityBoard {
  generated_at: string;
  tenant?: string;
  entries: AgentActivityEntry[];
  agents: AgentActivitySummaryRow[];
}

function deriveBlockers(
  item: WorkItem,
  siblingStatusByTaskId: Map<string, string>
): AgentActivityBlocker[] {
  const blockers: AgentActivityBlocker[] = [];
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  if (item.status === 'blocked') {
    const lastAttempt = item.attempts?.[item.attempts.length - 1];
    blockers.push({
      kind: 'blocked',
      reason: String(
        lastAttempt?.blocked_reason ||
          lastAttempt?.failure_reason ||
          lastAttempt?.summary ||
          'タスクがブロック状態です(needs_input の可能性)'
      ),
    });
  }
  const dependencies = Array.isArray(metadata.dependencies)
    ? metadata.dependencies.map((dependency) => String(dependency))
    : [];
  const unmet = dependencies.filter((dependency) => {
    const status = siblingStatusByTaskId.get(dependency);
    return status !== undefined && !['done', 'archived'].includes(status);
  });
  if (unmet.length > 0 && ['backlog', 'ready'].includes(item.status)) {
    blockers.push({ kind: 'dependency', reason: `依存タスク待ち: ${unmet.join(', ')}` });
  }
  if (item.status === 'review') {
    blockers.push({ kind: 'review_wait', reason: 'レビュー/ゲート承認待ち' });
  }
  if (!item.assignee_peer_id && !['done', 'archived'].includes(item.status)) {
    blockers.push({ kind: 'unassigned', reason: '担当エージェント未割当' });
  }
  return blockers;
}

/** Pure mapping — testable without stores. */
export function composeAgentActivityBoard(input: {
  items: WorkItem[];
  viewer?: WorkVisibilityViewer;
  tenantByMission?: Record<string, string | undefined>;
  tenantFilter?: string;
  now?: string;
}): AgentActivityBoard {
  const missionItems = buildWorkVisibilityProjection({
    items: input.items,
    viewer: input.viewer || { tenantSlugs: 'all' },
    scope: 'operations',
  }).items;
  const statusByTaskId = new Map<string, string>();
  for (const item of missionItems) {
    const taskId = String((item.metadata as Record<string, unknown> | undefined)?.task_id || '');
    if (taskId) statusByTaskId.set(taskId, item.status);
  }

  const entries: AgentActivityEntry[] = [];
  for (const item of missionItems) {
    const context = resolveWorkItemContext(item);
    const missionId = context.mission_id;
    const tenant =
      context.tenant_slug || (missionId ? input.tenantByMission?.[missionId] : undefined);
    if (input.tenantFilter && tenant !== input.tenantFilter) continue;
    if (['done', 'archived'].includes(item.status)) continue;
    const metadata = (item.metadata || {}) as Record<string, unknown>;
    entries.push({
      agent_id: item.assignee_peer_id || '(未割当)',
      team_role: metadata.team_role ? String(metadata.team_role) : undefined,
      mission_id: missionId,
      tenant_slug: tenant,
      organization_id: context.organization_id,
      project_id: context.project_id,
      task_id: context.task_id,
      work_shape: context.work_shape,
      item_id: item.item_id,
      title: item.title,
      status: item.status,
      phase: metadata.phase ? String(metadata.phase) : undefined,
      blockers: deriveBlockers(item, statusByTaskId),
      updated_at: item.updated_at,
    });
  }
  entries.sort((left, right) => right.updated_at.localeCompare(left.updated_at));

  const byAgent = new Map<string, AgentActivitySummaryRow>();
  for (const entry of entries) {
    const row = byAgent.get(entry.agent_id) || {
      agent_id: entry.agent_id,
      active: 0,
      blocked: 0,
      in_review: 0,
    };
    if (entry.status === 'in_progress' || entry.status === 'ready') row.active += 1;
    if (entry.blockers.some((blocker) => blocker.kind !== 'review_wait')) row.blocked += 1;
    if (entry.status === 'review') row.in_review += 1;
    byAgent.set(entry.agent_id, row);
  }

  return {
    generated_at: input.now || new Date().toISOString(),
    tenant: input.tenantFilter,
    entries,
    agents: [...byAgent.values()].sort((a, b) => b.active + b.blocked - (a.active + a.blocked)),
  };
}

export function readMissionTenantSlug(missionId: string): string | undefined {
  try {
    const state = loadState(missionId);
    return state?.tenant_slug || state?.tenant_id || undefined;
  } catch {
    return undefined;
  }
}

export function buildAgentActivityBoard(
  options: { tenant?: string; tenantSlugs?: string[] | 'all' } = {}
): AgentActivityBoard {
  const items = listWorkItems({
    tenantSlugs: options.tenantSlugs === 'all' ? undefined : options.tenantSlugs,
  });
  const tenantByMission: Record<string, string | undefined> = {};
  for (const item of items) {
    const missionId = resolveWorkItemContext(item).mission_id;
    if (missionId && !(missionId in tenantByMission)) {
      tenantByMission[missionId] = readMissionTenantSlug(missionId);
    }
  }
  return composeAgentActivityBoard({
    items,
    tenantByMission,
    tenantFilter: options.tenant,
    viewer: { tenantSlugs: options.tenantSlugs || (options.tenant ? [options.tenant] : 'all') },
  });
}
