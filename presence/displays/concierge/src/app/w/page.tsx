'use client';

import * as React from 'react';
import { EmptyState, PageHeader, Section } from '@agent/shared-ui';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { useWorkspaceResource } from '../../lib/use-workspace-resource';
import {
  entityHref,
  kindListHref,
  summaryLabelIndex,
  workspaceApiPath,
  type GraphEntityKind,
  type GraphNode,
  type WorkspaceGraphSummary,
} from '../../lib/workspace-view';
import {
  DegradedNotice,
  EntityList,
  KindEmptyState,
  LoadErrorState,
  LoadingState,
  kindLabel,
  kindsLabel,
  type Translate,
} from './workspace-parts';
import './workspace.css';

/** Kinds with their own list page (tasks live inside missions). */
const COUNTED_KINDS: GraphEntityKind[] = [
  'tenant',
  'organization',
  'project',
  'mission',
  'work_item',
  'approval',
  'actor',
];

/**
 * 全体像 — where everything is and what needs attention: the attention list
 * first, then counts, the company → organization → project tree, and the
 * most recently updated missions. Every item opens its own page.
 */
export default function WorkspaceOverviewPage() {
  const { t } = useConciergeI18n();
  const summary = useWorkspaceResource<WorkspaceGraphSummary>(workspaceApiPath('summary'));
  const missions = useWorkspaceResource<{ items: GraphNode[] }>(
    workspaceApiPath('list', { kind: 'mission', limit: 8 })
  );
  const labels = React.useMemo(
    () => summaryLabelIndex(summary.state === 'ready' ? summary.data : null),
    [summary.state, summary.data]
  );

  return (
    <div className="ws-page">
      <PageHeader title={t('ws_overview_title')} subtitle={t('ws_overview_lead')} />
      {summary.state === 'loading' ? <LoadingState t={t} /> : null}
      {summary.state === 'error' ? (
        <LoadErrorState t={t} error={summary.error} onRetry={summary.reload} />
      ) : null}
      {summary.state === 'ready' ? (
        <>
          <DegradedNotice t={t} degraded={summary.data.degraded} />
          <Section title={t('ws_attention_title')} description={t('ws_attention_lead')}>
            {summary.data.attention.length ? (
              <EntityList
                t={t}
                items={summary.data.attention}
                labels={labels}
                showKind
                label={t('ws_attention_title')}
              />
            ) : (
              <EmptyState
                title={t('ws_attention_empty_title')}
                body={t('ws_attention_empty_body')}
              />
            )}
          </Section>
          <Section title={t('ws_counts_title')}>
            <ul className="ws-counts">
              {COUNTED_KINDS.map((kind) => (
                <li key={kind}>
                  <a className="ws-count" href={kindListHref(kind)}>
                    <span className="ws-count__value">{summary.data.counts[kind] ?? 0}</span>
                    <span className="ws-count__label">{kindsLabel(t, kind)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </Section>
          <Section title={t('ws_structure_title')} description={t('ws_structure_lead')}>
            <StructureTree t={t} tenants={summary.data.tenants} />
          </Section>
        </>
      ) : null}
      <Section
        title={t('ws_recent_missions_title')}
        actions={[{ label: t('ws_view_all'), href: kindListHref('mission') }]}
      >
        {missions.state === 'loading' ? <LoadingState t={t} /> : null}
        {missions.state === 'error' ? (
          <LoadErrorState t={t} error={missions.error} onRetry={missions.reload} />
        ) : null}
        {missions.state === 'ready' ? (
          missions.data.items.length ? (
            <EntityList
              t={t}
              items={missions.data.items}
              labels={labels}
              label={t('ws_recent_missions_title')}
            />
          ) : (
            <KindEmptyState t={t} kind="mission" />
          )
        ) : null}
      </Section>
    </div>
  );
}

function StructureTree({
  t,
  tenants,
}: {
  t: Translate;
  tenants: WorkspaceGraphSummary['tenants'];
}) {
  if (!tenants.length)
    return <KindEmptyState t={t} kind="tenant" title={t('ws_structure_empty_title')} />;
  return (
    <ul className="ws-tree">
      {tenants.map((tenant) => (
        <li key={tenant.id}>
          <TreeNode t={t} kind="tenant" id={tenant.id} label={tenant.label} />
          {tenant.organizations.length ? (
            <ul>
              {tenant.organizations.map((org) => (
                <li key={org.id}>
                  <TreeNode t={t} kind="organization" id={org.id} label={org.label} />
                  <ul>
                    {org.projects.length ? (
                      org.projects.map((project) => (
                        <li key={project.id}>
                          <TreeNode t={t} kind="project" id={project.id} label={project.label} />
                        </li>
                      ))
                    ) : (
                      <li className="ws-tree__empty">{t('ws_no_projects')}</li>
                    )}
                  </ul>
                </li>
              ))}
            </ul>
          ) : (
            <ul>
              <li className="ws-tree__empty">{t('ws_no_organizations')}</li>
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function TreeNode({
  t,
  kind,
  id,
  label,
}: {
  t: Translate;
  kind: GraphEntityKind;
  id: string;
  label: string;
}) {
  return (
    <span className="ws-tree__node">
      <span className="ws-crumbs__kind">{kindLabel(t, kind)}</span>
      <a href={entityHref(kind, id)}>{label}</a>
    </span>
  );
}
