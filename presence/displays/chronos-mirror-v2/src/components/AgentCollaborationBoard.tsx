'use client';

import * as React from 'react';
import type { KbFlowProps, KbSequenceProps, KbStatus } from '@agent/core/a2ui-catalog';
import {
  Badge,
  Button,
  Callout,
  Disclosure,
  KbChart,
  KeyValue,
  List,
  Metric,
  Section,
  Select,
  Skeleton,
  StatusPill,
  Tabs,
  isKbStatus,
} from '@agent/shared-ui';
import { useChronosLocale } from '../lib/hooks';
import { LiveSyncScheduler, bindVisibilityToLiveSync } from '../lib/live-sync';
import {
  parseCollaborationResponse,
  type ClientCollaborationAttentionCode,
  type ClientCollaborationProjection,
  type ClientCollaborationTree,
  type ClientCollaborationTreeNode,
  type ClientCollaborationWaitReason,
} from '../lib/collaboration-response';
import { formatElapsedDuration, shortNodeLabel } from '../lib/collaboration-tree-format';
import { uxText, type SupportedLocale } from '../lib/ux-vocabulary';
import {
  ChronosDiagram,
  ChronosFieldScope,
  ChronosInline,
  ChronosMeta,
  ChronosToolbar,
} from './chronos-ui';
import { humanizeMissionId } from './ChronosOffice';

type CollaborationProjection = ClientCollaborationProjection;

const TREE_WAIT_LABEL_KEY: Record<ClientCollaborationWaitReason, string> = {
  approval_pending: 'chronos_ac_wait_approval_pending',
  child_running: 'chronos_ac_wait_child_running',
  claim_pending: 'chronos_ac_wait_claim_pending',
  blocked: 'chronos_ac_wait_blocked',
  review_pending: 'chronos_ac_wait_review_pending',
  stale: 'chronos_ac_wait_stale',
};

interface CollaborationTreeRow {
  node: ClientCollaborationTreeNode;
  depth: number;
}

/** Pre-order walk over roots then orphans, mirroring the terminal-hud row order. */
function flattenCollaborationTreeRows(tree: ClientCollaborationTree): CollaborationTreeRow[] {
  const rows: CollaborationTreeRow[] = [];
  const walk = (node: ClientCollaborationTreeNode, depth: number): void => {
    rows.push({ node, depth });
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const node of [...tree.roots, ...tree.orphans]) walk(node, 0);
  return rows;
}

/** Newest activity first; ties (and undated roots) fall back to id order. */
function byRecentActivity(
  left: ClientCollaborationTreeNode,
  right: ClientCollaborationTreeNode
): number {
  const l = left.last_event_at ?? '';
  const r = right.last_event_at ?? '';
  return r.localeCompare(l) || left.id.localeCompare(right.id);
}

function providerRoleCell(node: ClientCollaborationTreeNode): string {
  if (node.provider && node.team_role) return `${node.provider}/${node.team_role}`;
  return node.provider || node.team_role || '-';
}

const KIND_LABEL_KEY: Record<string, string> = {
  dispatch: 'chronos_ac_kind_dispatch',
  claim: 'chronos_ac_kind_claim',
  spawn: 'chronos_ac_kind_spawn',
  progress: 'chronos_ac_kind_progress',
  waiting: 'chronos_ac_kind_waiting',
  blocked: 'chronos_ac_kind_blocked',
  handoff: 'chronos_ac_kind_handoff',
  approval: 'chronos_ac_kind_approval',
  review: 'chronos_ac_kind_review',
  artifact: 'chronos_ac_kind_artifact',
  retry: 'chronos_ac_kind_retry',
  failure: 'chronos_ac_kind_failure',
  completion: 'chronos_ac_kind_completion',
  unknown: 'chronos_ac_kind_unknown',
};

export function collaborationKindLabel(kind: string, locale: SupportedLocale): string {
  const key = KIND_LABEL_KEY[kind];
  return key ? uxText(key, locale) : kind;
}

// AC-09: `title` / `next_action` on the wire are developer-facing English —
// the board renders from `code` through this vocabulary instead.
const ATTENTION_TITLE_KEY: Record<ClientCollaborationAttentionCode, string> = {
  blocked: 'chronos_ac_attention_blocked',
  waiting_human: 'chronos_ac_attention_waiting_human',
  review_pending: 'chronos_ac_attention_review_pending',
  failure: 'chronos_ac_attention_failure',
};

const ATTENTION_NEXT_KEY: Record<ClientCollaborationAttentionCode, string> = {
  blocked: 'chronos_ac_attention_next_blocked',
  waiting_human: 'chronos_ac_attention_next_waiting_human',
  review_pending: 'chronos_ac_attention_next_review_pending',
  failure: 'chronos_ac_attention_next_failure',
};

export function collaborationAttentionTitle(
  code: ClientCollaborationAttentionCode,
  locale: SupportedLocale
): string {
  return uxText(ATTENTION_TITLE_KEY[code], locale);
}

export function collaborationAttentionNextAction(
  code: ClientCollaborationAttentionCode,
  locale: SupportedLocale
): string {
  return uxText(ATTENTION_NEXT_KEY[code], locale);
}

const ACTION_LABEL_KEY: Record<string, string> = {
  approval: 'chronos_ac_action_approval',
  failure: 'chronos_ac_action_failure',
  retry: 'chronos_ac_action_retry',
  handoff: 'chronos_ac_action_handoff',
  waiting: 'chronos_ac_action_mission',
  blocked: 'chronos_ac_action_mission',
  review: 'chronos_ac_action_mission',
};

export function collaborationActionLabel(kind: string, locale: SupportedLocale): string | null {
  const key = ACTION_LABEL_KEY[kind];
  return key ? uxText(key, locale) : null;
}

export function collaborationEvidenceRefs(
  event: { evidence_refs?: string[] } | undefined
): string[] {
  return Array.isArray(event?.evidence_refs)
    ? event.evidence_refs.filter((ref): ref is string => Boolean(ref && ref.trim())).slice(0, 3)
    : [];
}

export function buildCollaborationQuery(tenant: string, missionId: string): string {
  const params = new URLSearchParams();
  if (tenant) params.set('tenant', tenant);
  if (missionId) params.set('mission', missionId);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export type CollaborationAttentionAction =
  | {
      mode: 'view';
      viewId:
        'secret-approval-queue' | 'runtime-topology-map' | 'runtime-lease-doctor' | 'trace-viewer';
      label: string;
    }
  | { mode: 'mission'; label: string };

export function attentionActionForKind(kind: string): CollaborationAttentionAction | null {
  switch (kind) {
    case 'approval':
      return { mode: 'view', viewId: 'secret-approval-queue', label: '承認キューを開く' };
    case 'failure':
      return { mode: 'view', viewId: 'runtime-topology-map', label: 'Runtime を確認' };
    case 'retry':
      return { mode: 'view', viewId: 'runtime-lease-doctor', label: '再試行・lease診断を開く' };
    case 'handoff':
      return { mode: 'view', viewId: 'trace-viewer', label: '引き継ぎ履歴を開く' };
    case 'waiting':
    case 'blocked':
    case 'review':
      return { mode: 'mission', label: '停止・再開操作を開く' };
    default:
      return null;
  }
}

const NODE_STAGE_KEY: Record<ClientCollaborationTreeNode['type'], string> = {
  mission: 'chronos_ac_stage_mission',
  task: 'chronos_ac_stage_task',
  agent: 'chronos_ac_stage_agent',
};

const ACTIVE_NODE_STATES = new Set([
  'active',
  'busy',
  'claimed',
  'dispatched',
  'in_progress',
  'progress',
  'running',
  'started',
]);
const DONE_NODE_STATES = new Set(['complete', 'completed', 'done']);
const FAILED_NODE_STATES = new Set(['error', 'failed']);
const STOPPED_NODE_STATES = new Set(['cancelled', 'canceled']);

/** Collaboration node state (+ open waits) → canonical `ui:status-pill` status. */
export function collaborationNodeStatus(
  node: Pick<ClientCollaborationTreeNode, 'state' | 'waiting_on'>
): KbStatus | undefined {
  if (node.waiting_on.some((wait) => wait.reason === 'blocked')) return 'blocked';
  if (node.waiting_on.some((wait) => wait.reason === 'stale')) return 'stale';
  if (node.waiting_on.length > 0) return 'pending';
  const state = (node.state || '').toLowerCase();
  if (!state) return undefined;
  if (ACTIVE_NODE_STATES.has(state)) return 'working';
  if (DONE_NODE_STATES.has(state)) return 'done';
  if (FAILED_NODE_STATES.has(state)) return 'failed';
  if (STOPPED_NODE_STATES.has(state)) return 'stopped';
  return isKbStatus(state) ? state : undefined;
}

const EVENT_KIND_STATUS: Record<string, KbStatus> = {
  dispatch: 'working',
  claim: 'working',
  spawn: 'working',
  progress: 'working',
  waiting: 'pending',
  approval: 'pending',
  blocked: 'blocked',
  review: 'review',
  retry: 'degraded',
  failure: 'failed',
  completion: 'done',
};

/** Collaboration event kind → canonical status (undefined for neutral kinds such as handoff). */
export function collaborationEventStatus(kind: string): KbStatus | undefined {
  return EVENT_KIND_STATUS[kind];
}

/**
 * The collaboration tree as a `ui:flow`: mission → task → agent stages,
 * parent → child edges, status from the node state / open waits.
 */
export function buildCollaborationFlowProps(
  rows: ReadonlyArray<{ node: ClientCollaborationTreeNode }>,
  locale: SupportedLocale
): KbFlowProps {
  const nodes: KbFlowProps['nodes'] = [];
  const edges: NonNullable<KbFlowProps['edges']> = [];
  for (const { node } of rows) {
    const providerRole = providerRoleCell(node);
    const meta = [
      providerRole === '-' ? '' : providerRole,
      node.elapsed_ms === undefined ? '' : formatElapsedDuration(node.elapsed_ms),
    ]
      .filter(Boolean)
      .join(' · ');
    const status = collaborationNodeStatus(node);
    nodes.push({
      id: node.id,
      label:
        node.type === 'mission'
          ? humanizeMissionId(shortNodeLabel(node.label || node.id))
          : node.label || shortNodeLabel(node.id),
      stage: node.type,
      ...(status ? { status } : {}),
      ...(meta ? { meta } : {}),
    });
    for (const child of node.children) edges.push({ from: node.id, to: child.id });
  }
  return {
    nodes,
    edges,
    stages: (['mission', 'task', 'agent'] as const).map((id) => ({
      id,
      label: uxText(NODE_STAGE_KEY[id], locale),
    })),
    density: 'compact',
  };
}

/**
 * The latest handoff edges as a `ui:sequence` (who sent what to whom, in
 * time order), labelled with the localized event kind.
 */
export function buildCollaborationSequenceProps(
  projection: Pick<CollaborationProjection, 'edges' | 'events'>,
  locale: SupportedLocale,
  limit = 12,
  nodeTypes: ReadonlyMap<string, ClientCollaborationTreeNode['type']> = new Map()
): KbSequenceProps {
  const tsByEvent = new Map(projection.events.map((event) => [event.event_id, event.ts]));
  // Messages are exchanged between agents / humans; the structural
  // mission → task → agent edges already show in the tree, so drop them
  // whenever agent-to-agent traffic exists.
  const isStructural = (id: string) => {
    const type = nodeTypes.get(id);
    return type === 'mission' || type === 'task';
  };
  const messageEdges = projection.edges.filter(
    (edge) => !isStructural(edge.from) && !isStructural(edge.to)
  );
  const edges = (messageEdges.length > 0 ? messageEdges : projection.edges)
    .slice(-limit)
    .map((edge, index) => ({ edge, index, ts: tsByEvent.get(edge.event_id) || '' }))
    .sort((left, right) => left.ts.localeCompare(right.ts) || left.index - right.index);
  const participants: Array<{ id: string; label: string }> = [];
  const seen = new Set<string>();
  const addParticipant = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    participants.push({ id, label: shortNodeLabel(id) });
  };
  for (const { edge } of edges) {
    addParticipant(edge.from);
    addParticipant(edge.to);
  }
  return {
    participants,
    messages: edges.map(({ edge, ts }) => {
      const status = collaborationEventStatus(edge.kind);
      return {
        from: edge.from,
        to: edge.to,
        label: collaborationKindLabel(edge.kind, locale),
        ...(ts ? { at: ts.slice(11, 19) } : {}),
        ...(status ? { status } : {}),
      };
    }),
    density: 'compact',
    empty: uxText('chronos_ac_no_graph', locale),
  };
}

type BoardTab = 'attention' | 'tree' | 'messages' | 'timeline';

/** Read-only projection of human/agent collaboration state. */
export function AgentCollaborationBoard({
  tenant = '',
  onOpenMission,
  onOpenView,
}: {
  tenant?: string;
  onOpenMission?: (missionId: string) => void;
  onOpenView?: (
    viewId:
      | 'secret-approval-queue'
      | 'runtime-topology-map'
      | 'runtime-lease-doctor'
      | 'trace-viewer'
      | 'mission-control-plane'
  ) => void;
}) {
  const locale = useChronosLocale();
  const [projection, setProjection] = React.useState<CollaborationProjection | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [missionId, setMissionId] = React.useState('');
  const [refreshing, setRefreshing] = React.useState(false);
  const [expandedTreeNodeId, setExpandedTreeNodeId] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<BoardTab | null>(null);
  const schedulerRef = React.useRef<LiveSyncScheduler<CollaborationProjection> | null>(null);

  const refresh = React.useCallback(() => {
    setRefreshing(true);
    schedulerRef.current?.invalidate();
  }, []);

  const loadProjection = React.useCallback(async () => {
    const query = buildCollaborationQuery(tenant, missionId);
    const response = await fetch(`/api/collaboration${query}`, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(uxText('chronos_ac_load_error', locale));
    const parsed = parseCollaborationResponse(payload);
    if (!parsed) throw new Error(uxText('chronos_ac_load_error', locale));
    return parsed;
  }, [locale, missionId, tenant]);

  React.useEffect(() => {
    setMissionId('');
  }, [tenant]);

  React.useEffect(() => {
    const scheduler = new LiveSyncScheduler<CollaborationProjection>({
      fetchSnapshot: loadProjection,
      onSnapshot: (snapshot) => {
        setProjection(snapshot);
        setRefreshing(false);
        setError(null);
      },
      onError: (reason) => {
        setRefreshing(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      },
      isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
      debounceMs: 120,
      revisionOf: (snapshot) => snapshot.revision,
    });
    schedulerRef.current = scheduler;
    const unbindVisibility = bindVisibilityToLiveSync(scheduler);
    const eventSource =
      typeof window !== 'undefined' && 'EventSource' in window
        ? new EventSource('/api/collaboration/stream')
        : null;
    const invalidate = () => scheduler.invalidate();
    eventSource?.addEventListener('batch', invalidate);
    eventSource?.addEventListener('mission_event', invalidate);
    eventSource?.addEventListener('status_update', invalidate);
    eventSource?.addEventListener('notification', invalidate);
    eventSource?.addEventListener('step_begin', invalidate);
    eventSource?.addEventListener('step_end', invalidate);
    eventSource?.addEventListener('error', invalidate);
    scheduler.start();
    return () => {
      eventSource?.close();
      unbindVisibility();
      scheduler.stop();
      if (schedulerRef.current === scheduler) schedulerRef.current = null;
    };
  }, [loadProjection]);

  const overview = projection?.overview;
  const eventById = React.useMemo(
    () => new Map((projection?.events || []).map((event) => [event.event_id, event])),
    [projection?.events]
  );
  const missionOptions = React.useMemo(
    () =>
      Array.from(
        new Set(
          (projection?.events || [])
            .map((event) => event.mission_id)
            .filter((value): value is string => Boolean(value))
        )
      ).sort(),
    [projection?.events]
  );
  const tree = projection?.tree;
  const treeRows = React.useMemo(() => {
    if (!tree) return [];
    const sorted: ClientCollaborationTree = {
      ...tree,
      roots: [...tree.roots].sort(byRecentActivity),
      orphans: [...tree.orphans].sort(byRecentActivity),
    };
    return flattenCollaborationTreeRows(sorted);
  }, [tree]);
  const flowProps = React.useMemo(
    () => buildCollaborationFlowProps(treeRows, locale),
    [treeRows, locale]
  );
  const sequenceProps = React.useMemo(
    () =>
      projection
        ? buildCollaborationSequenceProps(
            projection,
            locale,
            12,
            new Map(
              treeRows.flatMap(({ node }) => [
                [node.id, node.type] as const,
                [shortNodeLabel(node.id), node.type] as const,
              ])
            )
          )
        : null,
    [projection, locale, treeRows]
  );
  const attentionCount = projection?.attention.length ?? 0;
  const activeTab: BoardTab = tab ?? (attentionCount > 0 ? 'attention' : 'tree');

  const waitLabels = (node: ClientCollaborationTreeNode) =>
    node.waiting_on.map((wait) => uxText(TREE_WAIT_LABEL_KEY[wait.reason], locale)).join(', ');

  const metrics: Array<{ key: string; label: string; value: number; tone?: string }> = overview
    ? [
        {
          key: 'missions',
          label: uxText('chronos_ac_stat_missions', locale),
          value: overview.missions,
        },
        { key: 'tasks', label: uxText('chronos_ac_stat_tasks', locale), value: overview.tasks },
        { key: 'agents', label: uxText('chronos_ac_stat_agents', locale), value: overview.agents },
        {
          key: 'active',
          label: uxText('chronos_ac_stat_active', locale),
          value: overview.active,
          tone: 'accent',
        },
        {
          key: 'blocked',
          label: uxText('chronos_ac_stat_blocked', locale),
          value: overview.blocked,
          tone: 'warning',
        },
        {
          key: 'waiting',
          label: uxText('chronos_ac_stat_waiting', locale),
          value: overview.waiting_human,
          tone: 'warning',
        },
        {
          key: 'review',
          label: uxText('chronos_ac_stat_review', locale),
          value: overview.review_pending,
          tone: 'info',
        },
        {
          key: 'failures',
          label: uxText('chronos_ac_stat_failures', locale),
          value: overview.failures,
          tone: 'danger',
        },
        {
          key: 'native',
          label: uxText('chronos_ac_stat_native_subagents', locale),
          value: overview.native_subagents,
        },
        {
          key: 'unavailable',
          label: uxText('chronos_ac_stat_unavailable_subagents', locale),
          value: overview.unavailable_subagents,
          tone: 'warning',
        },
      ]
    : [];

  const attentionPanel =
    projection && attentionCount > 0 ? (
      <div className="chronos-two-col">
        {projection.attention.slice(0, 6).map((item) => {
          const event = eventById.get(item.event_id);
          const evidenceRefs = collaborationEvidenceRefs(event);
          const action = attentionActionForKind(item.kind);
          const actionLabel = collaborationActionLabel(item.kind, locale);
          return (
            <Callout
              key={item.event_id}
              tone={item.code === 'failure' ? 'danger' : 'warning'}
              title={collaborationAttentionTitle(item.code, locale)}
              body={`${uxText('chronos_ac_reason', locale)}: ${item.reason}`}
            >
              <ChronosInline>
                <Badge label={collaborationKindLabel(item.kind, locale)} />
                <ChronosMeta mono>
                  {item.mission_id || uxText('chronos_ac_mission_unspecified', locale)}
                </ChronosMeta>
              </ChronosInline>
              <ChronosMeta>
                {uxText('chronos_ac_next', locale)}:{' '}
                {collaborationAttentionNextAction(item.code, locale)}
              </ChronosMeta>
              {event?.causation_id ? (
                <ChronosMeta mono>
                  {uxText('chronos_ac_cause', locale)}: {event.causation_id}
                </ChronosMeta>
              ) : null}
              {evidenceRefs.length > 0 ? (
                <ChronosMeta mono>
                  {uxText('chronos_ac_evidence', locale)}: {evidenceRefs.join(', ')}
                </ChronosMeta>
              ) : null}
              <ChronosInline>
                {item.mission_id && onOpenMission ? (
                  <Button
                    label={uxText('chronos_ac_open_mission', locale)}
                    onClick={() => onOpenMission(item.mission_id as string)}
                  />
                ) : null}
                {action?.mode === 'view' && onOpenView && actionLabel ? (
                  <Button
                    label={actionLabel}
                    variant="ghost"
                    onClick={() => onOpenView(action.viewId)}
                  />
                ) : null}
                {action?.mode === 'mission' && item.mission_id && onOpenMission && actionLabel ? (
                  <Button
                    label={actionLabel}
                    variant="ghost"
                    onClick={() => onOpenMission(item.mission_id as string)}
                  />
                ) : null}
                {evidenceRefs.length > 0 && onOpenView ? (
                  <Button
                    label={uxText('chronos_ac_open_evidence', locale)}
                    variant="ghost"
                    onClick={() => onOpenView('trace-viewer')}
                  />
                ) : null}
              </ChronosInline>
            </Callout>
          );
        })}
      </div>
    ) : (
      <p className="kb-text kb-text--muted">{uxText('chronos_ac_attention_empty', locale)}</p>
    );

  const treePanel =
    treeRows.length === 0 ? (
      <p className="kb-text kb-text--muted">{uxText('chronos_ac_tree_empty', locale)}</p>
    ) : (
      <>
        <ChronosDiagram>
          <KbChart type="ui:flow" props={flowProps as unknown as Record<string, unknown>} />
        </ChronosDiagram>
        <Disclosure summary={uxText('chronos_ac_tree_details', locale)}>
          <div className="kb-table-wrap">
            <table className="kb-table">
              <thead>
                <tr>
                  <th scope="col">{uxText('chronos_ac_tree_col_node', locale)}</th>
                  <th scope="col">{uxText('chronos_ac_tree_col_state', locale)}</th>
                  <th scope="col">{uxText('chronos_ac_tree_col_waiting', locale)}</th>
                  <th scope="col" data-align="end">
                    {uxText('chronos_ac_tree_col_elapsed', locale)}
                  </th>
                  <th scope="col">{uxText('chronos_ac_tree_col_provider', locale)}</th>
                </tr>
              </thead>
              <tbody>
                {treeRows.map(({ node, depth }) => {
                  const isExpanded = expandedTreeNodeId === node.id;
                  const status = collaborationNodeStatus(node);
                  return (
                    <React.Fragment key={node.id}>
                      <tr>
                        <td>
                          <button
                            type="button"
                            className="chronos-tree-node"
                            data-depth={Math.min(depth, 6)}
                            aria-expanded={isExpanded}
                            onClick={() => setExpandedTreeNodeId(isExpanded ? null : node.id)}
                          >
                            <span className="chronos-tree-node__stage">
                              {uxText(NODE_STAGE_KEY[node.type], locale)}
                            </span>
                            {node.label}
                          </button>
                        </td>
                        <td>
                          {status ? (
                            <StatusPill status={status} label={node.state || undefined} />
                          ) : (
                            node.state || '-'
                          )}
                        </td>
                        <td>{waitLabels(node) || '-'}</td>
                        <td data-align="end" data-mono="true">
                          {formatElapsedDuration(node.elapsed_ms)}
                        </td>
                        <td data-mono="true">{providerRoleCell(node)}</td>
                      </tr>
                      {isExpanded ? (
                        <tr>
                          <td colSpan={5}>
                            <div className="chronos-tree-detail">
                              {node.waiting_on.length === 0 && node.handoffs.length === 0 ? (
                                <ChronosMeta mono>{node.id}</ChronosMeta>
                              ) : null}
                              {node.waiting_on.map((wait, index) => (
                                <ChronosMeta key={`wait-${index}`}>
                                  {uxText(TREE_WAIT_LABEL_KEY[wait.reason], locale)}
                                  {wait.target_id ? ` → ${shortNodeLabel(wait.target_id)}` : ''}
                                  {` (${wait.since})`}
                                </ChronosMeta>
                              ))}
                              {node.handoffs.map((handoff, index) => (
                                <ChronosMeta key={`handoff-${index}`} mono>
                                  {'→ '}
                                  {shortNodeLabel(handoff.to_agent_id)}
                                  {handoff.performative ? ` (${handoff.performative})` : ''}
                                  {` ${handoff.at}`}
                                </ChronosMeta>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Disclosure>
      </>
    );

  const messagesPanel = sequenceProps ? (
    <ChronosDiagram>
      <KbChart type="ui:sequence" props={sequenceProps as unknown as Record<string, unknown>} />
    </ChronosDiagram>
  ) : null;

  const timelinePanel =
    projection && projection.events.length > 0 ? (
      <List
        variant="timeline"
        items={projection.events.slice(0, 10).map((event) => {
          const status = collaborationEventStatus(event.kind);
          const native = event.native
            ? [
                uxText('chronos_ac_native', locale),
                event.provider,
                event.native_fork ? 'fork' : 'parent',
                event.effort,
              ]
                .filter(Boolean)
                .join(' · ')
            : event.native_unavailable
              ? uxText('chronos_ac_native_unavailable', locale)
              : '';
          return {
            title: event.summary,
            meta: [
              event.ts.slice(11, 19),
              collaborationKindLabel(event.kind, locale),
              event.agent_id || event.source,
              event.task_id ? `${uxText('chronos_ac_task', locale)}: ${event.task_id}` : '',
              native,
              event.thread_id
                ? `${uxText('chronos_ac_thread', locale)}: ${event.thread_id.slice(0, 8)}`
                : '',
              collaborationEvidenceRefs(event).length > 0
                ? uxText('chronos_ac_evidence', locale)
                : '',
            ]
              .filter(Boolean)
              .join(' · '),
            ...(status ? { status, status_label: collaborationKindLabel(event.kind, locale) } : {}),
          };
        })}
      />
    ) : (
      <p className="kb-text kb-text--muted">{uxText('chronos_ac_no_graph', locale)}</p>
    );

  return (
    <Section
      title={uxText('chronos_ac_title', locale)}
      description={uxText('chronos_ac_description', locale)}
    >
      <ChronosFieldScope
        onChange={(name, value) => {
          if (name === 'mission') setMissionId(typeof value === 'string' ? value : '');
        }}
      >
        <ChronosToolbar>
          <Select
            name="mission"
            label={uxText('chronos_ac_filter_mission', locale)}
            hide_label
            value={missionId}
            options={[
              { value: '', label: uxText('chronos_ac_filter_all_missions', locale) },
              ...missionOptions.map((option) => ({ value: option, label: option })),
            ]}
          />
          <Button
            label={
              refreshing
                ? uxText('chronos_ac_refreshing', locale)
                : uxText('chronos_ac_refresh', locale)
            }
            disabled={refreshing}
            onClick={() => void refresh()}
          />
          {projection?.status_flags.includes('stale_runtime') && onOpenView ? (
            <Button
              label={uxText('chronos_ac_check_runtime', locale)}
              variant="ghost"
              onClick={() => onOpenView('runtime-topology-map')}
            />
          ) : null}
          <div className="chronos-toolbar__end">
            <ChronosInline>
              {projection?.partial ? (
                <Badge label={uxText('chronos_ac_status_attention', locale)} tone="warning" />
              ) : null}
              {(projection?.status_flags || []).map((flag) => (
                <Badge
                  key={flag}
                  tone="warning"
                  label={
                    flag === 'sequence_gap'
                      ? uxText('chronos_ac_flag_sequence_gap', locale)
                      : flag === 'stale_runtime'
                        ? uxText('chronos_ac_flag_stale_runtime', locale)
                        : uxText('chronos_ac_flag_unknown_event', locale)
                  }
                />
              ))}
              <Badge
                label={`${uxText('chronos_ac_scope', locale)}: ${
                  tenant || uxText('chronos_ac_scope_all', locale)
                }`}
              />
              {projection?.generated_at ? (
                <ChronosMeta>
                  {uxText('chronos_ac_updated', locale)} {projection.generated_at.slice(11, 19)}
                </ChronosMeta>
              ) : null}
            </ChronosInline>
          </div>
        </ChronosToolbar>
      </ChronosFieldScope>

      {error ? <Callout tone="danger" title={error} /> : null}

      {overview ? (
        <div className="chronos-metrics">
          {metrics.map((metric) => (
            <Metric
              key={metric.key}
              label={metric.label}
              value={metric.value}
              tone={metric.value > 0 && metric.tone ? (metric.tone as 'accent') : undefined}
            />
          ))}
        </div>
      ) : error ? null : (
        <Skeleton shape="card" lines={2} label={uxText('chronos_ac_loading', locale)} />
      )}

      {projection ? (
        <>
          <Tabs
            label={uxText('chronos_ac_title', locale)}
            active={activeTab}
            onSelect={(id) => setTab(id as BoardTab)}
            items={[
              {
                id: 'attention',
                label: uxText('chronos_ac_tab_attention', locale),
                count: attentionCount,
              },
              { id: 'tree', label: uxText('chronos_ac_tree', locale) },
              { id: 'messages', label: uxText('chronos_ac_tab_messages', locale) },
              { id: 'timeline', label: uxText('chronos_ac_timeline', locale) },
            ]}
          />
          {activeTab === 'attention' ? attentionPanel : null}
          {activeTab === 'tree' ? treePanel : null}
          {activeTab === 'messages' ? messagesPanel : null}
          {activeTab === 'timeline' ? timelinePanel : null}
        </>
      ) : null}

      <Disclosure summary={uxText('chronos_ac_guide_title', locale)}>
        <KeyValue
          items={[
            ['chronos_ac_guide_who', 'chronos_ac_guide_who_detail'],
            ['chronos_ac_guide_what', 'chronos_ac_guide_what_detail'],
            ['chronos_ac_guide_next', 'chronos_ac_guide_next_detail'],
            ['chronos_ac_guide_act', 'chronos_ac_guide_act_detail'],
          ].map(([labelKey, detailKey]) => ({
            label: uxText(labelKey, locale),
            value: uxText(detailKey, locale),
          }))}
        />
      </Disclosure>
    </Section>
  );
}
