/**
 * Agent session read model: provider × time blocks for the work calendar.
 *
 * Two governed stores project into the same block shape:
 *   - co-session lifecycle events (session_started/joined → left/closed, with
 *     heartbeats marking liveness) — one block per provider participant;
 *   - delegated-task records (`delegated-task-observability`) — one block per
 *     delegation, `created_at` → `completed_at`, carrying `backend_name` and
 *     the served model when the provider reported one.
 *
 * Visibility is inherited, never re-derived: the caller passes the viewer's
 * admitted tenant list; untenanted delegations are system-scope and shown to
 * server-resolved ('all') viewers only. Store access stays inside the
 * calendar's `workspace_graph_reader` grant (co-sessions) plus the
 * tenant-bound `delegation_record_store` grant each partition read assumes.
 */
import type { CoSessionActivity, CoSessionProvider } from '../workforce/co-session.js';
import { listCoSessionActivity } from '../workforce/co-session.js';
import {
  listDelegatedTaskRecords,
  type DelegatedTaskRecord,
} from '../workforce/delegated-task-observability.js';
import { listDelegationTenantPartitions } from '../workforce/delegation-store-partition.js';
import type { WorkspaceCalendarRange } from './workspace-calendar.js';

export type AgentSessionKind = 'co_session' | 'delegation';

export interface AgentSessionBlock {
  id: string;
  kind: AgentSessionKind;
  /** Provider id (`claude`, `codex`, …) or delegation backend name. */
  provider: string;
  /** The served model, when the provider reported one (delegations). */
  model?: string;
  title: string;
  /** ISO instants. `endAt` absent = still open at read time. */
  startAt: string;
  endAt?: string;
  status: string;
  participantId?: string;
  sessionId?: string;
  delegationId?: string;
  missionId?: string;
  tenantSlug?: string;
}

export interface AgentSessionSources {
  coSessions(window?: { from?: string; to?: string }): CoSessionActivity[];
  delegations(tenants: readonly string[] | 'all'): DelegatedTaskRecord[];
}

/** Production readers: the governed stores, one grant-aware opening each. */
export function defaultAgentSessionSources(): AgentSessionSources {
  return {
    coSessions: (window) => listCoSessionActivity(window),
    delegations: (tenants) => {
      const includeSystem = tenants === 'all';
      const available = listDelegationTenantPartitions();
      const scoped = tenants === 'all' ? available : available.filter((t) => tenants.includes(t));
      return listDelegatedTaskRecords({ tenants: scoped, includeSystem });
    },
  };
}

function instantMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** A block overlaps the range when start ≤ range end and end ≥ range start. */
function overlaps(startAt: string, endAt: string | undefined, from: string, to: string): boolean {
  const start = instantMs(startAt);
  const end = instantMs(endAt) ?? Number.MAX_SAFE_INTEGER;
  const lo = Date.parse(`${from}T00:00:00.000Z`);
  const hi = Date.parse(`${to}T23:59:59.999Z`);
  return start !== undefined && start <= hi && end >= lo;
}

/**
 * Per-participant windows inside one co-session: joined → left/closed. An
 * open window ends at the participant's last heartbeat, or stays open when
 * the session is still open at read time.
 */
function coSessionBlocks(
  activity: CoSessionActivity,
  range: WorkspaceCalendarRange,
  now: Date
): AgentSessionBlock[] {
  const events = [...activity.events].sort((a, b) => a.at.localeCompare(b.at));
  const windows = new Map<string, { provider: string; start: string; lastBeat?: string }>();
  const blocks: AgentSessionBlock[] = [];
  const closedAt = [...events].reverse().find((e) => e.type === 'session_closed')?.at;

  const emit = (
    key: string,
    win: { provider: string; start: string; lastBeat?: string },
    end?: string
  ) => {
    const endAt =
      end ?? win.lastBeat ?? (activity.record.status === 'closed' ? closedAt : undefined);
    if (!endAt && activity.record.status !== 'open') return;
    if (!overlaps(win.start, endAt ?? now.toISOString(), range.from, range.to)) return;
    const [provider, participantId] = key.split(':');
    blocks.push({
      id: `agent_session:co_session:${activity.record.session_id}:${key}`,
      kind: 'co_session',
      provider,
      title: activity.record.goal || activity.record.session_id,
      startAt: win.start,
      ...(endAt ? { endAt } : {}),
      status: endAt ? 'closed' : 'open',
      participantId,
      sessionId: activity.record.session_id,
    });
  };

  for (const event of events) {
    const actor = event.actor_provider as CoSessionProvider | undefined;
    const participant = (event.detail?.participant_id as string) ?? 'default';
    const key = `${actor ?? 'other'}:${participant}`;
    switch (event.type) {
      case 'session_started':
      case 'session_joined': {
        const win = windows.get(key) ?? { provider: actor ?? 'other', start: event.at };
        windows.set(key, { ...win, start: win.start ?? event.at });
        break;
      }
      case 'session_left': {
        const win = windows.get(key);
        if (win) {
          emit(key, win, event.at);
          windows.delete(key);
        }
        break;
      }
      case 'heartbeat': {
        const win = windows.get(key);
        if (win) win.lastBeat = event.at;
        else windows.set(key, { provider: actor ?? 'other', start: event.at, lastBeat: event.at });
        break;
      }
      case 'session_closed': {
        for (const [k, win] of windows) emit(k, win, event.at);
        windows.clear();
        break;
      }
      default:
        break;
    }
  }
  for (const [key, win] of windows) emit(key, win);
  return blocks;
}

function delegationBlocks(
  records: readonly DelegatedTaskRecord[],
  range: WorkspaceCalendarRange
): AgentSessionBlock[] {
  const blocks: AgentSessionBlock[] = [];
  for (const record of records) {
    const startAt = record.created_at;
    // A terminal record missing completed_at collapses to its start instant
    // rather than pretending it is still running.
    const endAt =
      record.status === 'started' ? undefined : (record.completed_at ?? record.created_at);
    if (!overlaps(startAt, endAt ?? new Date().toISOString(), range.from, range.to)) continue;
    const model = record.outcome?.served_model;
    blocks.push({
      id: `agent_session:delegation:${record.delegation_id}`,
      kind: 'delegation',
      provider: record.backend_name ?? 'unknown',
      ...(model ? { model } : {}),
      title: record.instruction.split('\n')[0]?.slice(0, 80) || record.delegation_id,
      startAt,
      ...(endAt ? { endAt } : {}),
      status: record.status,
      delegationId: record.delegation_id,
      ...(record.mission_id ? { missionId: record.mission_id } : {}),
      ...(record.tenant_slug ? { tenantSlug: record.tenant_slug } : {}),
    });
  }
  return blocks;
}

/**
 * Provider-time blocks overlapping `range`. `viewerTenants` is the admitted
 * tenant list from the viewer's SurfaceAuthorizationContext (`'all'` =
 * server-resolved / sovereign). Read failures stay inside `degraded`.
 */
export function buildAgentSessionBlocks(
  sources: AgentSessionSources,
  options: {
    range: WorkspaceCalendarRange;
    viewerTenants: readonly string[] | 'all';
    now?: Date;
  }
): { blocks: AgentSessionBlock[]; degraded: string[] } {
  const { range, viewerTenants, now = new Date() } = options;
  const degraded: string[] = [];
  let blocks: AgentSessionBlock[] = [];
  try {
    for (const activity of sources.coSessions({
      from: range.from,
      to: `${range.to}T23:59:59.999Z`,
    })) {
      blocks.push(...coSessionBlocks(activity, range, now));
    }
  } catch {
    degraded.push('co_sessions');
  }
  try {
    blocks = blocks.concat(delegationBlocks(sources.delegations(viewerTenants), range));
  } catch {
    degraded.push('delegations');
  }
  blocks.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.provider.localeCompare(b.provider));
  return { blocks, degraded: [...new Set(degraded)] };
}
