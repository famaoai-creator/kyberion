'use client';

import * as React from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import {
  Badge,
  Button,
  Callout,
  Disclosure,
  List,
  Metric,
  Section,
  StatusPill,
  Tabs,
} from '@agent/shared-ui';
import { useChronosLocale } from '../lib/hooks';
import { uxMessage, uxText, uxTextOr, type SupportedLocale } from '../lib/ux-vocabulary';
import {
  parseWorkItemMutationResponse,
  parseWorkItemsResponse,
  type ClientWorkItem,
  type ClientWorkItemLineage,
} from '../lib/workitems-response';
import {
  parseWorkCoordinationResponse,
  type ClientWorkCoordinationSummary,
} from '../lib/intelligence-work-coordination-response';

type WorkItem = ClientWorkItem;
type WorkItemLineage = ClientWorkItemLineage;

type WorkCoordinationSummary = ClientWorkCoordinationSummary;

const STATUS_LABEL_KEY: Record<string, string> = {
  backlog: 'chronos_status_backlog',
  ready: 'chronos_status_ready',
  in_progress: 'chronos_status_in_progress',
  blocked: 'chronos_blocked_count',
  review: 'chronos_status_review',
  done: 'chronos_status_done',
  archived: 'chronos_status_archived',
};

function metadataText(
  metadata: Record<string, unknown> | undefined,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function missionIdFromItem(item: WorkItem): string | null {
  const label = item.labels.find((entry) => entry.startsWith('mission:'));
  return (
    item.context?.mission_id || (label ? label.slice('mission:'.length) : item.project_id || null)
  );
}

function compactDate(value: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

export function WorkItemsWorkspace({
  onOpenMission,
  tenant,
  organizationId,
  projectId,
}: {
  onOpenMission?: (missionId: string) => void;
  tenant?: string;
  organizationId?: string;
  projectId?: string;
}) {
  const locale = useChronosLocale();
  const [items, setItems] = React.useState<WorkItem[]>([]);
  const [statuses, setStatuses] = React.useState<string[]>([]);
  const [coordination, setCoordination] = React.useState<WorkCoordinationSummary | null>(null);
  const [projection, setProjection] = React.useState<{
    scope: string;
    view: string;
    quality?: {
      explicit_context: number;
      migrated_context: number;
      missing_context: number;
    };
    lineage?: WorkItemLineage;
  } | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<string>('all');

  const refresh = React.useCallback(async () => {
    try {
      const scopeParams = new URLSearchParams();
      if (tenant) scopeParams.set('tenant', tenant);
      if (organizationId) scopeParams.set('organization_id', organizationId);
      if (projectId) scopeParams.set('project_id', projectId);
      const scopeQuery = scopeParams.toString();
      const [response, intelligenceResponse] = await Promise.all([
        fetch(`/api/workitems${scopeQuery ? `?${scopeQuery}` : ''}`, { cache: 'no-store' }),
        fetch(`/api/intelligence${scopeQuery ? `?${scopeQuery}` : ''}`, { cache: 'no-store' }),
      ]);
      const payload = parseWorkItemsResponse(await response.json().catch(() => null));
      if (!response.ok || !payload) throw new Error('Invalid work items response');
      setItems(payload.items);
      setStatuses(payload.statuses);
      setProjection({
        scope: payload.scope,
        view: payload.view,
        quality: payload.quality,
        lineage: payload.lineage,
      });
      if (intelligenceResponse.ok) {
        const intelligencePayload = parseWorkCoordinationResponse(
          await intelligenceResponse.json().catch(() => null)
        );
        setCoordination(intelligencePayload || null);
      } else {
        setCoordination(null);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tenant, organizationId, projectId]);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const moveItem = React.useCallback(
    async (itemId: string, status: string) => {
      setBusyId(itemId);
      try {
        const response = await fetch('/api/workitems', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId, status }),
        });
        const payload = parseWorkItemMutationResponse(await response.json().catch(() => null));
        if (!response.ok || !payload) throw new Error('Invalid work item move response');
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [refresh]
  );

  const statusLabel = (status: string) =>
    uxText(STATUS_LABEL_KEY[status] || 'chronos_status_unknown', locale);

  const visibleItems =
    statusFilter === 'all' ? items : items.filter((item) => item.status === statusFilter);
  const tabItems = [
    { id: 'all', label: uxTextOr('chronos_ws_filter_all', 'All', locale), count: items.length },
    ...statuses.map((status) => ({
      id: status,
      label: statusLabel(status),
      count: items.filter((item) => item.status === status).length,
    })),
  ];
  const contextSummary = projection?.quality
    ? `${projection.quality.explicit_context} ${uxText('chronos_work_context_explicit', locale)} · ${projection.quality.migrated_context} ${uxText('chronos_work_context_migrated', locale)}${
        projection.quality.missing_context > 0
          ? ` · ${projection.quality.missing_context} ${uxText('chronos_work_context_missing', locale)}`
          : ''
      }`
    : null;

  return (
    <>
      <Section
        title={uxText('chronos_work_items', locale)}
        description={uxText('chronos_nav_work_items_hint', locale)}
      >
        <div className="flex flex-wrap gap-2">
          <Badge
            tone="accent"
            label={`${uxText('chronos_work_scope', locale)}: ${workScopeLabel(projection?.scope, locale)}`}
          />
          <Badge
            label={`${uxText('chronos_work_view', locale)}: ${workViewLabel(projection?.view, locale)}`}
          />
          {contextSummary ? (
            <Badge
              tone={projection?.quality?.missing_context ? 'warning' : undefined}
              label={`${uxText('chronos_work_context', locale)}: ${contextSummary}`}
            />
          ) : null}
        </div>

        {error ? (
          <Callout
            tone="danger"
            title={uxTextOr('chronos_ws_load_failed', 'Could not load this view', locale)}
            body={error}
          />
        ) : null}

        {coordination ? (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label={uxText('chronos_work_items', locale)}
              value={coordination.total}
              description={uxText('chronos_work_coordination_total_detail', locale)}
            />
            <Metric
              label={uxText('chronos_status_in_progress', locale)}
              value={coordination.inProgress}
              tone={coordination.inProgress > 0 ? 'info' : undefined}
              description={uxText('chronos_work_coordination_in_progress_detail', locale)}
            />
            <Metric
              label={uxText('chronos_blocked_count', locale)}
              value={coordination.blocked}
              tone={coordination.blocked > 0 ? 'danger' : undefined}
              description={uxText('chronos_work_coordination_blocked_detail', locale)}
            />
            <Metric
              label={uxText('chronos_work_coordination_running_attempts', locale)}
              value={coordination.runningAttempts}
              description={uxText('chronos_work_coordination_running_attempts_detail', locale)}
            />
          </div>
        ) : null}

        {items.length > 0 ? (
          <div className="chronos-subnav">
            <Tabs
              items={tabItems}
              active={statusFilter}
              onSelect={setStatusFilter}
              label={uxTextOr('chronos_ws_status_filter', 'Filter by status', locale)}
            />
          </div>
        ) : null}

        <div className="kb-table-wrap">
          <table className="kb-table">
            <thead>
              <tr>
                <th scope="col">{uxTextOr('chronos_ws_col_work_item', 'Work item', locale)}</th>
                <th scope="col" style={{ width: '9rem' }}>
                  {uxText('chronos_col_status', locale)}
                </th>
                <th scope="col">{uxText('chronos_work_item_assignee', locale)}</th>
                <th scope="col" style={{ width: '6rem' }}>
                  {uxText('chronos_work_item_priority', locale)}
                </th>
                <th scope="col" style={{ width: '7rem' }}>
                  {uxText('chronos_work_item_updated', locale)}
                </th>
                <th scope="col" data-align="end" style={{ width: '7rem' }}>
                  {uxTextOr('chronos_ws_col_move', 'Move', locale)}
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.length === 0 ? (
                <tr>
                  <td className="kb-table__empty" colSpan={6}>
                    {uxText('chronos_work_item_no_items', locale)}
                  </td>
                </tr>
              ) : (
                visibleItems.map((item) => {
                  const columnIndex = statuses.indexOf(item.status);
                  const missionId = missionIdFromItem(item);
                  const assignedBy =
                    metadataText(item.metadata, [
                      'assigned_by',
                      'assignedBy',
                      'created_by',
                      'createdBy',
                      'requested_by',
                      'requestedBy',
                    ]) || item.source;
                  const assignee =
                    item.assignee_user_id ||
                    item.assignee_peer_id ||
                    metadataText(item.metadata, ['assignee_label', 'assigneeLabel']) ||
                    uxText('chronos_work_item_unassigned', locale);
                  const previous = columnIndex > 0 ? statuses[columnIndex - 1] : null;
                  const next =
                    columnIndex >= 0 && columnIndex < statuses.length - 1
                      ? statuses[columnIndex + 1]
                      : null;
                  return (
                    <tr key={item.item_id}>
                      <td>
                        <div className="chronos-mission-cell">
                          <span className="chronos-mission-cell__title">{item.title}</span>
                          {item.description && item.description !== item.title ? (
                            <span className="kb-list__meta">{item.description}</span>
                          ) : null}
                          <span className="chronos-mission-cell__id">{item.item_id}</span>
                          <span className="kb-list__meta">
                            {uxText('chronos_work_item_assigned_by', locale)}: {assignedBy} ·{' '}
                            {uxText('chronos_work_item_source', locale)}:{' '}
                            {item.source_ref || item.source} ·{' '}
                            {uxText('chronos_work_item_created', locale)}:{' '}
                            {compactDate(item.created_at)}
                          </span>
                          <WorkItemLineageChain context={item.context} locale={locale} />
                          {missionId && onOpenMission ? (
                            <div>
                              <button
                                type="button"
                                className="chronos-mission-cell__title chronos-mission-cell__id"
                                onClick={() => onOpenMission(missionId)}
                              >
                                {uxText('chronos_mission', locale)}: {missionId}
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <StatusPill
                          status={workItemStatus(item.status)}
                          label={statusLabel(item.status)}
                        />
                      </td>
                      <td className="chronos-muted">{assignee}</td>
                      <td data-mono="true">{item.priority}</td>
                      <td className="chronos-muted">{compactDate(item.updated_at)}</td>
                      <td data-align="end">
                        <div className="flex justify-end gap-1">
                          {previous ? (
                            <Button
                              label={uxMessage(
                                'chronos_ws_move_to',
                                { status: statusLabel(previous) },
                                'Move to {status}',
                                locale
                              )}
                              variant="ghost"
                              disabled={busyId === item.item_id}
                              onClick={() => void moveItem(item.item_id, previous)}
                            >
                              <ArrowLeft size={14} aria-hidden="true" />
                            </Button>
                          ) : null}
                          {next ? (
                            <Button
                              label={uxMessage(
                                'chronos_ws_move_to',
                                { status: statusLabel(next) },
                                'Move to {status}',
                                locale
                              )}
                              variant="secondary"
                              disabled={busyId === item.item_id}
                              onClick={() => void moveItem(item.item_id, next)}
                            >
                              <ArrowRight size={14} aria-hidden="true" />
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {projection?.lineage ? (
        <WorkItemLineageOverview lineage={projection.lineage} locale={locale} />
      ) : null}
    </>
  );
}

const WORK_ITEM_STATUS: Record<string, KbStatus> = {
  backlog: 'planned',
  ready: 'ready',
  in_progress: 'working',
  blocked: 'blocked',
  review: 'review',
  done: 'done',
  archived: 'archived',
};

function workItemStatus(status: string): KbStatus {
  return WORK_ITEM_STATUS[status] || 'n/a';
}

const LINEAGE_LABEL_KEYS: Record<string, string> = {
  tenant_slug: 'chronos_lineage_tenant',
  organization_id: 'chronos_lineage_organization',
  project_id: 'chronos_lineage_project',
  mission_id: 'chronos_lineage_mission',
  task_id: 'chronos_lineage_task',
};

function WorkItemLineageOverview({
  lineage,
  locale,
}: {
  lineage: WorkItemLineage;
  locale: SupportedLocale;
}) {
  return (
    <Section
      title={uxText('chronos_lineage_title', locale)}
      description={uxText('chronos_lineage_description', locale)}
    >
      <div className="flex flex-wrap gap-2">
        <StatusPill
          status="completed"
          label={`${uxText('chronos_lineage_complete', locale)} ${lineage.complete_chain_items}`}
        />
        <StatusPill
          status={lineage.incomplete_chain_items > 0 ? 'needs_setup' : 'n/a'}
          label={`${uxText('chronos_lineage_incomplete', locale)} ${lineage.incomplete_chain_items}`}
        />
      </div>
      <Disclosure
        summary={uxTextOr('chronos_ws_lineage_breakdown', 'Show the breakdown by level', locale)}
      >
        <div className="kb-table-wrap">
          <table className="kb-table">
            <thead>
              <tr>
                <th scope="col" style={{ width: '10rem' }}>
                  {uxTextOr('chronos_ws_col_level', 'Level', locale)}
                </th>
                <th scope="col">{uxTextOr('chronos_ws_col_values', 'Values (items)', locale)}</th>
                <th scope="col" data-align="end" style={{ width: '7rem' }}>
                  {uxText('chronos_lineage_missing', locale)}
                </th>
              </tr>
            </thead>
            <tbody>
              {lineage.hierarchy.map((kind) => {
                const nodes = lineage.nodes.filter((node) => node.kind === kind).slice(0, 4);
                const missing = lineage.missing_by_kind[kind] || 0;
                return (
                  <tr key={kind}>
                    <td>{lineageLabel(kind, locale)}</td>
                    <td data-mono="true">
                      {nodes.length
                        ? nodes.map((node) => `${node.id} (${node.item_count})`).join(', ')
                        : '-'}
                    </td>
                    <td data-align="end">
                      {missing > 0 ? (
                        <StatusPill status="needs_setup" label={String(missing)} />
                      ) : (
                        <span className="chronos-muted">0</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {lineage.edges.length > 0 ? (
          <List
            items={lineage.edges.slice(0, 8).map((edge) => ({
              title: `${lineageLabel(edge.from, locale)} → ${lineageLabel(edge.to, locale)}`,
              meta: String(edge.item_count),
            }))}
          />
        ) : null}
      </Disclosure>
    </Section>
  );
}

function WorkItemLineageChain({
  context,
  locale,
}: {
  context: WorkItem['context'];
  locale: SupportedLocale;
}) {
  if (!context) return null;
  const chain = [
    ['tenant_slug', context.tenant_slug],
    ['organization_id', context.organization_id],
    ['project_id', context.project_id],
    ['mission_id', context.mission_id],
    ['task_id', context.task_id],
  ] as const;
  const missingLabel = uxText('chronos_lineage_missing', locale);
  return (
    <span
      className="kb-list__meta"
      aria-label={uxTextOr('chronos_ws_scope_lineage', 'Scope lineage', locale)}
    >
      {chain.map(([kind, value], index) => (
        <React.Fragment key={kind}>
          <span
            title={value || `${lineageLabel(kind, locale)} ${missingLabel}`}
            className={value ? undefined : 'chronos-scope__error'}
          >
            {lineageLabel(kind, locale)}: {value || missingLabel}
          </span>
          {index < chain.length - 1 ? ' › ' : null}
        </React.Fragment>
      ))}
    </span>
  );
}

function lineageLabel(kind: string, locale: SupportedLocale): string {
  const normalizedKind = kind.includes(':') ? kind.slice(0, kind.indexOf(':')) : kind;
  return uxText(LINEAGE_LABEL_KEYS[normalizedKind] || 'chronos_lineage_unknown', locale);
}

function workScopeLabel(scope: string | undefined, locale: SupportedLocale): string {
  return scope === 'work_items'
    ? uxText('chronos_work_scope_items', locale)
    : scope || uxText('chronos_lineage_unknown', locale);
}

function workViewLabel(view: string | undefined, locale: SupportedLocale): string {
  return view === 'all' ? uxText('chronos_work_view_all', locale) : view || '-';
}
