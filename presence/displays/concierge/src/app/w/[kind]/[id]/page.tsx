'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { Badge, Callout, EmptyState, KeyValue, PageHeader, Section, Tabs } from '@agent/shared-ui';
import { useConciergeI18n } from '../../../../lib/use-concierge-i18n';
import { useWorkspaceResource } from '../../../../lib/use-workspace-resource';
import {
  CONTAINABLE_KINDS,
  approvalNeedsDecision,
  decodeRouteSegment,
  entityHref,
  inboxHrefForApproval,
  isWorkspaceKind,
  kindListHref,
  workspaceApiPath,
  type GraphEntityKind,
  type GraphEntityView,
  type GraphNode,
  type WorkspaceGraphSummary,
} from '../../../../lib/workspace-view';
import {
  DegradedNotice,
  EntityList,
  EntityStatus,
  LoadErrorState,
  LoadingState,
  WorkspaceCrumbs,
  factLabel,
  factValue,
  kindLabel,
  kindNextStep,
  kindsLabel,
  ApprovalBriefsProvider,
  nodeTitle,
  useApprovalBriefs,
  roleLabel,
  type Translate,
} from '../../workspace-parts';
import {
  actorDisplayName,
  cardSummary,
  parseDecisionBrief,
} from '../../../../lib/decision-brief-view';
import { DecisionBriefBlock } from '../../../decision-brief';
import '../../workspace.css';

export default function WorkspaceEntityPage() {
  const { t } = useConciergeI18n();
  const params = useParams<{ kind: string; id: string }>();
  const kind = decodeRouteSegment(params?.kind);
  const id = decodeRouteSegment(params?.id);
  if (!isWorkspaceKind(kind) || !id) {
    return (
      <div className="ws-page">
        <WorkspaceCrumbs t={t} lineage={[]} />
        <EmptyState title={t('ws_error_title')} action={{ label: t('ws_back_home'), href: '/' }} />
      </div>
    );
  }
  return (
    <ApprovalBriefsProvider>
      <EntityDetail t={t} kind={kind} id={id} />
    </ApprovalBriefsProvider>
  );
}

/**
 * `/w/<kind>/<id>` — where this is (lineage), what it is (kind, status,
 * goal), who is on it, what it contains, and the next step.
 */
function EntityDetail({ t, kind, id }: { t: Translate; kind: GraphEntityKind; id: string }) {
  const { locale } = useConciergeI18n();
  const entity = useWorkspaceResource<GraphEntityView>(workspaceApiPath('get', { kind, id }));
  const summary = useWorkspaceResource<WorkspaceGraphSummary>(workspaceApiPath('summary'));
  const approvalBriefs = useApprovalBriefs();

  if (entity.state === 'loading')
    return (
      <div className="ws-page">
        <WorkspaceCrumbs t={t} lineage={[]} current={id} />
        <LoadingState t={t} />
      </div>
    );
  if (entity.state === 'error') {
    return (
      <div className="ws-page">
        <WorkspaceCrumbs t={t} lineage={[]} current={id} />
        {entity.error === 'not_found' ? (
          <EmptyState
            title={t('ws_not_found_title', { kind: kindLabel(t, kind) })}
            body={t('ws_not_found_body')}
            action={{
              label: t('ws_back_to_list', { kind: kindsLabel(t, kind) }),
              href: kindListHref(kind),
            }}
          />
        ) : (
          <LoadErrorState t={t} error={entity.error} onRetry={entity.reload} />
        )}
      </div>
    );
  }

  const view = entity.data;
  const { node } = view;
  const brief =
    node.kind === 'approval'
      ? (approvalBriefs.get(node.id) ?? parseDecisionBrief(node.brief))
      : undefined;
  const title = nodeTitle(node, locale, brief);
  const summaryText = cardSummary(node.summary, 600);
  const facts = [
    { label: t('ws_fact_id'), value: node.id, mono: true },
    ...(node.tier ? [{ label: t('ws_fact_tier'), value: node.tier }] : []),
    ...(node.updatedAt
      ? [{ label: t('ws_fact_updated'), value: formatWhen(node.updatedAt, locale) }]
      : []),
    ...Object.entries(node.facts ?? {})
      .filter(([, value]) => value !== '' && value !== undefined)
      .map(([key, value]) => ({ label: factLabel(t, key), value: factValue(t, key, value) })),
  ];

  return (
    <div className="ws-page">
      <WorkspaceCrumbs t={t} lineage={view.lineage} current={title} />
      <PageHeader title={title} subtitle={t(`ws_about_${node.kind}`)} />
      <div className="ws-entity-meta">
        <Badge label={kindLabel(t, node.kind)} tone="accent" />
        <EntityStatus kind={node.kind} status={node.status} />
        {node.label !== node.id ? <span className="ws-mono">{node.id}</span> : null}
      </div>
      {summary.state === 'ready' ? <DegradedNotice t={t} degraded={summary.data.degraded} /> : null}
      {node.kind === 'approval' ? <ApprovalNextStep t={t} node={node} /> : null}
      <div className="ws-columns">
        <div className="ws-stack">
          {view.goal ? (
            <Section title={t('ws_goal_title')} headingLevel={2}>
              <p className="ws-text">{view.goal}</p>
            </Section>
          ) : null}
          {brief ? (
            <Section title={t('ws_summary_title')}>
              <DecisionBriefBlock brief={brief} locale={locale} showAsk={false} />
            </Section>
          ) : summaryText.short && node.summary !== node.label ? (
            <Section title={t('ws_summary_title')}>
              <p className="ws-text">{summaryText.full}</p>
            </Section>
          ) : null}
          {CONTAINABLE_KINDS[node.kind].length ? <Contents t={t} view={view} /> : null}
          {node.kind === 'actor' ? (
            <Section title={t('ws_involvements_title')}>
              {view.involvements?.length ? (
                <EntityList
                  t={t}
                  items={view.involvements}
                  showKind
                  label={t('ws_involvements_title')}
                />
              ) : (
                <p className="ws-muted">{t('ws_involvements_empty')}</p>
              )}
            </Section>
          ) : null}
        </div>
        <div className="ws-stack">
          <Section title={t('ws_facts_title')}>
            <KeyValue items={facts} />
          </Section>
          <People t={t} actors={view.actors} />
        </div>
      </div>
    </div>
  );
}

function formatWhen(iso: string, locale: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(locale);
}

/** Decisions happen in the Inbox; this page only says so and links there. */
function ApprovalNextStep({ t, node }: { t: Translate; node: GraphNode }) {
  if (approvalNeedsDecision(node.status))
    return (
      <Callout
        tone="warning"
        title={t('ws_approval_pending_title')}
        body={t('ws_approval_pending_body')}
        action={{ label: t('ws_approval_open_inbox'), href: inboxHrefForApproval(node.id) }}
      />
    );
  return <Callout tone="info" title={t('ws_approval_decided_body')} />;
}

/** One tab per kind this entity can contain — empty tabs say what would go there. */
function Contents({ t, view }: { t: Translate; view: GraphEntityView }) {
  const kinds = CONTAINABLE_KINDS[view.node.kind];
  const firstFilled = kinds.find((kind) => view.children[kind]?.length) ?? kinds[0]!;
  const [active, setActive] = React.useState<GraphEntityKind>(firstFilled);
  const items = view.children[active] ?? [];
  const next = kindNextStep(t, active);
  return (
    <Section title={t('ws_contains_title', { kind: kindLabel(t, view.node.kind) })}>
      <Tabs
        label={t('ws_tabs_label')}
        items={kinds.map((kind) => ({
          id: kind,
          label: kindsLabel(t, kind),
          count: view.children[kind]?.length ?? 0,
        }))}
        active={active}
        onSelect={(id) => setActive(id as GraphEntityKind)}
      />
      {items.length ? (
        active === 'task' ? (
          <TaskList t={t} tasks={items} />
        ) : (
          <EntityList t={t} items={items} showLineage={false} label={kindsLabel(t, active)} />
        )
      ) : (
        <EmptyState
          title={t('ws_contains_empty', { kind: kindLabel(t, view.node.kind) })}
          body={`${t(`ws_about_${active}`)} ${t(`ws_hint_${active}`)}`}
          action={next}
        />
      )}
    </Section>
  );
}

/** Mission tasks are steps, not pages: status, the assigned role and the deliverable inline. */
function TaskList({ t, tasks }: { t: Translate; tasks: readonly GraphNode[] }) {
  return (
    <ul className="ws-list" aria-label={kindsLabel(t, 'task')}>
      {tasks.map((task) => {
        const role = task.facts?.assigned_role;
        const deliverable = task.facts?.deliverable;
        return (
          <li key={task.id} className="ws-row">
            <div className="ws-row__main">
              <span className="ws-row__title">{task.label}</span>
              <EntityStatus kind="task" status={task.status} />
            </div>
            <div className="ws-row__meta">
              <span>
                {role
                  ? t('ws_task_assigned_role', { role: String(role) })
                  : t('ws_task_unassigned')}
              </span>
              {task.facts?.task_id ? (
                <span className="ws-mono">{String(task.facts.task_id)}</span>
              ) : null}
            </div>
            {deliverable ? (
              <p className="ws-row__summary">
                {t('ws_fact_deliverable')}: {String(deliverable)}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function People({ t, actors }: { t: Translate; actors: GraphEntityView['actors'] }) {
  const { locale } = useConciergeI18n();
  return (
    <Section title={t('ws_people_title')} description={t('ws_people_lead')}>
      {actors.length ? (
        <ul className="ws-people">
          {actors.map((actor) => (
            <li key={`${actor.actorId}:${actor.role}`} className="ws-person">
              {actor.known ? (
                <a href={entityHref('actor', actor.actorId)}>{actor.label}</a>
              ) : (
                <span>
                  {actorDisplayName(
                    actor.actorId,
                    locale,
                    actor.label !== actor.actorId ? actor.label : undefined
                  )}
                </span>
              )}
              <span className="ws-chips">
                <Badge label={roleLabel(t, actor.role)} tone="neutral" />
                {actor.known ? null : <Badge label={t('ws_actor_unregistered')} tone="warning" />}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ws-muted">{t('ws_people_empty')}</p>
      )}
    </Section>
  );
}
