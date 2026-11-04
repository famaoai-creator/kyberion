'use client';

import * as React from 'react';
import { Badge, Button, Callout, EmptyState, Skeleton, StatusPill } from '@agent/shared-ui';
import type { KbStatus, KbStatusDomain } from '@agent/core/surface/a2ui-catalog';
import { conciergeText, type ConciergeMessageKey } from '../../lib/i18n';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import {
  actorDisplayName,
  cardSummary,
  parseDecisionBrief,
  renderDisplayText,
} from '../../lib/decision-brief-view';
import { BriefStateBadge } from '../decision-brief';
import { frontDeskFetch } from '../../lib/front-desk-fetch';
import { parseConciergeSummaryResponse } from '../../lib/summary-event';
import type { DecisionBrief } from '../../lib/decision-brief-view';
import { groupByDecision } from '@agent/core/surface/decision-brief';
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
  const { locale } = useConciergeI18n();
  if (!actors?.length) return null;
  return (
    <span className="ws-row__actors">
      {actors.map((actor) => (
        <Badge
          key={`${actor.actorId}:${actor.role}`}
          // Names, never ids: an unknown machine actor reads as "自動処理（…）".
          label={`${roleLabel(t, actor.role)}: ${actorDisplayName(actor.actorId, locale, actor.label)}`}
          tone="neutral"
        />
      ))}
    </span>
  );
}

const ApprovalBriefs = React.createContext<ReadonlyMap<string, DecisionBrief>>(new Map());

/**
 * The graph is read by a never-tenant-bound reader, so its approval briefs use
 * generic sentences. The viewer-scoped inbox summary carries the richer brief
 * (e.g. the PR's repository and title); pages wrap their lists in this
 * provider so rows use it when the same approval is there. Display only.
 */
export function ApprovalBriefsProvider({ children }: { children: React.ReactNode }) {
  const [briefs, setBriefs] = React.useState<ReadonlyMap<string, DecisionBrief>>(new Map());
  React.useEffect(() => {
    const controller = new AbortController();
    frontDeskFetch('/api/summary', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const summary = parseConciergeSummaryResponse(await response.json().catch(() => null));
        if (!response.ok || !summary || controller.signal.aborted) return;
        setBriefs(
          new Map(
            summary.approval_queue.flatMap((item) =>
              item.brief ? [[item.id, item.brief] as const] : []
            )
          )
        );
      })
      .catch(() => {
        // Advisory: rows keep the graph's own brief.
      });
    return () => controller.abort();
  }, []);
  return <ApprovalBriefs.Provider value={briefs}>{children}</ApprovalBriefs.Provider>;
}

/** The viewer-scoped approval briefs, by approval id (empty outside the provider). */
export function useApprovalBriefs(): ReadonlyMap<string, DecisionBrief> {
  return React.useContext(ApprovalBriefs);
}

/** The best brief for an approval node: the viewer-scoped one, else the graph's own. */
export function useNodeBrief(node: GraphNode): DecisionBrief | undefined {
  const briefs = React.useContext(ApprovalBriefs);
  if (node.kind !== 'approval') return undefined;
  return briefs.get(node.id) ?? parseDecisionBrief(node.brief);
}

/** What a list row / page calls a node: an approval's plain-language ask, else its label. */
export function nodeTitle(
  node: GraphNode,
  locale: 'en' | 'ja',
  brief: DecisionBrief | undefined = node.kind === 'approval'
    ? parseDecisionBrief(node.brief)
    : undefined
): string {
  return brief ? renderDisplayText(brief.ask, locale) : node.label;
}

/** One row of any entity list: what it is, its state, where it belongs and who is on it. */
export function EntityRow({
  t,
  node,
  labels,
  showKind = false,
  showLineage = true,
  sameCount,
}: {
  t: Translate;
  node: GraphNode;
  labels?: ReadonlyMap<string, string>;
  showKind?: boolean;
  showLineage?: boolean;
  /** Identical requests folded into this row ("同じ依頼が N 件"), lead included. */
  sameCount?: number;
}) {
  const { locale } = useConciergeI18n();
  const linkable = node.kind !== 'task';
  const brief = useNodeBrief(node);
  const title = nodeTitle(node, locale, brief);
  // Approvals say why they need a person; other rows show their summary with
  // hashes, paths and JSON removed, clamped to about two lines.
  const summary = brief?.why[0]
    ? renderDisplayText(brief.why[0], locale)
    : node.summary && node.summary !== node.label
      ? cardSummary(node.summary).short
      : '';
  return (
    <li className="ws-row">
      <div className="ws-row__main">
        {showKind ? <Badge label={kindLabel(t, node.kind)} tone="accent" /> : null}
        {linkable ? (
          <a className="ws-row__title" href={entityHref(node.kind, node.id)}>
            {title}
          </a>
        ) : (
          <span className="ws-row__title">{title}</span>
        )}
        <EntityStatus kind={node.kind} status={node.status} />
        <BriefStateBadge brief={brief} locale={locale} />
        {sameCount && sameCount > 1 ? (
          <Badge
            label={conciergeText('ux_a_brief_same_count', locale, { count: sameCount })}
            tone="info"
          />
        ) : null}
      </div>
      <div className="ws-row__meta">
        {showLineage ? <RowLineage t={t} lineage={nodeLineage(node, labels)} /> : null}
        <ActorChips t={t} actors={node.actors} />
      </div>
      {summary ? <p className="ws-row__summary">{summary}</p> : null}
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
  groupSame = false,
}: {
  t: Translate;
  items: readonly GraphNode[];
  labels?: ReadonlyMap<string, string>;
  showKind?: boolean;
  showLineage?: boolean;
  label?: string;
  /** Fold approvals that ask the same thing into one row with a count. */
  groupSame?: boolean;
}) {
  const briefs = React.useContext(ApprovalBriefs);
  const rows = groupSame
    ? groupByDecision(
        items.map((node) => ({
          node,
          brief:
            node.kind === 'approval'
              ? (briefs.get(node.id) ?? parseDecisionBrief(node.brief))
              : undefined,
        }))
      ).map((group) => ({ node: group.lead.node, sameCount: group.others.length + 1 }))
    : items.map((node) => ({ node, sameCount: 1 }));
  return (
    <ul className="ws-list" aria-label={label}>
      {rows.map(({ node, sameCount }) => (
        <EntityRow
          key={`${node.kind}:${node.id}`}
          t={t}
          node={node}
          labels={labels}
          showKind={showKind}
          showLineage={showLineage}
          sameCount={sameCount}
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
