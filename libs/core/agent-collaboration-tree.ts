/**
 * AC-04: collaboration tree - a pure projection-to-tree composition.
 *
 * `agent-collaboration-projection.ts` answers "what happened" as a flat node /
 * edge graph. Operators do not need an arbitrary graph layout; they need
 * "who is doing what, and who is waiting on whom". This module folds the
 * projection into the `mission -> task -> agent -> child agent` tree the HUD
 * (AC-05) and Chronos (AC-06) both render, plus the `waiting_on` relations
 * derived from the same events.
 *
 * Invariants:
 * - No I/O. Everything is derived from the passed projection and the optional
 *   work-item activity board; `options.now` (falling back to the projection's
 *   own `generated_at`) is the only clock.
 * - Deterministic: identical input produces deep-equal output, including array
 *   order. Every collection is sorted by an explicit total order.
 * - No user-facing prose. `CollaborationWaitReason` is a closed enum; surfaces
 *   translate it (`user-facing-vocabulary.json`).
 */

import type { AgentActivityBoard } from './agent-activity-board.js';
import type { AgentCollaborationEvent } from './agent-collaboration-events.js';
import type { AgentCollaborationProjection } from './agent-collaboration-projection.js';

export type CollaborationWaitReason =
  'approval_pending' | 'child_running' | 'claim_pending' | 'blocked' | 'review_pending' | 'stale';

export interface CollaborationTreeWait {
  reason: CollaborationWaitReason;
  /** Node id (or `human:<channel>` / `work-item:<id>`) the node is waiting on. */
  target_id?: string;
  since: string;
}

export interface CollaborationTreeHandoff {
  /** Receiver's projection node id (`agent:<id>`), matching `CollaborationTreeNode.id`. */
  to_agent_id: string;
  performative?: string;
  at: string;
}

export interface CollaborationTreeNode {
  /** Same ids as the projection's nodes: `mission:<id>` | `task:<id>` | `agent:<id>`. */
  id: string;
  type: 'mission' | 'task' | 'agent';
  label: string;
  /** Latest `state_after` (or spawn-child state) the projection resolved. */
  state?: string;
  provider?: string;
  team_role?: string;
  native?: boolean;
  started_at?: string;
  last_event_at?: string;
  /** (delegation end, else terminal-state last event, else `now`) minus `started_at`. */
  elapsed_ms?: number;
  waiting_on: CollaborationTreeWait[];
  handoffs: CollaborationTreeHandoff[];
  children: CollaborationTreeNode[];
}

export interface CollaborationTreeWaitingEntry {
  node_id: string;
  reason: CollaborationWaitReason;
  since: string;
  target_id?: string;
}

export interface CollaborationTreeStats {
  missions: number;
  tasks: number;
  agents_total: number;
  agents_running: number;
  agents_waiting: number;
  agents_done: number;
  humans_waited_on: number;
}

export interface CollaborationTree {
  generated_at: string;
  /** Mission roots, id ascending. */
  roots: CollaborationTreeNode[];
  /** Tasks and agents with no mission attribution, tasks first. */
  orphans: CollaborationTreeNode[];
  /** Every `waiting_on` entry in the tree, flattened, `since` ascending. */
  waiting: CollaborationTreeWaitingEntry[];
  stats: CollaborationTreeStats;
}

export interface ComposeCollaborationTreeOptions {
  /** Clock for `elapsed_ms` / staleness. Defaults to `projection.generated_at`. */
  now?: string;
  /** Default 5 minutes. */
  staleAfterMs?: number;
  /** Work-item view, when the caller already has one; adds claim/blocked/review waits. */
  activityBoard?: AgentActivityBoard;
}

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

/** States that mean "this node is still doing work" (staleness + running counts). */
const ACTIVE_STATES = new Set([
  'active',
  'busy',
  'claimed',
  'dispatched',
  'in_progress',
  'progress',
  'running',
  'started',
  'working',
]);

/** States that mean "this node stopped"; used to close `elapsed_ms`. */
const TERMINAL_STATES = new Set([
  'archived',
  'cancelled',
  'canceled',
  'complete',
  'completed',
  'done',
  'error',
  'failed',
  'failure',
  'fallback',
  'rejected',
  'succeeded',
  'success',
  'unavailable',
]);

/** States that mean "a human answered"; used to close an approval request. */
const APPROVAL_CLOSED_STATES = new Set([
  'approved',
  'cancelled',
  'canceled',
  'declined',
  'denied',
  'expired',
  'rejected',
  'timeout',
  'withdrawn',
]);

const BLOCKED_TRIGGERS = new Set(['blocked']);
const BLOCKED_RESOLVERS = new Set(['progress', 'completion']);
const REVIEW_TRIGGERS = new Set(['review']);
const REVIEW_RESOLVERS = new Set(['completion', 'approval']);

type TreeNodeType = CollaborationTreeNode['type'];

interface TreeNodeMeta {
  id: string;
  type: TreeNodeType;
  label: string;
  state?: string;
  provider?: string;
  team_role?: string;
  native?: boolean;
  started_at?: string;
  last_event_at?: string;
  elapsed_ms?: number;
  waiting_on: CollaborationTreeWait[];
  handoffs: CollaborationTreeHandoff[];
}

interface SpawnLink {
  parent: string;
  child: string;
  since: string;
}

function nodeTypeFromId(id: string): TreeNodeType | null {
  if (id.startsWith('mission:')) return 'mission';
  if (id.startsWith('task:')) return 'task';
  if (id.startsWith('agent:')) return 'agent';
  return null;
}

function parseMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isActiveState(state: string | undefined): boolean {
  return Boolean(state && ACTIVE_STATES.has(state.toLowerCase()));
}

function isTerminalState(state: string | undefined): boolean {
  return Boolean(state && TERMINAL_STATES.has(state.toLowerCase()));
}

function addToSet(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) existing.add(value);
  else map.set(key, new Set([value]));
}

function sortedSet(map: Map<string, Set<string>>, key: string): string[] {
  return [...(map.get(key) || [])].sort((left, right) => left.localeCompare(right));
}

/**
 * The projection hands events newest-first. Re-sort ascending with the same
 * total order the projection itself uses so a hand-built projection (tests,
 * Chronos re-serialization) folds identically to a read one.
 */
function compareEvents(left: AgentCollaborationEvent, right: AgentCollaborationEvent): number {
  return left.ts.localeCompare(right.ts) || left.event_id.localeCompare(right.event_id);
}

function compareWaits(left: CollaborationTreeWait, right: CollaborationTreeWait): number {
  return (
    left.since.localeCompare(right.since) ||
    left.reason.localeCompare(right.reason) ||
    (left.target_id || '').localeCompare(right.target_id || '')
  );
}

/**
 * Is a `triggerKinds` event still open on this node, i.e. was the last one not
 * followed by a resolving event? Returns the trigger's timestamp when open.
 */
function unresolvedSince(
  events: AgentCollaborationEvent[],
  triggerKinds: ReadonlySet<string>,
  resolveKinds: ReadonlySet<string>
): string | undefined {
  let openSince: string | undefined;
  for (const event of events) {
    if (triggerKinds.has(event.kind)) openSince = event.ts;
    else if (resolveKinds.has(event.kind)) openSince = undefined;
  }
  return openSince;
}

class TreeNodeRegistry {
  readonly nodes = new Map<string, TreeNodeMeta>();

  ensure(id: string, label?: string): TreeNodeMeta | null {
    const type = nodeTypeFromId(id);
    if (!type) return null;
    const existing = this.nodes.get(id);
    if (existing) {
      if (label && !existing.label) existing.label = label;
      return existing;
    }
    const created: TreeNodeMeta = {
      id,
      type,
      label: label || id.slice(id.indexOf(':') + 1),
      waiting_on: [],
      handoffs: [],
    };
    this.nodes.set(id, created);
    return created;
  }

  get(id: string): TreeNodeMeta | undefined {
    return this.nodes.get(id);
  }
}

interface WaitSink {
  add(nodeId: string, wait: CollaborationTreeWait): void;
}

function createWaitSink(registry: TreeNodeRegistry): WaitSink {
  const seen = new Set<string>();
  return {
    add(nodeId, wait) {
      const node = registry.get(nodeId);
      if (!node) return;
      const key = `${nodeId} ${wait.reason} ${wait.target_id || ''} ${wait.since}`;
      if (seen.has(key)) return;
      seen.add(key);
      node.waiting_on.push(wait);
    },
  };
}

/**
 * Open approval requests, keyed by `request_id` (falling back to
 * `correlation_id`, then the source event id so a request that carries no
 * correlation key at all still surfaces instead of being silently dropped).
 */
function collectOpenApprovals(events: AgentCollaborationEvent[]): AgentCollaborationEvent[] {
  const open = new Map<string, AgentCollaborationEvent>();
  for (const event of events) {
    if (event.kind !== 'approval') continue;
    const key = event.request_id || event.correlation_id || event.source_event_id;
    if (APPROVAL_CLOSED_STATES.has((event.state_after || '').toLowerCase())) open.delete(key);
    else open.set(key, event);
  }
  return [...open.values()];
}

function indexEventsByNode(
  events: AgentCollaborationEvent[],
  registry: TreeNodeRegistry
): Map<string, AgentCollaborationEvent[]> {
  const byNode = new Map<string, AgentCollaborationEvent[]>();
  const push = (id: string, event: AgentCollaborationEvent): void => {
    if (!registry.ensure(id)) return;
    const bucket = byNode.get(id);
    if (bucket) bucket.push(event);
    else byNode.set(id, [event]);
  };
  for (const event of events) {
    if (event.mission_id) push(`mission:${event.mission_id}`, event);
    if (event.task_id) push(`task:${event.task_id}`, event);
    // `human:` actors are wait targets, never tree nodes.
    if (event.agent_id && event.actor_type !== 'human') push(`agent:${event.agent_id}`, event);
  }
  return byNode;
}

/** `state` fallback for an agent the projection never stamped a state on. */
function deriveAgentState(events: AgentCollaborationEvent[]): string | undefined {
  let derived: string | undefined;
  for (const event of events) {
    if (event.kind === 'failure') derived = 'failed';
    else if (event.kind === 'completion') derived = 'done';
    else if (['spawn', 'dispatch', 'claim', 'progress'].includes(event.kind)) derived = 'running';
  }
  return derived;
}

export function composeCollaborationTree(
  projection: AgentCollaborationProjection,
  options: ComposeCollaborationTreeOptions = {}
): CollaborationTree {
  const generatedAt = options.now ?? projection.generated_at;
  const nowMs = parseMs(generatedAt);
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const events = [...projection.events].sort(compareEvents);
  const eventById = new Map(events.map((event) => [event.event_id, event]));

  const registry = new TreeNodeRegistry();
  for (const node of projection.nodes) {
    const meta = registry.ensure(node.id, node.label);
    if (meta && node.state) meta.state = node.state;
  }
  const eventsByNode = indexEventsByNode(events, registry);

  // --- per-node scalars ----------------------------------------------------
  const delegationEndTs = new Map<string, string>();
  const childDelegation = new Map<string, string>();
  for (const event of events) {
    if (!event.delegation_id) continue;
    if (event.kind === 'spawn') {
      if (event.agent_id) childDelegation.set(`agent:${event.agent_id}`, event.delegation_id);
    } else {
      delegationEndTs.set(event.delegation_id, event.ts);
    }
  }
  for (const [nodeId, nodeEvents] of eventsByNode) {
    const meta = registry.get(nodeId);
    if (!meta) continue;
    meta.started_at = nodeEvents[0]?.ts;
    meta.last_event_at = nodeEvents[nodeEvents.length - 1]?.ts;
    if (meta.type === 'agent') {
      for (const event of nodeEvents) {
        if (event.provider) meta.provider = event.provider;
        if (event.team_role) meta.team_role = event.team_role;
        if (event.native !== undefined) meta.native = event.native;
      }
      if (!meta.state) meta.state = deriveAgentState(nodeEvents);
    }
  }
  for (const meta of registry.nodes.values()) {
    const startedMs = parseMs(meta.started_at);
    if (startedMs === undefined || nowMs === undefined) continue;
    const delegationId = childDelegation.get(meta.id);
    const endTs =
      (delegationId ? delegationEndTs.get(delegationId) : undefined) ??
      (isTerminalState(meta.state) ? meta.last_event_at : undefined);
    meta.elapsed_ms = Math.max(0, (parseMs(endTs) ?? nowMs) - startedMs);
  }

  // --- edges ---------------------------------------------------------------
  const missionTasks = new Map<string, Set<string>>();
  const taskMissions = new Map<string, Set<string>>();
  const taskAgents = new Map<string, Set<string>>();
  const agentTasks = new Map<string, Set<string>>();
  const rawSpawns: SpawnLink[] = [];
  const handoffSeen = new Set<string>();
  for (const edge of projection.edges) {
    const fromType = nodeTypeFromId(edge.from);
    const toType = nodeTypeFromId(edge.to);
    if (!fromType || !toType) continue;
    if (fromType === 'mission' && toType === 'task') {
      registry.ensure(edge.from);
      registry.ensure(edge.to);
      addToSet(missionTasks, edge.from, edge.to);
      addToSet(taskMissions, edge.to, edge.from);
      continue;
    }
    if (fromType === 'task' && toType === 'agent') {
      registry.ensure(edge.from);
      registry.ensure(edge.to);
      addToSet(taskAgents, edge.from, edge.to);
      addToSet(agentTasks, edge.to, edge.from);
      continue;
    }
    if (fromType !== 'agent' || toType !== 'agent') continue;
    const at = eventById.get(edge.event_id)?.ts;
    if (!at) continue;
    if (edge.kind === 'spawn') {
      if (edge.from === edge.to) continue;
      registry.ensure(edge.from);
      registry.ensure(edge.to);
      rawSpawns.push({ parent: edge.from, child: edge.to, since: at });
      continue;
    }
    if (edge.kind !== 'handoff') continue;
    const sender = registry.ensure(edge.from);
    registry.ensure(edge.to);
    if (!sender) continue;
    const performative = eventById.get(edge.event_id)?.performative;
    const key = `${edge.from} ${edge.to} ${performative || ''} ${at}`;
    if (handoffSeen.has(key)) continue;
    handoffSeen.add(key);
    sender.handoffs.push({ to_agent_id: edge.to, ...(performative ? { performative } : {}), at });
  }
  for (const meta of registry.nodes.values()) {
    meta.handoffs.sort(
      (left, right) =>
        left.at.localeCompare(right.at) ||
        left.to_agent_id.localeCompare(right.to_agent_id) ||
        (left.performative || '').localeCompare(right.performative || '')
    );
  }

  /**
   * Total order over agents (`started_at` ascending, then id). Agents that only
   * ever appear as a `parent_agent_id` have no events and therefore no
   * `started_at`; they sort first, which is what makes them the parent side of
   * their spawn edge below.
   */
  const compareAgents = (left: string, right: string): number => {
    const leftStart = registry.get(left)?.started_at || '';
    const rightStart = registry.get(right)?.started_at || '';
    return leftStart.localeCompare(rightStart) || left.localeCompare(right);
  };

  /**
   * Cycle-proofing: keep a spawn edge only when it points forward in the total
   * order above. A spawn loop (A -> B, B -> A) therefore never becomes a tree
   * cycle - the back edge is dropped structurally rather than detected
   * mid-walk. The recursion below still carries a visited-path guard as a
   * second line of defence.
   */
  const spawnChildren = new Map<string, Set<string>>();
  const spawnParents = new Map<string, Set<string>>();
  const spawnSince = new Map<string, string>();
  for (const link of [...rawSpawns].sort(
    (left, right) =>
      left.parent.localeCompare(right.parent) ||
      left.child.localeCompare(right.child) ||
      left.since.localeCompare(right.since)
  )) {
    if (compareAgents(link.parent, link.child) >= 0) continue;
    addToSet(spawnChildren, link.parent, link.child);
    addToSet(spawnParents, link.child, link.parent);
    const key = `${link.parent} ${link.child}`;
    const previous = spawnSince.get(key);
    if (previous === undefined || link.since < previous) spawnSince.set(key, link.since);
  }

  // --- waits ---------------------------------------------------------------
  const waits = createWaitSink(registry);
  const openApprovals = collectOpenApprovals(events);
  for (const request of openApprovals) {
    const wait: CollaborationTreeWait = {
      reason: 'approval_pending',
      target_id: request.channel ? `human:${request.channel}` : 'human:operator',
      since: request.ts,
    };
    if (request.agent_id && request.actor_type !== 'human') {
      waits.add(`agent:${request.agent_id}`, { ...wait });
    }
    if (request.mission_id) waits.add(`mission:${request.mission_id}`, { ...wait });
  }
  for (const [parent, children] of spawnChildren) {
    for (const child of children) {
      if (!isActiveState(registry.get(child)?.state)) continue;
      waits.add(parent, {
        reason: 'child_running',
        target_id: child,
        since: spawnSince.get(`${parent} ${child}`) || registry.get(child)?.started_at || '',
      });
    }
  }
  for (const [nodeId, nodeEvents] of eventsByNode) {
    const blockedSince = unresolvedSince(nodeEvents, BLOCKED_TRIGGERS, BLOCKED_RESOLVERS);
    if (blockedSince) waits.add(nodeId, { reason: 'blocked', since: blockedSince });
    const reviewSince = unresolvedSince(nodeEvents, REVIEW_TRIGGERS, REVIEW_RESOLVERS);
    if (reviewSince) waits.add(nodeId, { reason: 'review_pending', since: reviewSince });
  }
  for (const entry of options.activityBoard?.entries || []) {
    // Attach to the deepest node the projection actually knows about; a board
    // row for a task/agent that produced no events has nothing to hang on.
    const nodeId = [
      entry.agent_id ? `agent:${entry.agent_id}` : undefined,
      entry.task_id ? `task:${entry.task_id}` : undefined,
      entry.mission_id ? `mission:${entry.mission_id}` : undefined,
    ].find((candidate) => candidate && registry.get(candidate));
    if (!nodeId) continue;
    for (const blocker of entry.blockers) {
      const reason: CollaborationWaitReason =
        blocker.kind === 'unassigned'
          ? 'claim_pending'
          : blocker.kind === 'review_wait'
            ? 'review_pending'
            : 'blocked';
      waits.add(nodeId, {
        reason,
        target_id: `work-item:${entry.item_id}`,
        since: entry.updated_at,
      });
    }
  }
  if (nowMs !== undefined) {
    for (const meta of registry.nodes.values()) {
      if (!isActiveState(meta.state) || !meta.last_event_at) continue;
      const lastMs = parseMs(meta.last_event_at);
      if (lastMs === undefined || nowMs - lastMs <= staleAfterMs) continue;
      waits.add(meta.id, { reason: 'stale', since: meta.last_event_at });
    }
  }
  for (const meta of registry.nodes.values()) meta.waiting_on.sort(compareWaits);

  // --- assembly ------------------------------------------------------------
  const agentMissionsCache = new Map<string, string[]>();
  const resolveAgentMissions = (agentId: string, path: ReadonlySet<string>): string[] => {
    const cached = agentMissionsCache.get(agentId);
    if (cached) return cached;
    if (path.has(agentId)) return [];
    const own = new Set<string>();
    for (const event of eventsByNode.get(agentId) || []) {
      if (event.mission_id) own.add(`mission:${event.mission_id}`);
    }
    for (const taskId of agentTasks.get(agentId) || []) {
      for (const missionId of taskMissions.get(taskId) || []) own.add(missionId);
    }
    if (own.size === 0) {
      // A dispatcher that only ever appears as `parent_agent_id` has no events
      // of its own; inherit the mission attribution of whatever it spawned.
      const nextPath = new Set(path).add(agentId);
      for (const child of spawnChildren.get(agentId) || []) {
        for (const missionId of resolveAgentMissions(child, nextPath)) own.add(missionId);
      }
    }
    const resolved = [...own].sort((left, right) => left.localeCompare(right));
    agentMissionsCache.set(agentId, resolved);
    return resolved;
  };

  const toNode = (
    meta: TreeNodeMeta,
    children: CollaborationTreeNode[]
  ): CollaborationTreeNode => ({
    id: meta.id,
    type: meta.type,
    label: meta.label,
    ...(meta.state ? { state: meta.state } : {}),
    ...(meta.provider ? { provider: meta.provider } : {}),
    ...(meta.team_role ? { team_role: meta.team_role } : {}),
    ...(meta.native !== undefined ? { native: meta.native } : {}),
    ...(meta.started_at ? { started_at: meta.started_at } : {}),
    ...(meta.last_event_at ? { last_event_at: meta.last_event_at } : {}),
    ...(meta.elapsed_ms !== undefined ? { elapsed_ms: meta.elapsed_ms } : {}),
    waiting_on: meta.waiting_on.map((wait) => ({ ...wait })),
    handoffs: meta.handoffs.map((handoff) => ({ ...handoff })),
    children,
  });

  const buildAgent = (agentId: string, path: ReadonlySet<string>): CollaborationTreeNode | null => {
    const meta = registry.get(agentId);
    if (!meta) return null;
    if (path.has(agentId)) return toNode(meta, []);
    const nextPath = new Set(path).add(agentId);
    return toNode(
      meta,
      [...(spawnChildren.get(agentId) || [])]
        .sort(compareAgents)
        .map((child) => buildAgent(child, nextPath))
        .filter((node): node is CollaborationTreeNode => node !== null)
    );
  };

  const buildTask = (taskId: string): CollaborationTreeNode | null => {
    const meta = registry.get(taskId);
    if (!meta) return null;
    const assigned = taskAgents.get(taskId) || new Set<string>();
    // An agent whose spawn parent is assigned to the same task is rendered
    // under that parent instead of a second time directly under the task.
    const direct = [...assigned].filter(
      (agentId) => ![...(spawnParents.get(agentId) || [])].some((parent) => assigned.has(parent))
    );
    return toNode(
      meta,
      direct
        .sort(compareAgents)
        .map((agentId) => buildAgent(agentId, new Set<string>()))
        .filter((node): node is CollaborationTreeNode => node !== null)
    );
  };

  const missionAgents = new Map<string, Set<string>>();
  const orphanAgents: string[] = [];
  for (const meta of registry.nodes.values()) {
    if (meta.type !== 'agent' || spawnParents.has(meta.id)) continue;
    if ((agentTasks.get(meta.id)?.size || 0) > 0) continue;
    const missions = resolveAgentMissions(meta.id, new Set<string>());
    if (missions.length === 0) orphanAgents.push(meta.id);
    else for (const missionId of missions) addToSet(missionAgents, missionId, meta.id);
  }

  const roots = [...registry.nodes.values()]
    .filter((meta) => meta.type === 'mission')
    .map((meta) => meta.id)
    .sort((left, right) => left.localeCompare(right))
    .map((missionId) => {
      const meta = registry.get(missionId) as TreeNodeMeta;
      return toNode(meta, [
        ...sortedSet(missionTasks, missionId)
          .map((taskId) => buildTask(taskId))
          .filter((node): node is CollaborationTreeNode => node !== null),
        ...[...(missionAgents.get(missionId) || [])]
          .sort(compareAgents)
          .map((agentId) => buildAgent(agentId, new Set<string>()))
          .filter((node): node is CollaborationTreeNode => node !== null),
      ]);
    });

  const orphans = [
    ...[...registry.nodes.values()]
      .filter((meta) => meta.type === 'task' && !taskMissions.has(meta.id))
      .map((meta) => meta.id)
      .sort((left, right) => left.localeCompare(right))
      .map((taskId) => buildTask(taskId))
      .filter((node): node is CollaborationTreeNode => node !== null),
    ...orphanAgents
      .sort(compareAgents)
      .map((agentId) => buildAgent(agentId, new Set<string>()))
      .filter((node): node is CollaborationTreeNode => node !== null),
  ];

  // --- stats and flattened waiting list ------------------------------------
  const tree: CollaborationTree = {
    generated_at: generatedAt,
    roots,
    orphans,
    waiting: [],
    stats: {
      missions: 0,
      tasks: 0,
      agents_total: 0,
      agents_running: 0,
      agents_waiting: 0,
      agents_done: 0,
      humans_waited_on: openApprovals.length,
    },
  };
  const seenMissions = new Set<string>();
  const seenTasks = new Set<string>();
  const seenAgents = new Set<string>();
  const runningAgents = new Set<string>();
  const waitingAgents = new Set<string>();
  const doneAgents = new Set<string>();
  const waitingSeen = new Set<string>();
  const waiting: CollaborationTreeWaitingEntry[] = [];
  for (const { node } of flattenCollaborationTree(tree)) {
    if (node.type === 'mission') seenMissions.add(node.id);
    if (node.type === 'task') seenTasks.add(node.id);
    if (node.type === 'agent') {
      seenAgents.add(node.id);
      if (isActiveState(node.state)) runningAgents.add(node.id);
      if (isTerminalState(node.state)) doneAgents.add(node.id);
      if (node.waiting_on.length > 0) waitingAgents.add(node.id);
    }
    for (const wait of node.waiting_on) {
      const key = `${node.id} ${wait.reason} ${wait.target_id || ''} ${wait.since}`;
      if (waitingSeen.has(key)) continue;
      waitingSeen.add(key);
      waiting.push({
        node_id: node.id,
        reason: wait.reason,
        since: wait.since,
        ...(wait.target_id ? { target_id: wait.target_id } : {}),
      });
    }
  }
  waiting.sort(
    (left, right) =>
      left.since.localeCompare(right.since) ||
      left.node_id.localeCompare(right.node_id) ||
      left.reason.localeCompare(right.reason) ||
      (left.target_id || '').localeCompare(right.target_id || '')
  );
  tree.waiting = waiting;
  tree.stats = {
    missions: seenMissions.size,
    tasks: seenTasks.size,
    agents_total: seenAgents.size,
    agents_running: runningAgents.size,
    agents_waiting: waitingAgents.size,
    agents_done: doneAgents.size,
    humans_waited_on: openApprovals.length,
  };
  return tree;
}

/**
 * Pre-order walk over `roots` then `orphans` - the row order the HUD renders.
 * `depth` is 0 for a root/orphan and increases by one per nesting level.
 */
export function flattenCollaborationTree(
  tree: CollaborationTree
): Array<{ node: CollaborationTreeNode; depth: number }> {
  const rows: Array<{ node: CollaborationTreeNode; depth: number }> = [];
  const walk = (node: CollaborationTreeNode, depth: number): void => {
    rows.push({ node, depth });
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const node of [...tree.roots, ...tree.orphans]) walk(node, 0);
  return rows;
}
