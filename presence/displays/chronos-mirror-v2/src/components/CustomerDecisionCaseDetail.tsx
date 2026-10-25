'use client';

import * as React from 'react';
import type { KbTableCell, KbTone } from '@agent/core/surface/a2ui-catalog';
import { Badge, Callout, Code, KbLink, Metric, Section, Skeleton } from '@agent/shared-ui';
import { ChronosInline, ChronosMeta } from './chronos-ui';
import { uxMessage, uxText, type SupportedLocale } from '../lib/ux-vocabulary';
import type {
  CaseTaskView,
  CustomerDecisionCaseDetailView,
} from '../lib/customer-decision-case-response';
import type { CustomerDecisionViewState } from '../lib/customer-decision-view-client';
import {
  CustomerDecisionRows,
  customerDecisionAgendaRow,
  customerDecisionAttentionItemRows,
} from './CustomerDecisionOverviewCard';
import type { CustomerDecisionHrefs } from '../lib/customer-decision-navigation';

/**
 * CD-12 drill-down: one case of the customer-decisions card — its agenda
 * sets (open one for its entries) and the mission tasks that wait on it.
 * Ids, statuses, dates and counts only, read through
 * `/api/customer-decisions/case`; acting stays in the CLI.
 */

export type { CustomerDecisionHrefs };

export interface CustomerDecisionCrumb {
  label: string;
  href?: string;
}

/** `nav > ol` breadcrumb; the last crumb is the current page (`aria-current`). */
export function CustomerDecisionBreadcrumb({
  crumbs,
  locale,
}: {
  crumbs: CustomerDecisionCrumb[];
  locale: SupportedLocale;
}) {
  return (
    <nav className="chronos-cd-breadcrumb" aria-label={uxText('chronos_cd_breadcrumb', locale)}>
      <ol>
        {crumbs.map((crumb, index) => {
          const current = index === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${index}`}>
              {current || !crumb.href ? (
                <span aria-current={current ? 'page' : undefined}>{crumb.label}</span>
              ) : (
                <KbLink href={crumb.href}>{crumb.label}</KbLink>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The view's heading, focused when the view opens (and when `focusKey`
 * changes) so keyboard and screen-reader users land on what they opened.
 */
export function CustomerDecisionDetailHeading({
  title,
  focusKey,
}: {
  title: string;
  focusKey: string;
}) {
  const ref = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    ref.current?.focus();
  }, [focusKey]);
  return (
    <h3 ref={ref} className="chronos-cd-detail__title" tabIndex={-1}>
      {title}
    </h3>
  );
}

/**
 * Everything but `ready`: loading skeleton, a retryable error, forbidden
 * (no retry: it would not help), not found (back to where the viewer came
 * from), not built (the server needs `pnpm build`).
 */
export function CustomerDecisionViewNotice<T>({
  state,
  locale,
  onRetry,
  backHref,
}: {
  state: CustomerDecisionViewState<T>;
  locale: SupportedLocale;
  onRetry?: () => void;
  backHref: string;
}) {
  if (state.kind === 'loading')
    return <Skeleton shape="card" lines={4} label={uxText('chronos_cd_loading_detail', locale)} />;
  if (state.kind === 'error')
    return (
      <Callout
        tone="danger"
        title={uxText('chronos_cd_detail_failed', locale)}
        body={state.message}
        action={
          onRetry ? { label: uxText('chronos_cd_retry', locale), onClick: onRetry } : undefined
        }
      />
    );
  if (state.kind === 'forbidden')
    return (
      <Callout
        tone="warning"
        title={uxText('chronos_cd_forbidden_title', locale)}
        body={uxText('chronos_cd_forbidden_body', locale)}
      />
    );
  if (state.kind === 'not_found')
    return (
      <Callout
        tone="warning"
        title={uxText('chronos_cd_not_found_title', locale)}
        body={state.message}
        action={{ label: uxText('chronos_cd_back', locale), href: backHref }}
      />
    );
  if (state.kind === 'not_built')
    return (
      <Callout
        tone="info"
        title={uxText('chronos_cd_not_built_title', locale)}
        body={uxText('chronos_cd_not_built_body', locale)}
      />
    );
  return null;
}

const TASK_TONE: Record<string, KbTone> = {
  held: 'warning',
  ready: 'success',
  in_progress: 'info',
  completed: 'neutral',
};

/** held (waits on a customer answer), ready (every answer is in), in progress, completed. */
export function customerDecisionTaskState(
  task: CaseTaskView
): 'held' | 'ready' | 'in_progress' | 'completed' {
  if (task.status === 'completed') return 'completed';
  if (task.hold && !task.hold.resolved_at) {
    const waiting = task.proposals.filter((proposal) => proposal.requires_customer);
    return waiting.length > 0 && waiting.every((proposal) => proposal.resolved_decision_id)
      ? 'ready'
      : 'held';
  }
  return 'in_progress';
}

export function customerDecisionTaskRows(
  detail: CustomerDecisionCaseDetailView,
  locale: SupportedLocale,
  missionOf: (missionId: string) => string
): Array<Record<string, KbTableCell>> {
  return detail.tasks.map((task) => {
    const state = customerDecisionTaskState(task);
    const waiting = task.proposals.filter(
      (proposal) => proposal.requires_customer && !proposal.resolved_decision_id
    ).length;
    return {
      mission: { title: task.mission_id, id: task.task_id, href: missionOf(task.mission_id) },
      state: { badge: uxText(`chronos_cd_task_${state}`, locale), tone: TASK_TONE[state] },
      proposals: uxMessage(
        'chronos_cd_task_proposals',
        { count: task.proposals_total, waiting },
        `${task.proposals_total} proposals`,
        locale
      ),
      hold: task.hold ? task.hold.at.slice(0, 10) : '',
      rework: task.rework.count,
    };
  });
}

/** The CLI verbs that act on one case. */
export function customerDecisionCaseCommands(tenant: string, caseId: string): string[] {
  return [
    `pnpm kyberion customer-decision status --tenant ${tenant} --case ${caseId}`,
    `pnpm kyberion customer-decision overview --tenant ${tenant} --case ${caseId} --detail`,
    `pnpm kyberion customer-decision remind --tenant ${tenant} --case ${caseId} --dry-run`,
  ];
}

/** Presentational case view (rendered statically in tests). */
export function CustomerDecisionCasePanel({
  state,
  tenant,
  caseId,
  locale,
  hrefs,
  onRetry,
}: {
  state: CustomerDecisionViewState<CustomerDecisionCaseDetailView>;
  tenant: string;
  caseId: string;
  locale: SupportedLocale;
  hrefs: CustomerDecisionHrefs;
  onRetry?: () => void;
}) {
  const detail = state.kind === 'ready' ? state.value : null;
  const hiddenAgendas = detail ? Math.max(0, detail.agendas_total - detail.agendas.length) : 0;
  const hiddenTasks = detail ? Math.max(0, detail.tasks_total - detail.tasks.length) : 0;
  const tasks = detail?.task_counts;
  return (
    <div className="chronos-cd chronos-cd-detail">
      <Section headingLevel={3}>
        <CustomerDecisionBreadcrumb
          locale={locale}
          crumbs={[
            { label: uxText('chronos_cd_title', locale), href: hrefs.overview },
            { label: caseId },
          ]}
        />
        <CustomerDecisionDetailHeading
          title={uxMessage('chronos_cd_case_heading', { case: caseId }, `Case ${caseId}`, locale)}
          focusKey={`case:${caseId}`}
        />
        <p className="kb-visually-hidden" aria-live="polite">
          {state.kind === 'loading'
            ? uxText('chronos_cd_loading_detail', locale)
            : detail
              ? uxMessage(
                  'chronos_cd_case_loaded',
                  { agendas: detail.agendas_total, tasks: detail.tasks_total },
                  `${detail.agendas_total} agenda sets`,
                  locale
                )
              : ''}
        </p>
        <CustomerDecisionViewNotice
          state={state}
          locale={locale}
          onRetry={onRetry}
          backHref={hrefs.overview}
        />
        {detail && tasks ? (
          <>
            <ChronosInline>
              <Badge label={`${uxText('chronos_tenant', locale)}: ${detail.tenant_slug}`} />
              {detail.draft_only ? (
                <Badge label={uxText('chronos_cd_case_draft_only', locale)} tone="neutral" />
              ) : null}
              <ChronosMeta>
                {uxMessage('chronos_cd_as_of', { date: detail.today }, detail.today, locale)}
              </ChronosMeta>
            </ChronosInline>

            <div className="chronos-metrics">
              <Metric
                label={uxText('chronos_cd_metric_agendas', locale)}
                value={detail.agendas_total}
              />
              <Metric
                label={uxText('chronos_cd_metric_held_tasks', locale)}
                value={tasks.held}
                tone={tasks.held > 0 ? 'warning' : undefined}
              />
              <Metric
                label={uxText('chronos_cd_metric_ready_tasks', locale)}
                value={tasks.ready_to_resume}
                tone={tasks.ready_to_resume > 0 ? 'success' : undefined}
              />
              <Metric
                label={uxText('chronos_cd_metric_pending_proposals', locale)}
                value={tasks.pending_proposals}
              />
            </div>

            {detail.attention.length > 0 ? (
              <Section headingLevel={4} title={uxText('chronos_cd_attention', locale)}>
                <CustomerDecisionRows
                  caption={uxText('chronos_cd_attention', locale)}
                  columns={[
                    {
                      key: 'reason',
                      label: uxText('chronos_cd_col_reason', locale),
                      width: '12rem',
                    },
                    { key: 'item', label: uxText('chronos_cd_col_item', locale) },
                    { key: 'count', label: uxText('chronos_cd_col_count', locale), width: '5rem' },
                    { key: 'due', label: uxText('chronos_cd_col_due', locale) },
                  ]}
                  rows={customerDecisionAttentionItemRows(detail.attention, locale, hrefs)}
                  row_href_key="href"
                />
              </Section>
            ) : null}

            <Section headingLevel={4} title={uxText('chronos_cd_agendas', locale)}>
              {detail.agendas.length > 0 ? (
                <CustomerDecisionRows
                  caption={uxMessage(
                    'chronos_cd_agendas_caption',
                    { case: caseId },
                    `Agenda sets of ${caseId}`,
                    locale
                  )}
                  columns={[
                    { key: 'agenda', label: uxText('chronos_cd_col_agenda', locale) },
                    {
                      key: 'status',
                      label: uxText('chronos_cd_col_status', locale),
                      width: '8rem',
                    },
                    { key: 'counts', label: uxText('chronos_cd_col_counts', locale) },
                    { key: 'respond_by', label: uxText('chronos_cd_col_respond_by', locale) },
                    { key: 'override', label: uxText('chronos_cd_col_override', locale) },
                    { key: 'open', label: uxText('chronos_cd_col_open', locale) },
                  ]}
                  rows={detail.agendas.map((agenda) =>
                    customerDecisionAgendaRow(
                      agenda,
                      locale,
                      hrefs.agendaOf(caseId, agenda.agenda_id)
                    )
                  )}
                  row_href_key="href"
                />
              ) : (
                <p className="kb-text kb-text--muted">{uxText('chronos_cd_no_agendas', locale)}</p>
              )}
              {hiddenAgendas > 0 ? (
                <ChronosMeta>
                  {uxMessage(
                    'chronos_cd_attention_more',
                    { count: hiddenAgendas },
                    `${hiddenAgendas} more`,
                    locale
                  )}
                </ChronosMeta>
              ) : null}
            </Section>

            <Section
              headingLevel={4}
              title={uxText('chronos_cd_tasks', locale)}
              description={uxText('chronos_cd_tasks_description', locale)}
            >
              {detail.tasks.length > 0 ? (
                <CustomerDecisionRows
                  caption={uxText('chronos_cd_tasks', locale)}
                  columns={[
                    { key: 'mission', label: uxText('chronos_cd_col_mission', locale) },
                    {
                      key: 'state',
                      label: uxText('chronos_cd_col_status', locale),
                      width: '9rem',
                    },
                    { key: 'proposals', label: uxText('chronos_cd_col_proposals', locale) },
                    { key: 'hold', label: uxText('chronos_cd_col_held_since', locale) },
                    {
                      key: 'rework',
                      label: uxText('chronos_cd_col_rework', locale),
                      width: '6rem',
                    },
                  ]}
                  rows={customerDecisionTaskRows(detail, locale, hrefs.missionOf)}
                />
              ) : (
                <p className="kb-text kb-text--muted">{uxText('chronos_cd_no_tasks', locale)}</p>
              )}
              {hiddenTasks > 0 ? (
                <ChronosMeta>
                  {uxMessage(
                    'chronos_cd_attention_more',
                    { count: hiddenTasks },
                    `${hiddenTasks} more`,
                    locale
                  )}
                </ChronosMeta>
              ) : null}
            </Section>

            <Code
              title={uxText('chronos_cd_how_to_act', locale)}
              language="shell"
              code={customerDecisionCaseCommands(tenant, caseId).join('\n')}
            />
          </>
        ) : null}
      </Section>
    </div>
  );
}
