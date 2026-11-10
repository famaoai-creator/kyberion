/**
 * ホーム / Home situational-awareness dashboard — ONE server read.
 *
 * Every number on `/` comes from this single snapshot (one call per store,
 * taken back to back under the viewer's execution context), so two tiles can
 * never disagree the way the former ops home blocks did (AUDIT §2-5). The
 * needs-you count is deliberately absent: it has exactly one source
 * (`/api/v1/needs-you/summary`, contract §2) and no other count of pending
 * decisions may appear on the page.
 *
 * `collectHomeDashboard` does the I/O; `composeHomeDashboard` is pure and
 * owns every rule (buckets, rates, ordering), so it is tested without stores.
 * A failing source marks only its own tile `unavailable`; it never turns
 * into a healthy-looking zero.
 */
import { buildAgentActivityBoard } from '@agent/core/agent/agent-activity-board';
import { listAgentRuntimeSnapshots } from '@agent/core/agent/agent-runtime-supervisor';
import { resolveCompany } from '@agent/core/company';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { withStoreGrant } from '@agent/core/authority';
import { listMissionsInSearchDirs, loadState } from '@agent/core/mission/mission-state';
import { readOrNullOnMissionRefusal } from '@agent/core/mission-lookup';
import type { MissionState } from '@agent/core/mission/mission-types';
import { buildOrganizationManagementView } from '@agent/core/organization/organization-operating-model-management';
import { humanizeSummary, stripIdPrefix } from '@agent/core/surface/display-humanize';
import { WORKSPACE_GRAPH_READER_ROLE, viewerAdmitsNode } from '@agent/core/surface/workspace-graph';
import { viewerPersonIds } from '@agent/core/surface/surface-authorization';
import { krView, type KrDirection, type KrStatus } from '../components/ops/organization-outcome';
import { collectDeliverableInbox, type DeliverableInboxItem } from './ops/deliverable-inbox';
import {
  collectCostSummary,
  projectMissionHistoryItems,
  type CostSummary,
  type MissionHistoryEntry,
} from './ops/su-surface-data';
import {
  toSurfaceAuthorizationContext,
  withViewerExecutionContext,
  type ViewerContext,
} from './ops/ops-viewer';

export const HOME_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const KR_LIMIT = 5;
const BLOCKED_LIMIT = 3;
const DELIVERABLE_LIMIT = 5;

export type HomeSection = 'agents' | 'missions' | 'health' | 'krs' | 'cost' | 'deliverables';

export type HomeAgentState = 'working' | 'waiting' | 'error' | 'idle';

export interface HomeDashboard {
  generatedAt: string;
  /** Tiles whose source could not be read. Their data below is empty, never zero-as-healthy. */
  unavailable: HomeSection[];
  /**
   * Tiles whose detail is withheld by the selection: the personal (all-company)
   * view shows counts only, never one company's titles (`applyTenantSelection`).
   */
  withheld?: HomeSection[];
  agents: Record<HomeAgentState, number> & { total: number; unassignedItems: number };
  missions: {
    open: { active: number; planned: number; paused: number; failed: number };
    /** Completed missions per day, oldest first; the last bucket is the 24h ending now. */
    throughput: number[];
    throughputTotal: number;
    throughputPrevious: number;
    blocked: Array<{ id: string; title: string; status: 'paused' | 'failed'; updatedAt?: string }>;
    blockedTotal: number;
  };
  health: {
    /** Failed / (failed + completed) over the 7 days ending each of the last 7 days, 0..1; null when nothing finished in that window. */
    failureRate: Array<number | null>;
    failureRateCurrent: number | null;
    failureRatePrevious: number | null;
    /** Median hours from start to finish over the 7 days ending each of the last 7 days. */
    durationHours: Array<number | null>;
    durationCurrent: number | null;
    durationPrevious: number | null;
  };
  krs: {
    state: 'ready' | 'no_organization' | 'no_objectives';
    organizationName?: string;
    items: Array<{
      title: string;
      percent?: number;
      status: KrStatus;
      value?: number;
      target: number;
      unit?: string;
      direction?: KrDirection;
    }>;
  };
  cost: {
    totalUsd: number;
    budgetUsd?: number;
    remainingUsd?: number | null;
    overBudget: boolean;
    /** False when some calls have no known price or partitions were withheld. */
    complete: boolean;
  } | null;
  deliverables: Array<{
    id: string;
    title: string;
    kind: string;
    missionTitle?: string;
    updatedAt: string;
  }>;
}

export interface HomeKeyResultInput {
  title: string;
  target: number;
  direction?: KrDirection;
  unit?: string;
  value?: number;
  progress?: number;
  baseline?: number;
}

export interface HomeSnapshot {
  now: number;
  missions?: MissionHistoryEntry[];
  agentEntries?: Array<{ agent_id: string; status: string }>;
  /** Agent ids whose runtime reports error / demoted. */
  erroredAgents?: string[];
  organization?:
    { state: 'none' } | { state: 'ready'; name?: string; keyResults: HomeKeyResultInput[] };
  cost?: CostSummary;
  deliverables?: DeliverableInboxItem[];
  /** Sources that threw. */
  failed: HomeSection[];
}

const OPEN_ACTIVE = new Set(['active', 'validating', 'distilling']);
const FINISHED_OK = new Set(['completed', 'archived']);

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Mission title for a person: goal, never the raw id. */
export function missionDisplayTitle(mission: {
  goalSummary?: string;
  intentText?: string;
}): string {
  for (const candidate of [mission.goalSummary, mission.intentText]) {
    const text = humanizeSummary(stripIdPrefix(candidate), 80).short;
    if (text) return text;
  }
  return '';
}

/** `reports/q3-sales_summary.pdf` → `q3 sales summary`. */
export function deliverableDisplayTitle(item: { path?: string; kind: string }): string {
  const base = (item.path || '').split('/').pop() || '';
  const stem = base.replace(/\.[a-z0-9]{1,6}$/iu, '').replace(/[-_]+/gu, ' ');
  const text = humanizeSummary(stem, 60).short;
  // A stem without a single letter (`2026-10-24`) names nothing; the page
  // labels it by date instead.
  return /\p{L}/u.test(text) ? text : '';
}

function classifyAgent(statuses: string[], errored: boolean): HomeAgentState {
  if (errored) return 'error';
  if (statuses.some((status) => status === 'blocked' || status === 'review')) return 'waiting';
  if (statuses.some((status) => status === 'in_progress')) return 'working';
  return 'idle';
}

/** Pure: every rule of the dashboard lives here. */
export function composeHomeDashboard(snapshot: HomeSnapshot): HomeDashboard {
  const unavailable = new Set<HomeSection>(snapshot.failed);
  const now = snapshot.now;

  // Agents: one state per agent, the most attention-worthy one first.
  const statusesByAgent = new Map<string, string[]>();
  let unassignedItems = 0;
  for (const entry of snapshot.agentEntries ?? []) {
    if (entry.agent_id === 'unassigned') {
      unassignedItems += 1;
      continue;
    }
    const list = statusesByAgent.get(entry.agent_id) ?? [];
    list.push(entry.status);
    statusesByAgent.set(entry.agent_id, list);
  }
  const errored = new Set(snapshot.erroredAgents ?? []);
  for (const agentId of errored)
    if (!statusesByAgent.has(agentId)) statusesByAgent.set(agentId, []);
  const agents = { working: 0, waiting: 0, error: 0, idle: 0, total: 0, unassignedItems };
  for (const [agentId, statuses] of statusesByAgent) {
    agents[classifyAgent(statuses, errored.has(agentId))] += 1;
    agents.total += 1;
  }

  // Missions: open states, 7-day throughput, the newest blocked ones.
  const missions = snapshot.missions ?? [];
  const open = { active: 0, planned: 0, paused: 0, failed: 0 };
  // 14 daily buckets, oldest first; the last is the 24h ending now. The
  // first 7 are "the 7 days before", the last 7 the current window.
  const SPAN = HOME_DAYS * 2;
  const completed14 = Array.from({ length: SPAN }, () => 0);
  const failed14 = Array.from({ length: SPAN }, () => 0);
  const durations14 = Array.from({ length: SPAN }, () => [] as number[]);
  for (const mission of missions) {
    if (OPEN_ACTIVE.has(mission.status)) open.active += 1;
    else if (mission.status === 'planned') open.planned += 1;
    else if (mission.status === 'paused') open.paused += 1;
    else if (mission.status === 'failed') open.failed += 1;
    const finished = FINISHED_OK.has(mission.status) || mission.status === 'failed';
    const at = Date.parse(mission.updatedAt || '');
    if (!finished || !Number.isFinite(at) || at > now) continue;
    const age = Math.floor((now - at) / DAY_MS);
    if (age >= SPAN) continue;
    const bucket = SPAN - 1 - age;
    const started = Date.parse(mission.startedAt || '');
    const hours = Number.isFinite(started) && started <= at ? (at - started) / 3_600_000 : null;
    if (mission.status === 'failed') failed14[bucket]! += 1;
    else {
      completed14[bucket]! += 1;
      if (hours !== null) durations14[bucket]!.push(hours);
    }
  }
  const blockedAll = missions
    .filter(
      (mission): mission is MissionHistoryEntry & { status: 'paused' | 'failed' } =>
        mission.status === 'paused' || mission.status === 'failed'
    )
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const rate = (failed: number, completed: number) =>
    failed + completed > 0 ? round(failed / (failed + completed), 3) : null;
  const completedPerDay = completed14.slice(HOME_DAYS);
  const currentCompleted = sum(completedPerDay);
  const currentFailed = sum(failed14.slice(HOME_DAYS));
  const previousCompleted = sum(completed14.slice(0, HOME_DAYS));
  const previousFailed = sum(failed14.slice(0, HOME_DAYS));
  // Health lines are trailing 7-day windows ending on each of the last 7
  // days, so a sparse week still reads as a line, not scattered dots.
  const windowOf = <T>(values: T[], end: number) => values.slice(end - HOME_DAYS + 1, end + 1);
  const ends = Array.from({ length: HOME_DAYS }, (_, i) => HOME_DAYS + i);

  // Key results: the ones furthest from target first, measured before unmeasured.
  let krs: HomeDashboard['krs'] = { state: 'no_organization', items: [] };
  if (snapshot.organization?.state === 'ready') {
    const items = snapshot.organization.keyResults.map((kr) => {
      const view = krView({ progress: kr.progress });
      return {
        title: humanizeSummary(kr.title, 60).short || kr.title,
        ...(view.percent !== undefined ? { percent: view.percent } : {}),
        status: view.status,
        ...(kr.value !== undefined ? { value: kr.value } : {}),
        target: kr.target,
        ...(kr.unit ? { unit: kr.unit } : {}),
        ...(kr.direction ? { direction: kr.direction } : {}),
      };
    });
    items.sort(
      (a, b) =>
        Number(a.percent === undefined) - Number(b.percent === undefined) ||
        (a.percent ?? 0) - (b.percent ?? 0)
    );
    krs = {
      state: items.length ? 'ready' : 'no_objectives',
      ...(snapshot.organization.name ? { organizationName: snapshot.organization.name } : {}),
      items: items.slice(0, KR_LIMIT),
    };
  }

  const cost = snapshot.cost
    ? {
        totalUsd: round(snapshot.cost.totalUsd) ?? 0,
        ...(snapshot.cost.budgetUsd ? { budgetUsd: snapshot.cost.budgetUsd } : {}),
        ...(snapshot.cost.budgetUsd ? { remainingUsd: snapshot.cost.remainingUsd ?? null } : {}),
        overBudget: snapshot.cost.overBudget,
        complete: snapshot.cost.costComplete !== false && !snapshot.cost.partialNotice,
      }
    : null;

  const missionTitles = new Map(missions.map((m) => [m.missionId.toUpperCase(), m]));
  const deliverables = [...(snapshot.deliverables ?? [])]
    .filter((item) => !item.missing)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, DELIVERABLE_LIMIT)
    .map((item) => {
      const mission = item.missionId ? missionTitles.get(item.missionId.toUpperCase()) : undefined;
      const missionTitle = mission ? missionDisplayTitle(mission) : '';
      return {
        id: item.artifactId,
        title: deliverableDisplayTitle(item),
        kind: item.kind,
        ...(missionTitle ? { missionTitle } : {}),
        updatedAt: item.updatedAt,
      };
    });

  // Health is derived from the mission read: it fails with it.
  if (unavailable.has('missions')) unavailable.add('health');

  return {
    generatedAt: new Date(now).toISOString(),
    unavailable: [...unavailable],
    agents,
    missions: {
      open,
      throughput: completedPerDay,
      throughputTotal: currentCompleted,
      throughputPrevious: previousCompleted,
      blocked: blockedAll.slice(0, BLOCKED_LIMIT).map((mission) => ({
        id: mission.missionId,
        title: missionDisplayTitle(mission),
        status: mission.status,
        ...(mission.updatedAt ? { updatedAt: mission.updatedAt } : {}),
      })),
      blockedTotal: blockedAll.length,
    },
    health: {
      failureRate: ends.map((end) =>
        rate(sum(windowOf(failed14, end)), sum(windowOf(completed14, end)))
      ),
      failureRateCurrent: rate(currentFailed, currentCompleted),
      failureRatePrevious: rate(previousFailed, previousCompleted),
      durationHours: ends.map((end) => round(median(windowOf(durations14, end).flat()), 1)),
      durationCurrent: round(median(durations14.slice(HOME_DAYS).flat()), 1),
      durationPrevious: round(median(durations14.slice(0, HOME_DAYS).flat()), 1),
    },
    krs,
    cost,
    deliverables,
  };
}

function scopeList(value: string[] | 'all' | undefined): string[] | 'all' {
  return value ?? 'all';
}

/** The single tenant whose organization the KR tile shows, or none. */
function organizationTenant(viewer: ViewerContext): string | undefined | null {
  if (scopeList(viewer.projectIds) !== 'all') return null;
  if (viewer.tenantSlugs === 'all') return undefined;
  return viewer.tenantSlugs.length === 1 ? viewer.tenantSlugs[0] : null;
}

/**
 * The personal (all-company) selection: aggregate counts only. Company
 * titles — stopped missions, key results, deliverables — are dropped so Home
 * follows the same selection model as the rest of the shell.
 */
export function countsOnlyHomeDashboard(dashboard: HomeDashboard): HomeDashboard {
  return {
    ...dashboard,
    withheld: ['krs', 'deliverables'],
    missions: { ...dashboard.missions, blocked: [] },
    krs: { state: dashboard.krs.state, items: [] },
    deliverables: [],
  };
}

export interface HomeDashboardFocus {
  /**
   * One project the viewer chose to look at (already validated against its
   * scope): only missions recording exactly this project count, and only its
   * deliverables are listed. Authorization still comes from the viewer.
   */
  projectId?: string;
}

/** Reads every source once for this viewer (already narrowed to the shell's scope). */
export function collectHomeDashboard(
  viewer: ViewerContext,
  now = Date.now(),
  focus: HomeDashboardFocus = {}
): HomeDashboard {
  const failed: HomeSection[] = [];
  const read = <T>(section: HomeSection, fn: () => T): T | undefined => {
    try {
      return withViewerExecutionContext(viewer, fn);
    } catch {
      failed.push(section);
      return undefined;
    }
  };
  const tenantSlugs = viewer.tenantSlugs;
  const organizationIds = scopeList(viewer.organizationIds);
  const projectIds = scopeList(viewer.projectIds);

  // Missions are read exactly like the workspace graph (`/api/v1/workspace/*`,
  // `/w`): the governed listing as the read-only graph reader, then row-level
  // admission for this viewer (`viewerAdmitsNode`). So the counts here match
  // the rest of the shell. The chronos execution role cannot list tenant
  // mission roots (tenant-scope policy), which left the ops readers short.
  const authorization = toSurfaceAuthorizationContext(viewer);
  const missions = (() => {
    try {
      const states = withStoreGrant(
        WORKSPACE_GRAPH_READER_ROLE,
        () =>
          listMissionsInSearchDirs().flatMap(({ missionId }): MissionState[] => {
            const state = readOrNullOnMissionRefusal(() => loadState(missionId));
            return state ? [state] : [];
          }),
        { tenantSlug: '' }
      );
      return projectMissionHistoryItems(states, [], { limit: 100_000 }).filter(
        (mission) =>
          // Scope admission lets project-less missions through; a project
          // focus is an exact match, like the workspace list and needs-you.
          (!focus.projectId || mission.projectId === focus.projectId) &&
          viewerAdmitsNode(authorization, {
            kind: 'mission',
            id: mission.missionId,
            label: mission.missionId,
            status: mission.status,
            tier: mission.tier,
            ...(mission.tenantSlug ? { tenantSlug: mission.tenantSlug } : {}),
            ...(mission.organizationId ? { organizationId: mission.organizationId } : {}),
            ...(mission.projectId ? { projectId: mission.projectId } : {}),
            missionId: mission.missionId,
          })
      );
    } catch {
      failed.push('missions');
      return undefined;
    }
  })();
  const agentEntries = read('agents', () => {
    const board = buildAgentActivityBoard({
      tenant: tenantSlugs === 'all' || tenantSlugs.length !== 1 ? undefined : tenantSlugs[0],
      tenantSlugs,
      // Server-resolved system selection: company-less work, as for missions.
      ...(viewer.includeUntenanted ? { includeUntenanted: true } : {}),
    });
    return board.entries.map((entry) => ({ agent_id: entry.agent_id, status: entry.status }));
  });
  const erroredAgents = agentEntries
    ? (() => {
        try {
          const known = new Set(agentEntries.map((entry) => entry.agent_id));
          return listAgentRuntimeSnapshots()
            .filter((snapshot) => ['error', 'demoted'].includes(snapshot.agent.status || ''))
            .map((snapshot) => snapshot.agent.agentId)
            .filter((agentId) => tenantSlugs === 'all' || known.has(agentId));
        } catch {
          return [];
        }
      })()
    : undefined;

  const orgTenant = organizationTenant(viewer);
  const organization: HomeSnapshot['organization'] =
    orgTenant === null
      ? { state: 'none' }
      : read('krs', () => {
          const company = resolveCompany(orgTenant);
          const organizationId = company.company_id;
          if (organizationIds !== 'all' && !organizationIds.includes(organizationId)) {
            return { state: 'none' as const };
          }
          const view = buildOrganizationManagementView({
            organizationId,
            tier: 'confidential',
            tenantSlug: company.tenant_slug,
          });
          if (!view.purpose) return { state: 'none' as const };
          const keyResults = view.control_plane.outcome_accounting.objectives.flatMap((objective) =>
            objective.key_results.map((entry) => {
              // The declared view type is narrower than the projection, which
              // also carries target / direction / unit / value per KR.
              const kr = entry as typeof entry & {
                target?: number;
                direction?: string;
                unit?: string;
                value?: number;
              };
              return {
                title: kr.title,
                target: Number.isFinite(kr.target) ? Number(kr.target) : 0,
                ...(kr.direction ? { direction: kr.direction as KrDirection } : {}),
                ...(kr.unit ? { unit: kr.unit } : {}),
                ...(Number.isFinite(kr.value) ? { value: Number(kr.value) } : {}),
                ...(kr.progress !== undefined ? { progress: kr.progress } : {}),
              };
            })
          );
          return {
            state: 'ready' as const,
            name: view.purpose?.name || view.operational_state?.name || company.name,
            keyResults,
          };
        });

  const budget = Number(getRegisteredEnvText('CHRONOS_COST_BUDGET_USD') || '');
  // A scoped cost is attributed through the visible missions: without them
  // the total would read as a healthy $0.
  const costScopeKnown = tenantSlugs === 'all' || missions !== undefined;
  if (!costScopeKnown) failed.push('cost');
  const cost = read(
    'cost',
    () =>
      costScopeKnown &&
      collectCostSummary({
        missionIds: tenantSlugs === 'all' ? undefined : (missions ?? []).map((m) => m.missionId),
        budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : undefined,
        ...(tenantSlugs !== 'all'
          ? {
              scopeFilter: {
                tenant_slugs: tenantSlugs,
                ...(viewer.includeUntenanted ? { include_untenanted: true } : {}),
              },
            }
          : {}),
      })
  );
  const deliverables = read('deliverables', () =>
    collectDeliverableInbox({
      tierAccess: viewer.tierAccess ?? ['public', 'confidential'],
      limit: 50,
      tenantSlugs,
      ...(viewer.includeUntenanted ? { includeUntenanted: true } : {}),
      personIds: viewerPersonIds(viewer),
      organizationIds,
      projectIds: focus.projectId ? [focus.projectId] : projectIds,
    })
  );

  return composeHomeDashboard({
    now,
    missions,
    agentEntries,
    erroredAgents,
    organization,
    cost: cost || undefined,
    deliverables,
    failed,
  });
}
