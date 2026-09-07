import { buildAgentCollaborationProjection } from '@agent/core/agent-collaboration-projection';
import {
  buildAgentActivityBoard,
  UNASSIGNED_AGENT_ID,
  type AgentActivityBoard,
  type AgentActivityBlocker,
} from '@agent/core/agent-activity-board';
import {
  composeCollaborationTree,
  flattenCollaborationTree,
  type CollaborationTree,
  type CollaborationTreeNode,
  type CollaborationWaitReason,
} from '@agent/core/agent-collaboration-tree';
import type { AgentCollaborationEvent } from '@agent/core/agent-collaboration-events';
import { collectPeerTranscriptTails, type PeerTranscriptTail } from '@agent/core/peer-conversation';
import { currentScope } from '@agent/core/scope-context';
import { pathResolver } from '@agent/core/path-resolver';
import { statusColor, theme } from '../theme.js';
import type { I18n } from '../i18n.js';
import type { PanelViewModel, DetailLine } from './types.js';
import type { VocabularyKey } from '@agent/core/t';

export const AGENT_GRAPH_RECENT_DAYS = 7;

export interface AgentGraphData {
  tree: CollaborationTree;
  events: AgentCollaborationEvent[];
  statusFlags: string[];
  truncatedSources: string[];
  /** AC-09: entries carry `blockers` (kind + reason) the tree's `waiting_on`
   * abstraction already folds into a `CollaborationWaitReason`; kept here too
   * so the node detail can show the raw blocker kind, translated. */
  activityBoard?: AgentActivityBoard;
  /** AC-11: latest lines per peer, when the tenant scope is known. */
  peerTranscripts: PeerTranscriptTail[];
}

// Both the agent-graph panel (5s poll) and the operator cockpit (15s poll,
// same shared `r`-triggered refreshNonce) load this data independently.
// A short-lived cache keeps a coincident refresh from reading the on-disk
// projection twice.
const CACHE_TTL_MS = 3000;
let cache: { at: number; promise: Promise<AgentGraphData> } | undefined;

async function loadAgentGraphUncached(): Promise<AgentGraphData> {
  // A week keeps yesterday's delegations visible after a weekend while the
  // byte cap still bounds the read; the projection's own default is 2 days.
  const projection = buildAgentCollaborationProjection({
    limit: 200,
    bounded: { recentDays: AGENT_GRAPH_RECENT_DAYS },
  });
  let activityBoard: AgentActivityBoard | undefined;
  try {
    activityBoard = buildAgentActivityBoard();
  } catch {
    // work-coordination store may be unavailable; the tree degrades to
    // event-derived waits only.
    activityBoard = undefined;
  }
  const tree = composeCollaborationTree(projection, { activityBoard });
  // AC-11: peer conversations are tenant-scoped; an unscoped operator run has
  // no tenant to look up and simply shows no peer transcripts.
  let peerTranscripts: PeerTranscriptTail[] = [];
  try {
    const tenant = currentScope().tenant_slug;
    if (tenant) peerTranscripts = collectPeerTranscriptTails(tenant, { maxPerPeer: 5 });
  } catch {
    peerTranscripts = [];
  }
  return {
    tree,
    events: projection.events,
    statusFlags: projection.status_flags,
    truncatedSources: projection.truncated_sources,
    activityBoard,
    peerTranscripts,
  };
}

export async function loadAgentGraph(): Promise<AgentGraphData> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.promise;
  const promise = loadAgentGraphUncached();
  cache = { at: now, promise };
  return promise;
}

export function agentGraphWatchPaths(): string[] {
  return [
    pathResolver.shared('logs/worker-events'),
    pathResolver.shared('observability/mission-control'),
    pathResolver.shared('runtime/work-coordination'),
  ];
}

const NODE_GLYPH: Record<CollaborationTreeNode['type'], string> = {
  mission: '◆',
  task: '▸',
  agent: '●',
};

const WAIT_REASON_KEYS: Record<CollaborationWaitReason, VocabularyKey> = {
  approval_pending: 'tui:tui_agents_wait_approval_pending',
  child_running: 'tui:tui_agents_wait_child_running',
  claim_pending: 'tui:tui_agents_wait_claim_pending',
  blocked: 'tui:tui_agents_wait_blocked',
  review_pending: 'tui:tui_agents_wait_review_pending',
  stale: 'tui:tui_agents_wait_stale',
};

/** Strip the projection's `agent:` / `human:` id prefix for a short label. */
function shortTargetLabel(targetId: string): string {
  return targetId.replace(/^(agent|human):/, '');
}

/** `12s` / `3m05s` / `1h02m` — pure, no locale dependency. */
export function formatElapsedDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '-';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${String(minutes).padStart(2, '0')}m`;
}

function collectParentTypes(
  nodes: CollaborationTreeNode[],
  parentType: CollaborationTreeNode['type'] | undefined,
  map: Map<string, CollaborationTreeNode['type']>
): void {
  for (const node of nodes) {
    if (parentType) map.set(node.id, parentType);
    collectParentTypes(node.children, node.type, map);
  }
}

function rowColor(node: CollaborationTreeNode): string {
  if (node.waiting_on.length > 0) return theme.warn;
  const state = (node.state || '').toLowerCase();
  if (state === 'failed' || state === 'failure') return theme.err;
  if (state === 'running') return theme.accent;
  return statusColor(node.state) || theme.dim;
}

function formatWaitCell(node: CollaborationTreeNode, i18n: I18n): string {
  return node.waiting_on
    .map((wait) => {
      const label = i18n.tr(WAIT_REASON_KEYS[wait.reason]);
      return wait.target_id ? `${label} → ${shortTargetLabel(wait.target_id)}` : label;
    })
    .join(',');
}

function providerRoleCell(node: CollaborationTreeNode): string {
  if (node.provider && node.team_role) return `${node.provider}/${node.team_role}`;
  return node.provider || node.team_role || '-';
}

function bareId(id: string): string {
  return id.slice(id.indexOf(':') + 1);
}

const BLOCKER_LABEL_KEYS: Record<AgentActivityBlocker['kind'], VocabularyKey> = {
  blocked: 'tui:tui_blocker_blocked',
  dependency: 'tui:tui_blocker_dependency',
  review_wait: 'tui:tui_blocker_review_wait',
  unassigned: 'tui:tui_blocker_unassigned',
};

function blockerLabel(blocker: AgentActivityBlocker, i18n: I18n): string {
  if (blocker.kind === 'dependency') {
    return i18n.tr('tui:tui_blocker_dependency', {
      ids: (blocker.dependency_ids ?? []).join(', '),
    });
  }
  return i18n.tr(BLOCKER_LABEL_KEYS[blocker.kind]);
}

/**
 * AC-09: `node.waiting_on` already folds an activity-board blocker into a
 * closed `CollaborationWaitReason`; this renders the underlying blocker
 * `kind` (and, for `unassigned`, the assignee) directly so the
 * `tui_blocker_<kind>` / `tui_agent_unassigned` vocabulary is exercised too.
 */
function activityDetailLines(
  node: CollaborationTreeNode,
  activityBoard: AgentActivityBoard | undefined,
  i18n: I18n
): DetailLine[] {
  if (!activityBoard) return [];
  const bare = bareId(node.id);
  const matches = activityBoard.entries.filter((entry) => {
    if (node.type === 'agent') return entry.agent_id === bare;
    if (node.type === 'task') return entry.task_id === bare;
    return entry.mission_id === bare;
  });
  const lines: DetailLine[] = [];
  for (const entry of matches) {
    if (entry.agent_id === UNASSIGNED_AGENT_ID) {
      lines.push({ label: 'agent', value: i18n.tr('tui:tui_agent_unassigned') });
    }
    for (const blocker of entry.blockers) {
      lines.push({ label: 'blocker', value: blockerLabel(blocker, i18n) });
    }
  }
  return lines;
}

/** `text` truncated to `maxLength` with an ellipsis marker when it overflows. */
function truncatePeerText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * AC-11: an agent node whose label is a local or remote peer id gets the
 * tail of that peer's most recent conversation appended to its detail.
 */
function peerTranscriptDetailLines(
  node: CollaborationTreeNode,
  peerTranscripts: PeerTranscriptTail[],
  i18n: I18n
): DetailLine[] {
  if (node.type !== 'agent') return [];
  const tails = peerTranscripts.filter(
    (tail) => tail.peer_id === node.label || tail.remote_peer_id === node.label
  );
  const lines: DetailLine[] = [];
  for (const tail of tails) {
    for (const line of [...tail.lines].reverse()) {
      const glyph = line.direction === 'inbound' ? '←' : '→';
      const at = line.at.length >= 16 ? line.at.slice(11, 16) : line.at;
      lines.push({
        label: i18n.tr('tui:tui_agents_peer_line'),
        value: `${at} ${glyph} ${line.sender_peer_id}: ${truncatePeerText(line.text, 120)}`,
      });
    }
  }
  return lines;
}

function eventMatchesNode(event: AgentCollaborationEvent, node: CollaborationTreeNode): boolean {
  const id = bareId(node.id);
  if (node.type === 'mission') return event.mission_id === id;
  if (node.type === 'task') return event.task_id === id;
  return event.agent_id === id;
}

function eventsDetailLines(
  events: AgentCollaborationEvent[],
  node: CollaborationTreeNode
): DetailLine[] {
  const matches = events.filter((event) => eventMatchesNode(event, node));
  return matches
    .slice(-10)
    .reverse()
    .map((event) => ({ label: 'event', value: `${event.ts} ${event.kind} ${event.summary}` }));
}

function nodeDetail(
  node: CollaborationTreeNode,
  events: AgentCollaborationEvent[],
  activityBoard: AgentActivityBoard | undefined,
  peerTranscripts: PeerTranscriptTail[],
  i18n: I18n
): DetailLine[] {
  const lines: DetailLine[] = [
    { label: 'id', value: node.id },
    { label: 'state', value: node.state ?? '-' },
    { label: 'started_at', value: node.started_at ?? '-' },
    { label: 'last_event_at', value: node.last_event_at ?? '-' },
  ];
  for (const wait of node.waiting_on) {
    const label = i18n.tr(WAIT_REASON_KEYS[wait.reason]);
    const target = wait.target_id ? ` → ${shortTargetLabel(wait.target_id)}` : '';
    lines.push({ label: 'waiting', value: `${label}${target} since ${wait.since}` });
  }
  for (const handoff of node.handoffs) {
    const performative = handoff.performative ? ` (${handoff.performative})` : '';
    lines.push({
      label: 'handoff',
      value: `→ ${shortTargetLabel(handoff.to_agent_id)}${performative} at ${handoff.at}`,
    });
  }
  lines.push(...activityDetailLines(node, activityBoard, i18n));
  lines.push(...peerTranscriptDetailLines(node, peerTranscripts, i18n));
  lines.push(...eventsDetailLines(events, node));
  return lines;
}

/** Newest activity first; ties (and undated roots) fall back to id order. */
function byRecentActivity(left: CollaborationTreeNode, right: CollaborationTreeNode): number {
  const l = left.last_event_at ?? '';
  const r = right.last_event_at ?? '';
  return r.localeCompare(l) || left.id.localeCompare(right.id);
}

export function agentGraphViewModel(data: AgentGraphData, i18n: I18n): PanelViewModel {
  const tree = {
    ...data.tree,
    roots: [...data.tree.roots].sort(byRecentActivity),
    orphans: [...data.tree.orphans].sort(byRecentActivity),
  };
  const rows = flattenCollaborationTree(tree);
  const parentTypes = new Map<string, CollaborationTreeNode['type']>();
  collectParentTypes(tree.roots, undefined, parentTypes);
  collectParentTypes(tree.orphans, undefined, parentTypes);

  const listRows = rows.map(({ node, depth }) => {
    const glyph =
      node.type === 'agent' && parentTypes.get(node.id) === 'agent'
        ? `└${NODE_GLYPH.agent}`
        : NODE_GLYPH[node.type];
    return {
      id: node.id,
      color: rowColor(node),
      cells: [
        `${'  '.repeat(depth)}${glyph} ${node.label}`,
        node.state ?? '-',
        formatWaitCell(node, i18n),
        formatElapsedDuration(node.elapsed_ms),
        providerRoleCell(node),
      ],
      detail: nodeDetail(node, data.events, data.activityBoard, data.peerTranscripts, i18n),
    };
  });

  const sections: PanelViewModel['sections'] = [];
  const waitingLines = tree.waiting.slice(0, 5).map((entry) => {
    const label = i18n.tr(WAIT_REASON_KEYS[entry.reason]);
    const since = entry.since.length >= 16 ? entry.since.slice(11, 16) : entry.since;
    return `${entry.node_id} · ${label} · since ${since}`;
  });
  sections.push({
    title: i18n.tr('tui:tui_agents_waiting'),
    lines: waitingLines.length > 0 ? waitingLines : [i18n.tr('tui:tui_agents_waiting_none')],
  });
  sections.push({
    lines: [
      i18n.tr('tui:tui_agents_stats', {
        running: tree.stats.agents_running,
        waiting: tree.stats.agents_waiting,
        done: tree.stats.agents_done,
        humans: tree.stats.humans_waited_on,
      }),
    ],
  });
  if (data.statusFlags.includes('bounded_read') && data.truncatedSources.length > 0) {
    sections.push({
      lines: [i18n.tr('tui:tui_agents_bounded', { sources: data.truncatedSources.join(', ') })],
    });
  }

  return {
    columns: [
      i18n.tr('tui:tui_agents_col_node'),
      i18n.tr('tui:tui_agents_col_state'),
      i18n.tr('tui:tui_agents_col_waiting'),
      i18n.tr('tui:tui_agents_col_elapsed'),
      i18n.tr('tui:tui_agents_col_provider'),
    ],
    rows: listRows,
    sections,
    footerHint: `Enter ${i18n.tr('tui:tui_key_detail')} · r ${i18n.tr('tui:tui_key_refresh')}`,
  };
}
