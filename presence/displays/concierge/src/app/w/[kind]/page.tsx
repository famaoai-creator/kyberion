'use client';

import * as React from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Callout, EmptyState, PageHeader, statusLabel, useKbI18n } from '@agent/shared-ui';
import { useConciergeI18n } from '../../../lib/use-concierge-i18n';
import { useWorkspaceResource } from '../../../lib/use-workspace-resource';
import {
  decodeRouteSegment,
  isWorkspaceKind,
  kindListHref,
  listQueryFromSearch,
  narrowingEntries,
  statusFacets,
  summaryLabelIndex,
  workspaceApiPath,
  type GraphEntityKind,
  type GraphNode,
  type WorkspaceGraphSummary,
} from '../../../lib/workspace-view';
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
} from '../workspace-parts';
import '../workspace.css';

export default function WorkspaceListPage() {
  return (
    <React.Suspense fallback={null}>
      <WorkspaceList />
    </React.Suspense>
  );
}

function WorkspaceList() {
  const { t } = useConciergeI18n();
  const params = useParams<{ kind: string }>();
  const kind = decodeRouteSegment(params?.kind);
  if (!isWorkspaceKind(kind)) {
    return (
      <div className="ws-page">
        <WorkspaceCrumbs t={t} lineage={[]} />
        <EmptyState
          title={t('ws_error_title')}
          action={{ label: t('ws_overview_title'), href: '/w' }}
        />
      </div>
    );
  }
  return <KindList t={t} kind={kind} />;
}

/**
 * `/w/<kind>` — one kind, searchable (`?q=`, server-side), filterable by
 * status (client-side chips derived from the result, so every chip shows
 * how many items it keeps) and narrowable by scope query parameters.
 */
function KindList({ t, kind }: { t: Translate; kind: GraphEntityKind }) {
  const { t: kbT } = useKbI18n();
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

  const items = list.state === 'ready' ? list.data.items : [];
  const facets = statusFacets(items);
  const shown = status ? items.filter((item) => item.status === status) : items;
  const narrowing = narrowingEntries(query);
  const filtered = Boolean(query.q || status);

  return (
    <div className="ws-page">
      <WorkspaceCrumbs t={t} lineage={[]} current={kindsLabel(t, kind)} />
      <PageHeader title={kindsLabel(t, kind)} subtitle={t(`ws_about_${kind}`)} />
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
      {list.state === 'loading' ? <LoadingState t={t} /> : null}
      {list.state === 'error' ? (
        <LoadErrorState t={t} error={list.error} onRetry={list.reload} />
      ) : null}
      {list.state === 'ready' ? (
        shown.length ? (
          <>
            <p className="ws-count-line" role="status">
              {t('ws_result_count', { count: shown.length })}
            </p>
            <EntityList
              t={t}
              items={shown}
              labels={labels}
              label={t('ws_list_label', { kind: kindsLabel(t, kind) })}
            />
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
