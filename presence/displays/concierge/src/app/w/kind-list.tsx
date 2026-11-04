'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Callout, EmptyState, PageHeader, statusLabel, useKbI18n } from '@agent/shared-ui';
import { localeToBcp47 } from '@agent/core/locale-normalize';
import type { DisplayText } from '@agent/core/surface/display-humanize';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { useWorkspaceResource } from '../../lib/use-workspace-resource';
import { opsApiPath } from '../../lib/ops/ops-api-path';
import { uxMessage, uxText } from '../../lib/ops/ux-vocabulary';
import { parseWorkItemsResponse } from '../../lib/ops/workitems-response';
import {
  BoardViewToggle,
  WorkItemBoard,
  type BoardTranslate,
  type BoardViewMode,
} from '../../components/work-board/WorkItemBoard';
import {
  WORK_ITEM_STATUS_LABEL_KEYS,
  actorDisplayName,
  type BoardCard,
} from '../../components/work-board/work-item-board';
import {
  entityHref,
  kindListHref,
  listQueryFromSearch,
  narrowingEntries,
  statusFacets,
  summaryLabelIndex,
  workspaceApiPath,
  type GraphEntityKind,
  type GraphNode,
  type WorkspaceGraphSummary,
} from '../../lib/workspace-view';
import { MissionStateBoard } from '../../components/mission-board/MissionStateBoard';
import {
  DegradedNotice,
  EntityList,
  KindEmptyState,
  LoadErrorState,
  LoadingState,
  WorkspaceCrumbs,
  kindLabel,
  kindsLabel,
  type Translate,
} from './workspace-parts';
import './workspace.css';

/**
 * One workspace kind as a list (or, for work items, a board) — searchable (`?q=`, server-side), filterable by
 * status (client-side chips derived from the result, so every chip shows
 * how many items it keeps) and narrowable by scope query parameters.
 */
export function KindList({
  t,
  kind,
  embedded = false,
}: {
  t: Translate;
  kind: GraphEntityKind;
  /** Inside a destination tab (`/work`, `/org`): the page owns the header and crumbs. */
  embedded?: boolean;
}) {
  const { t: kbT } = useKbI18n();
  const { locale } = useConciergeI18n();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = React.useMemo(
    () => listQueryFromSearch(new URLSearchParams(searchParams?.toString() ?? '')),
    [searchParams]
  );
  const [draft, setDraft] = React.useState(query.q ?? '');
  React.useEffect(() => setDraft(query.q ?? ''), [query.q]);

  const replaceQuery = React.useCallback(
    (patch: Record<string, string | undefined>) => {
      const next = new URLSearchParams(searchParams?.toString() ?? '');
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const search = next.toString();
      router.replace(`${pathname}${search ? `?${search}` : ''}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  // Debounced text search: the URL is the state, so results are shareable.
  React.useEffect(() => {
    if ((query.q ?? '') === draft.trim()) return;
    const timer = window.setTimeout(() => replaceQuery({ q: draft.trim() || undefined }), 250);
    return () => window.clearTimeout(timer);
  }, [draft, query.q, replaceQuery]);

  const { status, ...serverQuery } = query;
  const list = useWorkspaceResource<{ items: GraphNode[] }>(
    workspaceApiPath('list', { kind, ...serverQuery })
  );
  const summary = useWorkspaceResource<WorkspaceGraphSummary>(workspaceApiPath('summary'));
  const labels = React.useMemo(
    () => summaryLabelIndex(summary.state === 'ready' ? summary.data : null),
    [summary.state, summary.data]
  );

  // A board reload (after a move) keeps the previous cards on screen instead of
  // unmounting the board into a loading state.
  const lastReady = React.useRef<{ kind: GraphEntityKind; items: GraphNode[] } | null>(null);
  if (list.state === 'ready') lastReady.current = { kind, items: list.data.items };
  const stale =
    list.state === 'loading' && kind === 'work_item' && lastReady.current?.kind === kind
      ? lastReady.current.items
      : null;
  const listReady = list.state === 'ready' || stale !== null;
  const items = list.state === 'ready' ? list.data.items : (stale ?? []);
  const facets = statusFacets(items);
  const shown = status ? items.filter((item) => item.status === status) : items;
  const narrowing = narrowingEntries(query);
  const filtered = Boolean(query.q || status);
  // Work items read as a kanban board and missions as a state board by
  // default; `?view=list` keeps the list.
  const boardKind = kind === 'work_item' || kind === 'mission';
  const layout: BoardViewMode =
    boardKind && searchParams?.get('view') !== 'list' ? 'board' : 'list';
  const showBoard = boardKind && layout === 'board';
  const canMove = useWorkItemMoveAccess(showBoard && kind === 'work_item');

  return (
    <div className={embedded ? 'ws-page ws-page--embedded' : 'ws-page'}>
      {embedded ? null : (
        <>
          <WorkspaceCrumbs t={t} lineage={[]} current={kindsLabel(t, kind)} />
          <PageHeader title={kindsLabel(t, kind)} subtitle={t(`ws_about_${kind}`)} />
        </>
      )}
      {summary.state === 'ready' ? <DegradedNotice t={t} degraded={summary.data.degraded} /> : null}
      {narrowing.length ? (
        <Callout
          tone="info"
          title={t('ws_scope_narrowed', {
            scope: narrowing
              .map(
                (entry) =>
                  `${kindLabel(t, entry.kind)} ${labels.get(`${entry.kind}:${entry.id}`) ?? entry.id}`
              )
              .join(' › '),
          })}
          action={{ label: t('ws_scope_show_all'), href: kindListHref(kind) }}
        />
      ) : null}
      {boardKind ? (
        <BoardViewToggle
          t={(key) => t(key as Parameters<Translate>[0])}
          view={layout}
          onChange={(next) => replaceQuery({ view: next === 'list' ? 'list' : undefined })}
        />
      ) : null}
      <div className="ws-filters">
        <label className="kb-field">
          <span className="kb-field__label">{t('ws_search_label')}</span>
          <input
            type="search"
            className="kb-input ws-search"
            value={draft}
            placeholder={t('ws_search_placeholder')}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        {facets.length > 1 || status ? (
          <div className="ws-chips" role="group" aria-label={t('ws_status_filter_label')}>
            <button
              type="button"
              className="ws-chip"
              aria-pressed={!status}
              onClick={() => replaceQuery({ status: undefined })}
            >
              {t('ws_status_all')} ({items.length})
            </button>
            {facets.map((facet) => (
              <button
                key={facet.status}
                type="button"
                className="ws-chip"
                aria-pressed={status === facet.status}
                onClick={() =>
                  replaceQuery({ status: status === facet.status ? undefined : facet.status })
                }
              >
                {statusLabel(facet.status, kind === 'mission' ? 'mission' : undefined, kbT)} (
                {facet.count})
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {list.state === 'loading' && !listReady ? <LoadingState t={t} /> : null}
      {list.state === 'error' ? (
        <LoadErrorState t={t} error={list.error} onRetry={list.reload} />
      ) : null}
      {listReady ? (
        shown.length ? (
          <>
            <p className="ws-count-line" role="status">
              {t('ws_result_count', { count: shown.length })}
            </p>
            {showBoard && kind === 'mission' ? (
              <MissionStateBoard
                missions={shown.map((node) => ({
                  id: node.id,
                  label: node.label,
                  status: node.status,
                  updatedAt: node.updatedAt,
                  href: entityHref('mission', node.id),
                }))}
                label={t('ia_shell_mission_board_label')}
                columnLabel={(id) => t(`ia_shell_mission_col_${id}`)}
                emptyColumn={t('ia_shell_mission_col_empty')}
                moreLabel={(count) => t('ia_shell_mission_col_more', { count })}
              />
            ) : showBoard ? (
              <WorkItemGraphBoard
                items={shown}
                labels={labels}
                locale={locale}
                canMove={canMove}
                onMoved={list.reload}
              />
            ) : (
              <EntityList
                t={t}
                items={shown}
                labels={labels}
                label={t('ws_list_label', { kind: kindsLabel(t, kind) })}
              />
            )}
          </>
        ) : filtered ? (
          <EmptyState
            title={t('ws_filtered_empty_title')}
            body={t('ws_filtered_empty_body')}
            action={{
              label: t('ws_clear_filters'),
              onClick: () => {
                setDraft('');
                replaceQuery({ q: undefined, status: undefined });
              },
            }}
          />
        ) : (
          <KindEmptyState t={t} kind={kind} />
        )
      ) : null}
    </div>
  );
}

type GraphCard = BoardCard;

/** Whether the viewer may move cards: the console role from its work-item projection. */
function useWorkItemMoveAccess(enabled: boolean): boolean {
  const [canMove, setCanMove] = React.useState(false);
  React.useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void fetch(opsApiPath('/workitems?scope=work_items'), {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = parseWorkItemsResponse(await response.json().catch(() => null));
        if (!controller.signal.aborted) {
          setCanMove(response.ok && payload?.accessRole === 'localadmin');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setCanMove(false);
      });
    return () => controller.abort();
  }, [enabled]);
  return canMove;
}

/**
 * `/w/work_item` as a board. Cards come from the same viewer-scoped list as
 * the list view (search and narrowing apply); a move goes through the governed
 * console route (`POST /api/ops/workitems`), which re-checks role and scope.
 * The role is read from the console's work-item projection so readonly
 * viewers see the board without move controls.
 */
function WorkItemGraphBoard({
  items,
  labels,
  locale,
  canMove,
  onMoved,
}: {
  items: readonly GraphNode[];
  labels: ReadonlyMap<string, string>;
  locale: string;
  canMove: boolean;
  onMoved: () => void;
}) {
  const uiLocale = locale as Parameters<typeof uxText>[1];
  const boardT: BoardTranslate = React.useCallback(
    (key, params) => (params ? uxMessage(key, params, key, uiLocale) : uxText(key, uiLocale)),
    [uiLocale]
  );
  const renderActor = React.useCallback(
    (text: DisplayText) =>
      'text' in text ? text.text : uxMessage(text.key, text.params ?? {}, text.key, uiLocale),
    [uiLocale]
  );
  const statusName = React.useCallback(
    (value: string) =>
      uxText(WORK_ITEM_STATUS_LABEL_KEYS[value] || 'chronos_status_unknown', uiLocale),
    [uiLocale]
  );
  const cards = React.useMemo<GraphCard[]>(
    () =>
      items.map((node) => {
        const assignee = node.actors?.find((actor) => actor.role === 'assignee');
        const priority = node.facts?.priority;
        return {
          id: node.id,
          title: node.label,
          status: node.status ?? 'backlog',
          ...(typeof priority === 'string' ? { priority } : {}),
          assignee: assignee
            ? (assignee.label ?? actorDisplayName(assignee.actorId, renderActor))
            : undefined,
          ...(node.projectId
            ? {
                project: {
                  id: node.projectId,
                  label: labels.get(`project:${node.projectId}`) ?? node.projectId,
                },
              }
            : {}),
          ...(node.missionId
            ? {
                mission: {
                  id: node.missionId,
                  label: labels.get(`mission:${node.missionId}`) ?? node.missionId,
                },
              }
            : {}),
          updatedAt: node.updatedAt,
          description: node.summary,
          href: entityHref('work_item', node.id),
        };
      }),
    [items, labels, renderActor]
  );

  const move = React.useCallback(
    async (card: GraphCard, status: string) => {
      const response = await fetch(opsApiPath('/workitems'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: card.id, status }),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: unknown } | null;
      if (!response.ok || payload?.ok !== true) throw new Error('work item move refused');
      onMoved();
    },
    [onMoved]
  );

  return (
    <WorkItemBoard
      cards={cards}
      t={boardT}
      statusLabel={statusName}
      locale={localeToBcp47(uiLocale)}
      canMove={canMove}
      onMove={move}
      label={boardT('ux_b_board_label')}
    />
  );
}
