'use client';

import * as React from 'react';
import { Badge, Button, Callout, EmptyState, Skeleton, StatusPill } from '@agent/shared-ui';
import type { KbStatus, KbStatusDomain } from '@agent/core/surface/a2ui-catalog';
import type { ConciergeMessageKey } from '../../lib/i18n';
import type { useConciergeI18n } from '../../lib/use-concierge-i18n';
import {
  degradedSources,
  entityHref,
  nodeLineage,
  type GraphActorLink,
  type GraphEntityKind,
  type GraphNode,
  type GraphRef,
  type WorkspaceLoadError,
} from '../../lib/workspace-view';

/**
 * Building blocks shared by the workspace pages. Every element uses the
 * shared `.kb-*` components or the `.ws-*` layout classes in
 * `workspace.css` (tokens only, no color literals).
 */

export type Translate = ReturnType<typeof useConciergeI18n>['t'];

export const kindLabel = (t: Translate, kind: GraphEntityKind) => t(`ws_kind_${kind}`);
export const kindsLabel = (t: Translate, kind: GraphEntityKind) => t(`ws_kinds_${kind}`);

const KNOWN_ROLES = new Set([
  'owner',
  'assignee',
  'claim_holder',
  'requester',
  'decider',
  'accountable_human',
  'persona',
  'affiliated',
]);
/** Graph roles are localized; mission staffing roles (free-form team roles) are shown as written. */
export function roleLabel(t: Translate, role: string): string {
  return KNOWN_ROLES.has(role) ? t(`ws_role_${role}` as ConciergeMessageKey) : role;
}

const KNOWN_FACTS = new Set([
  'priority',
  'source',
  'approval_kind',
  'channel',
  'persona',
  'actor_type',
  'agent_kind',
  'tenants',
  'roles',
  'task_id',
  'deliverable',
  'assigned_role',
  'parent_organization_id',
]);
export function factLabel(t: Translate, key: string): string {
  return KNOWN_FACTS.has(key) ? t(`ws_fact_${key}` as ConciergeMessageKey) : key;
}
export function factValue(t: Translate, key: string, value: string | number | boolean): string {
  if (key === 'actor_type' && (value === 'member' || value === 'agent'))
    return t(`ws_actor_type_${value}`);
  return String(value);
}

export function EntityStatus({ kind, status }: { kind: GraphEntityKind; status?: string }) {
  if (!status) return null;
  const domain: KbStatusDomain | undefined = kind === 'mission' ? 'mission' : undefined;
  return <StatusPill status={status as KbStatus} domain={domain} />;
}

/** `全体像 › tenant › organization › project › mission` — each crumb opens that entity. */
export function WorkspaceCrumbs({
  t,
  lineage,
  current,
}: {
  t: Translate;
  lineage: readonly GraphRef[];
  current?: string;
}) {
  return (
    <nav className="ws-crumbs" aria-label={t('ws_breadcrumb_label')}>
      <ol>
        <li>
          <a href="/w">{t('ws_overview_title')}</a>
        </li>
        {lineage.map((ref) => (
          <li key={`${ref.kind}:${ref.id}`}>
            <a href={entityHref(ref.kind, ref.id)}>
              <span className="ws-crumbs__kind">{kindLabel(t, ref.kind)}</span>
              {ref.label}
            </a>
          </li>
        ))}
        {current ? (
          <li aria-current="page">
            <span>{current}</span>
          </li>
        ) : null}
      </ol>
    </nav>
  );
}

/** Compact, non-interactive lineage for list rows. */
function RowLineage({ t, lineage }: { t: Translate; lineage: readonly GraphRef[] }) {
  if (!lineage.length) return <span className="ws-row__lineage">{t('ws_unscoped')}</span>;
  return (
    <span className="ws-row__lineage">
      {lineage.map((ref, index) => (
        <React.Fragment key={`${ref.kind}:${ref.id}`}>
          {index ? <span aria-hidden="true"> › </span> : null}
          <span title={kindLabel(t, ref.kind)}>{ref.label}</span>
        </React.Fragment>
      ))}
    </span>
  );
}

export function ActorChips({ t, actors }: { t: Translate; actors?: readonly GraphActorLink[] }) {
  if (!actors?.length) return null;
  return (
    <span className="ws-row__actors">
      {actors.map((actor) => (
        <Badge
          key={`${actor.actorId}:${actor.role}`}
          label={`${roleLabel(t, actor.role)}: ${actor.label ?? actor.actorId}`}
          tone="neutral"
        />
      ))}
    </span>
  );
}

/** One row of any entity list: what it is, its state, where it belongs and who is on it. */
export function EntityRow({
  t,
  node,
  labels,
  showKind = false,
  showLineage = true,
}: {
  t: Translate;
  node: GraphNode;
  labels?: ReadonlyMap<string, string>;
  showKind?: boolean;
  showLineage?: boolean;
}) {
  const linkable = node.kind !== 'task';
  return (
    <li className="ws-row">
      <div className="ws-row__main">
        {showKind ? <Badge label={kindLabel(t, node.kind)} tone="accent" /> : null}
        {linkable ? (
          <a className="ws-row__title" href={entityHref(node.kind, node.id)}>
            {node.label}
          </a>
        ) : (
          <span className="ws-row__title">{node.label}</span>
        )}
        <EntityStatus kind={node.kind} status={node.status} />
      </div>
      <div className="ws-row__meta">
        {showLineage ? <RowLineage t={t} lineage={nodeLineage(node, labels)} /> : null}
        <ActorChips t={t} actors={node.actors} />
      </div>
      {node.summary && node.summary !== node.label ? (
        <p className="ws-row__summary">{node.summary}</p>
      ) : null}
    </li>
  );
}

export function EntityList({
  t,
  items,
  labels,
  showKind,
  showLineage,
  label,
}: {
  t: Translate;
  items: readonly GraphNode[];
  labels?: ReadonlyMap<string, string>;
  showKind?: boolean;
  showLineage?: boolean;
  label?: string;
}) {
  return (
    <ul className="ws-list" aria-label={label}>
      {items.map((node) => (
        <EntityRow
          key={`${node.kind}:${node.id}`}
          t={t}
          node={node}
          labels={labels}
          showKind={showKind}
          showLineage={showLineage}
        />
      ))}
    </ul>
  );
}

function openDock() {
  window.dispatchEvent(new CustomEvent('concierge:open-dock'));
}

/** What the user can do when a kind has nothing to show yet. */
export function kindNextStep(
  t: Translate,
  kind: GraphEntityKind
): { label: string; href: string } | { label: string; onClick: () => void } | undefined {
  switch (kind) {
    case 'tenant':
    case 'actor':
      return { label: t('ws_open_settings'), href: '/settings' };
    case 'organization':
    case 'project':
      return { label: t('ws_open_editor'), href: '/management' };
    case 'mission':
    case 'work_item':
      return { label: t('ws_ask_for_work'), onClick: openDock };
    case 'approval':
      return { label: t('ws_open_inbox'), href: '/' };
    default:
      return undefined;
  }
}

/** Empty list: say what this kind is and how one comes to exist. */
export function KindEmptyState({
  t,
  kind,
  title,
}: {
  t: Translate;
  kind: GraphEntityKind;
  title?: string;
}) {
  return (
    <EmptyState
      title={title ?? t('ws_list_empty_title', { kind: kindsLabel(t, kind) })}
      body={`${t(`ws_about_${kind}`)} ${t(`ws_hint_${kind}`)}`}
      action={kindNextStep(t, kind)}
    />
  );
}

export function LoadingState({ t }: { t: Translate }) {
  return <Skeleton shape="table" lines={4} label={t('ws_loading')} />;
}

export function LoadErrorState({
  t,
  error,
  onRetry,
}: {
  t: Translate;
  error: WorkspaceLoadError;
  onRetry: () => void;
}) {
  if (error === 'signin')
    return (
      <Callout
        tone="warning"
        title={t('ws_error_signin')}
        action={{ label: t('ws_signin'), href: '/signin' }}
      />
    );
  if (error === 'forbidden') return <Callout tone="warning" title={t('ws_error_forbidden')} />;
  return (
    <Callout tone="danger" title={t('ws_error_title')} body={t('ws_error_body')}>
      <div className="ws-actions">
        <Button label={t('ws_retry')} variant="secondary" onClick={onRetry} />
      </div>
    </Callout>
  );
}

/** Store reads that failed: the page is partial, and says so without blocking. */
export function DegradedNotice({
  t,
  degraded,
}: {
  t: Translate;
  degraded?: ReadonlyArray<{ source: string }>;
}) {
  const sources = degradedSources(degraded);
  if (!sources.length) return null;
  return (
    <Callout
      tone="warning"
      title={t('ws_degraded_title')}
      body={t('ws_degraded_body', { sources: sources.join(', ') })}
    />
  );
}
