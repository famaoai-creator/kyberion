/**
 * Work calendar read model (MSN-CALENDAR-SOURCES-20261121): every dated thing
 * a viewer may see, as calendar days in one range.
 *
 *   - work items: their `start_date` / `due_date` (graph facts);
 *   - organization operations: the next scheduled run and the monthly
 *     business-day deadline (existing runtime projections);
 *   - meeting action items: their `due_at`.
 *
 * Visibility is inherited, never re-derived: an operation is read only for an
 * organization node, and an action item only for a mission node, that is in
 * the viewer-filtered workspace graph (`filterWorkspaceGraph`). No store of a
 * scope the viewer cannot see is opened. The readers run under the same
 * `workspace_graph_reader` store grant as the graph.
 */
import { withStoreGrant } from '../authority.js';
import { isCalendarDate } from '../foundation/time.js';
import { listActionItems, type ActionItem } from '../meeting/action-item-store.js';
import {
  listOrganizationOperationRuns,
  listOrganizationOperations,
  listOrganizationOperationStates,
} from '../organization/organization-operating-model-operations.js';
import type {
  OrganizationOperationRecord,
  OrganizationOperationRun,
  OrganizationOperationState,
  OrganizationTier,
} from '../organization/organization-operating-model.js';
import {
  organizationOperationDeadlineProjection,
  organizationOperationDueProjection,
} from '../organization/organization-operation-runtime.js';
import { calendarDateInZone, nthBusinessDayOfMonthClamped } from '../temporal/business-calendar.js';
import {
  WORKSPACE_GRAPH_READER_ROLE,
  type GraphNode,
  type WorkspaceGraph,
} from './workspace-graph.js';

/** Longest range one read may cover (a month grid is 42 days). */
export const WORKSPACE_CALENDAR_MAX_DAYS = 92;

export type WorkspaceCalendarSource =
  'work_item' | 'operation_run' | 'operation_deadline' | 'action_item';

export interface WorkspaceCalendarEntry {
  source: WorkspaceCalendarSource;
  /** Unique within one result (`<source>:<record id>[:<day>]`). */
  id: string;
  title: string;
  /** The calendar day the entry falls on (`YYYY-MM-DD`). */
  date: string;
  /** Work items with a start day: the first day of the span. */
  startDate?: string;
  /** Finished: a done work item, a met deadline, a completed action item. */
  done: boolean;
  /** A deadline that was missed (finished late or not at all). */
  missed?: boolean;
  /** Where the entry is managed. */
  link: { kind: 'work_item' | 'organization' | 'mission'; id: string };
  status?: string;
  tenantSlug?: string;
  organizationId?: string;
  missionId?: string;
}

export interface WorkspaceCalendarSources {
  operations(scope: OrganizationScope): {
    operations: OrganizationOperationRecord[];
    states: OrganizationOperationState[];
    runs: OrganizationOperationRun[];
  };
  actionItems(missionId: string): ActionItem[];
}

export interface OrganizationScope {
  organizationId: string;
  tier: OrganizationTier;
  tenantSlug?: string;
}

export function defaultWorkspaceCalendarSources(): WorkspaceCalendarSources {
  const read = <T>(fn: () => T): T =>
    withStoreGrant(WORKSPACE_GRAPH_READER_ROLE, fn, { tenantSlug: '' });
  return {
    operations: (scope) =>
      read(() => {
        const query = {
          organizationId: scope.organizationId,
          tier: scope.tier,
          ...(scope.tenantSlug ? { tenantSlug: scope.tenantSlug } : {}),
        };
        return {
          operations: listOrganizationOperations(query),
          states: listOrganizationOperationStates(query),
          runs: listOrganizationOperationRuns(query),
        };
      }),
    actionItems: (missionId) => read(() => listActionItems(missionId)),
  };
}

export interface WorkspaceCalendarRange {
  from: string;
  to: string;
}

/** The range, validated: real days, from ≤ to, at most the cap. */
export function parseWorkspaceCalendarRange(from: unknown, to: unknown): WorkspaceCalendarRange {
  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    throw new Error('from and to must be calendar dates (YYYY-MM-DD)');
  }
  if (from > to) throw new Error('from must not be after to');
  if (dayNumber(to) - dayNumber(from) + 1 > WORKSPACE_CALENDAR_MAX_DAYS) {
    throw new Error(`a calendar range covers at most ${WORKSPACE_CALENDAR_MAX_DAYS} days`);
  }
  return { from, to };
}

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00.000Z`) / 86_400_000);
}

function inRange(date: string | undefined, range: WorkspaceCalendarRange): boolean {
  return Boolean(date) && (date as string) >= range.from && (date as string) <= range.to;
}

function zoneDay(instant: string | Date, timeZone: string | undefined): string | undefined {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return undefined;
  try {
    const day = calendarDateInZone(date, timeZone || 'UTC');
    return isoDay(day.year, day.month, day.day);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function isoDay(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The months (year, month) that touch the range, in order. */
function monthsIn(range: WorkspaceCalendarRange): Array<{ year: number; month: number }> {
  const months: Array<{ year: number; month: number }> = [];
  let year = Number(range.from.slice(0, 4));
  let month = Number(range.from.slice(5, 7));
  const endKey = range.to.slice(0, 7);
  while (`${year}-${String(month).padStart(2, '0')}` <= endKey) {
    months.push({ year, month });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

function workItemEntries(nodes: readonly GraphNode[], range: WorkspaceCalendarRange) {
  const entries: WorkspaceCalendarEntry[] = [];
  for (const node of nodes) {
    if (node.kind !== 'work_item') continue;
    const due = typeof node.facts?.due_date === 'string' ? node.facts.due_date : undefined;
    const start = typeof node.facts?.start_date === 'string' ? node.facts.start_date : undefined;
    const date = due ?? start;
    // A span that crosses the range still belongs on it (week view shows it underway).
    const touches =
      inRange(due, range) ||
      inRange(start, range) ||
      Boolean(start && due && start < range.from && due > range.to);
    if (!date || !touches) continue;
    entries.push({
      source: 'work_item',
      id: `work_item:${node.id}`,
      title: node.label,
      date,
      ...(start && due ? { startDate: start } : {}),
      done: node.status === 'done' || node.status === 'archived',
      ...(node.status ? { status: node.status } : {}),
      link: { kind: 'work_item', id: node.id },
      ...scopeOf(node),
    });
  }
  return entries;
}

function scopeOf(node: GraphNode) {
  return {
    ...(node.tenantSlug ? { tenantSlug: node.tenantSlug } : {}),
    ...(node.organizationId ? { organizationId: node.organizationId } : {}),
    ...(node.missionId ? { missionId: node.missionId } : {}),
  };
}

function operationEntries(
  org: GraphNode,
  data: ReturnType<WorkspaceCalendarSources['operations']>,
  range: WorkspaceCalendarRange,
  now: Date
): WorkspaceCalendarEntry[] {
  const entries: WorkspaceCalendarEntry[] = [];
  const stateOf = new Map(data.states.map((state) => [state.operation_id, state]));
  for (const operation of data.operations) {
    if (operation.status !== 'active') continue;
    const timeZone = operation.trigger.timezone;
    const base = {
      link: { kind: 'organization' as const, id: org.id },
      ...scopeOf(org),
      organizationId: operation.organization_id,
    };
    const due = organizationOperationDueProjection(
      operation,
      stateOf.get(operation.operation_id) ?? null,
      now
    );
    const runDay = due.next_due_at ? zoneDay(due.next_due_at, timeZone) : undefined;
    if (runDay && inRange(runDay, range)) {
      entries.push({
        source: 'operation_run',
        id: `operation_run:${operation.organization_id}:${operation.operation_id}`,
        title: operation.name,
        date: runDay,
        done: false,
        status: due.due_status,
        ...base,
      });
    }
    if (!operation.deadline || !timeZone) continue;
    const runs = data.runs.filter((run) => run.operation_id === operation.operation_id);
    const today = zoneDay(now, timeZone)!;
    for (const { year, month } of monthsIn(range)) {
      const business = nthBusinessDayOfMonthClamped(year, month, operation.deadline.business_day);
      const day = isoDay(business.year, business.month, business.day);
      if (!inRange(day, range)) continue;
      // Judge each period as of its own end (past), now (current) or not yet (future).
      const monthKey = `${year}-${String(month).padStart(2, '0')}`;
      const current = today.slice(0, 7);
      const asOf =
        monthKey < current
          ? new Date(Date.UTC(year, month, 0, 12, 0, 0))
          : monthKey === current
            ? now
            : null;
      const projection = asOf
        ? organizationOperationDeadlineProjection(operation, runs, asOf)
        : undefined;
      const status = projection?.status ?? 'upcoming';
      entries.push({
        source: 'operation_deadline',
        id: `operation_deadline:${operation.organization_id}:${operation.operation_id}:${day}`,
        title: operation.name,
        date: day,
        done: status === 'met',
        ...(status === 'missed' ? { missed: true } : {}),
        status,
        ...base,
      });
    }
  }
  return entries;
}

function actionItemEntries(
  mission: GraphNode,
  items: readonly ActionItem[],
  range: WorkspaceCalendarRange
): WorkspaceCalendarEntry[] {
  const entries: WorkspaceCalendarEntry[] = [];
  for (const item of items) {
    if (!item.due_at || item.status === 'cancelled') continue;
    const day = isCalendarDate(item.due_at) ? item.due_at : zoneDay(item.due_at, 'UTC');
    if (!day || !inRange(day, range)) continue;
    entries.push({
      source: 'action_item',
      id: `action_item:${item.mission_id}:${item.item_id}`,
      title: item.title,
      date: day,
      done: item.status === 'completed',
      status: item.status,
      link: { kind: 'mission', id: mission.id },
      ...scopeOf(mission),
    });
  }
  return entries;
}

export interface WorkspaceCalendarFilter {
  tenantSlug?: string;
  organizationId?: string;
  projectId?: string;
  missionId?: string;
}

function narrowed(node: GraphNode, filter: WorkspaceCalendarFilter): boolean {
  return (
    (!filter.tenantSlug || node.tenantSlug === filter.tenantSlug) &&
    (!filter.organizationId || node.organizationId === filter.organizationId) &&
    (!filter.projectId || node.projectId === filter.projectId) &&
    (!filter.missionId || node.missionId === filter.missionId)
  );
}

/**
 * Every dated entry in `range`. `graph` must already be viewer-filtered; it
 * decides which organizations and missions are read at all. A store that fails
 * to read is reported in `degraded` and leaves the other sources intact.
 */
export function buildWorkspaceCalendar(
  graph: WorkspaceGraph,
  sources: WorkspaceCalendarSources,
  options: { range: WorkspaceCalendarRange; filter?: WorkspaceCalendarFilter; now?: Date }
): { entries: WorkspaceCalendarEntry[]; degraded: string[] } {
  const { range, filter = {}, now = new Date() } = options;
  const nodes = graph.nodes.filter((node) => narrowed(node, filter));
  const degraded: string[] = [];
  const entries = workItemEntries(nodes, range);
  // Operations belong to an organization, not to a project or mission.
  if (!filter.projectId && !filter.missionId) {
    for (const org of nodes) {
      if (org.kind !== 'organization') continue;
      try {
        const data = sources.operations({
          organizationId: org.id,
          tier: (org.tier ?? 'confidential') as OrganizationTier,
          ...(org.tenantSlug ? { tenantSlug: org.tenantSlug } : {}),
        });
        entries.push(...operationEntries(org, data, range, now));
      } catch {
        degraded.push('operations');
      }
    }
  }
  for (const mission of nodes) {
    if (mission.kind !== 'mission') continue;
    try {
      entries.push(...actionItemEntries(mission, sources.actionItems(mission.id), range));
    } catch {
      degraded.push('action_items');
    }
  }
  entries.sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      left.source.localeCompare(right.source) ||
      left.title.localeCompare(right.title)
  );
  return { entries, degraded: [...new Set(degraded)] };
}
