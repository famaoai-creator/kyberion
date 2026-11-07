'use client';

import { opsApiPath, opsPagePath } from '../../lib/ops/ops-api-path';
import * as React from 'react';
import { localeToBcp47 } from '@agent/core/foundation/locale-normalize';
import type { DisplayText } from '@agent/core/surface/display-humanize';
import {
  Badge,
  Callout,
  Disclosure,
  List,
  Metric,
  Section,
  StatusPill,
  Tabs,
} from '@agent/shared-ui';
import { useChronosLocale } from '../../lib/ops/hooks';
import { uxMessage, uxText, uxTextOr, type SupportedLocale } from '../../lib/ops/ux-vocabulary';
import { entityHref } from '../../lib/workspace-view';
import {
  BoardViewToggle,
  WorkItemBoard,
  type BoardTranslate,
  type BoardViewMode,
} from '../work-board/WorkItemBoard';
import {
  WORK_ITEM_STATUS_LABEL_KEYS,
  actorDisplayName,
  type BoardCard,
} from '../work-board/work-item-board';
import {
  parseWorkItemMutationResponse,
  parseWorkItemAdmissionResponse,
  type ClientMissionAdmission,
  parseWorkItemsResponse,
  type ClientWorkItem,
  type ClientWorkItemLineage,
} from '../../lib/ops/workitems-response';
import {
  parseWorkCoordinationResponse,
  type ClientWorkCoordinationSummary,
} from '../../lib/ops/intelligence-work-coordination-response';

import { WorkItemMissionAlignmentAction } from './WorkItemMissionAlignmentAction';

type WorkItem = ClientWorkItem;
type WorkItemLineage = ClientWorkItemLineage;

type WorkCoordinationSummary = ClientWorkCoordinationSummary;

const STATUS_LABEL_KEY = WORK_ITEM_STATUS_LABEL_KEYS;

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

type WorkItemCard = BoardCard & { item: WorkItem };

const BOARD_VIEW_STORAGE_KEY = 'kyberion.ops.work-board.view';

function readStoredBoardView(): BoardViewMode {
  if (typeof window === 'undefined') return 'board';
  try {
    return window.localStorage.getItem(BOARD_VIEW_STORAGE_KEY) === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

/** A work item as a board card: display names and lineage, never raw ids where a name exists. */
export function workItemCard(
  item: WorkItem,
  renderActor: (text: DisplayText) => string
): WorkItemCard {
  const assigneeId =
    item.assignee_user_id ||
    item.assignee_peer_id ||
    metadataText(item.metadata, ['assignee_label', 'assigneeLabel']) ||
    undefined;
  const projectId = item.context?.project_id || item.project_id || undefined;
  const missionId = missionIdFromItem(item) || undefined;
  return {
    id: item.item_id,
    title: item.title,
    status: item.status,
    priority: item.priority,
    assignee: actorDisplayName(assigneeId, renderActor),
    ...(projectId ? { project: { id: projectId, label: projectId } } : {}),
    ...(missionId && missionId !== projectId
      ? { mission: { id: missionId, label: missionId } }
      : {}),
    updatedAt: item.updated_at || item.created_at,
    description: item.description,
    href: entityHref('work_item', item.item_id),
    item,
  };
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
  const [admissions, setAdmissions] = React.useState<Record<string, ClientMissionAdmission>>({});
  const preparing = React.useRef(new Set<string>());
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<string>('all');
  const [accessRole, setAccessRole] = React.useState<'readonly' | 'localadmin'>('readonly');
  const [boardView, setBoardView] = React.useState<BoardViewMode>('board');
  React.useEffect(() => setBoardView(readStoredBoardView()), []);
  const changeBoardView = React.useCallback((next: BoardViewMode) => {
    setBoardView(next);
    try {
      window.localStorage.setItem(BOARD_VIEW_STORAGE_KEY, next);
    } catch {
      /* storage unavailable: the choice lasts for this page only */
    }
  }, []);

  const refresh = React.useCallback(async () => {
    try {
      const scopeParams = new URLSearchParams();
      if (tenant) scopeParams.set('tenant', tenant);
      if (organizationId) scopeParams.set('organization_id', organizationId);
      if (projectId) scopeParams.set('project_id', projectId);
      const scopeQuery = scopeParams.toString();
      const [response, intelligenceResponse] = await Promise.all([
        fetch(opsApiPath(`/workitems${scopeQuery ? `?${scopeQuery}` : ''}`), { cache: 'no-store' }),
        fetch(opsApiPath(`/intelligence${scopeQuery ? `?${scopeQuery}` : ''}`), {
          cache: 'no-store',
        }),
      ]);
      const payload = parseWorkItemsResponse(await response.json().catch(() => null));
      if (!response.ok || !payload) throw new Error('Invalid work items response');
      setItems(payload.items);
      setAccessRole(payload.accessRole === 'localadmin' ? 'localadmin' : 'readonly');
      setAdmissions(() => {
        const next: Record<string, ClientMissionAdmission> = {};
        for (const item of payload.items) {
          const receipt = parseWorkItemAdmissionResponse({
            ok: true,
            item,
            admission: item.metadata?.mission_alignment_decision,
          });
          if (receipt) {
            next[item.item_id] = receipt.admission;
            preparing.current.delete(item.item_id);
          }
        }
        return next;
      });
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

  // Throws on refusal so the board rolls its optimistic move back.
  const moveItem = React.useCallback(
    async (itemId: string, status: string) => {
      setBusyId(itemId);
      try {
        const response = await fetch(opsApiPath('/workitems'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId, status }),
        });
        const payload = parseWorkItemMutationResponse(await response.json().catch(() => null));
        if (!response.ok || !payload) throw new Error('Invalid work item move response');
        await refresh();
      } finally {
        setBusyId(null);
      }
    },
    [refresh]
  );

  const requestAlignment = React.useCallback(
    async (itemId: string) => {
      if (preparing.current.has(itemId)) return;
      preparing.current.add(itemId);
      setBusyId(itemId);
      try {
        const response = await fetch(opsApiPath('/workitems'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId, action: 'request_mission_alignment' }),
          signal: AbortSignal.timeout(125_000),
        });
        const payload = parseWorkItemAdmissionResponse(await response.json().catch(() => null));
        if (!response.ok || !payload)
          throw new Error(
            'Mission alignment request remains held; reload and inspect the work item'
          );
        setAdmissions((current) => ({ ...current, [itemId]: payload.admission }));
        preparing.current.delete(itemId);
        await refresh();
      } catch (err) {
        setError(
          'Alignment outcome is unknown or held. Refresh and inspect the original work item approval before trying again.'
        );
      } finally {
        setBusyId(null);
      }
    },
    [refresh]
  );

  const statusLabel = (status: string) =>
    uxText(STATUS_LABEL_KEY[status] || 'chronos_status_unknown', locale);

  const boardT: BoardTranslate = React.useCallback(
    (key, params) => (params ? uxMessage(key, params, key, locale) : uxText(key, locale)),
    [locale]
  );
  const renderActor = React.useCallback(
    (text: DisplayText) =>
      'text' in text ? text.text : uxMessage(text.key, text.params ?? {}, text.key, locale),
    [locale]
  );
  const cards = React.useMemo(
    () => items.map((item) => workItemCard(item, renderActor)),
    [items, renderActor]
  );
  const visibleCards =
    statusFilter === 'all' ? cards : cards.filter((card) => card.status === statusFilter);
  const tabItems = [
    {
      id: 'all',
      label: uxTextOr('chronos_ws_filter_all', 'All', locale),
      count: items.length,
    },
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <BoardViewToggle t={boardT} view={boardView} onChange={changeBoardView} />
            {boardView === 'list' ? (
              <div className="chronos-subnav">
                <Tabs
                  items={tabItems}
                  active={statusFilter}
                  onSelect={setStatusFilter}
                  label={uxTextOr('chronos_ws_status_filter', 'Filter by status', locale)}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {items.length === 0 ? (
          <p className="kb-text kb-text--muted">{uxText('chronos_work_item_no_items', locale)}</p>
        ) : (
          <WorkItemBoard
            cards={boardView === 'list' ? visibleCards : cards}
            t={boardT}
            statusLabel={statusLabel}
            locale={localeToBcp47(locale)}
            canMove={accessRole === 'localadmin'}
            onMove={(card, status) => moveItem(card.id, status)}
            label={uxText('ux_b_board_label', locale)}
            layout={boardView}
            renderCardExtra={(card) => (
              <WorkItemCardExtra
                item={card.item}
                admission={admissions[card.id]}
                busy={busyId === card.id || preparing.current.has(card.id)}
                locale={locale}
                onRequest={requestAlignment}
                onOpenMission={onOpenMission}
              />
            )}
          />
        )}
      </Section>

      {projection?.lineage ? (
        <WorkItemLineageOverview lineage={projection.lineage} locale={locale}>
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
        </WorkItemLineageOverview>
      ) : null}
    </>
  );
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
  children,
}: {
  lineage: WorkItemLineage;
  locale: SupportedLocale;
  children?: React.ReactNode;
}) {
  return (
    <Section
      title={uxText('chronos_lineage_title', locale)}
      description={uxText('chronos_lineage_description', locale)}
    >
      {children}
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

/** Console-only controls under a card: mission alignment, discussion, mission drill-down. */
function WorkItemCardExtra({
  item,
  admission,
  busy,
  locale,
  onRequest,
  onOpenMission,
}: {
  item: WorkItem;
  admission?: ClientMissionAdmission;
  busy: boolean;
  locale: SupportedLocale;
  onRequest: (itemId: string) => void | Promise<void>;
  onOpenMission?: (missionId: string) => void;
}) {
  const missionId = missionIdFromItem(item);
  return (
    <>
      <WorkItemMissionAlignmentAction
        item={item}
        admission={admission}
        busy={busy}
        locale={locale}
        onRequest={onRequest}
      />
      <div className="wb-card__links">
        <a
          className="kb-link"
          href={opsPagePath(
            `?section=discussion&goal=${encodeURIComponent(item.title)}${missionId ? `&mission=${encodeURIComponent(missionId)}` : ''}`
          )}
        >
          {uxText('chronos_ws_discuss_item', locale)}
        </a>
        {typeof item.metadata?.discussion_id === 'string' ? (
          <a
            className="kb-link"
            href={opsPagePath(
              `?section=discussion&room=${encodeURIComponent(item.metadata.discussion_id)}`
            )}
          >
            {uxText('chronos_ws_open_discussion', locale)}
          </a>
        ) : null}
        {missionId && onOpenMission ? (
          <button type="button" className="kb-link" onClick={() => onOpenMission(missionId)}>
            {uxText('ux_b_card_open_mission', locale)}
          </button>
        ) : null}
      </div>
    </>
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
