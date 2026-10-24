'use client';

import * as React from 'react';
import type { KbTableCell, KbTone } from '@agent/core/surface/a2ui-catalog';
import {
  Badge,
  Callout,
  Code,
  Disclosure,
  EmptyState,
  Metric,
  Section,
  Skeleton,
  Table,
} from '@agent/shared-ui';
import { ChronosInline, ChronosMeta } from './chronos-ui';
import { useChronosLocale } from '../lib/hooks';
import { uxMessage, uxText, type SupportedLocale } from '../lib/ux-vocabulary';
import {
  parseCustomerDecisionOverviewResponse,
  type AgendaOverviewView,
  type CaseOverviewView,
  type CustomerDecisionOverviewView,
  type OverviewAgendaStatus,
  type OverviewAttentionReason,
} from '../lib/customer-decision-overview-response';

/**
 * CD-12: the "customer decisions" card of the organization view. Counts,
 * case / agenda-set names and dates of one tenant, read through
 * `/api/customer-decisions/overview`; acting stays in the CLI.
 */

export const CUSTOMER_DECISION_ATTENTION_LIMIT = 8;
const REFRESH_MS = 30_000;

const REASON_TONE: Record<OverviewAttentionReason, KbTone> = {
  respond_by_overdue: 'danger',
  awaiting_operator_confirmation: 'danger',
  open_change_requests: 'warning',
  pending_handoffs: 'warning',
  override_closing_soon: 'warning',
  respond_by_due_soon: 'warning',
  reminders_due: 'info',
  held_tasks: 'info',
  awaiting_customer: 'neutral',
  pending_task_proposals: 'neutral',
};

const AGENDA_STATUS_TONE: Record<OverviewAgendaStatus, KbTone> = {
  draft: 'neutral',
  pending_approval: 'warning',
  approved: 'info',
  sent: 'accent',
  closed: 'success',
  withdrawn: 'neutral',
};

export function customerDecisionReasonLabel(
  reason: OverviewAttentionReason,
  locale: SupportedLocale
): string {
  return uxText(`chronos_cd_reason_${reason}`, locale);
}

/** "today", "in 2 days", "3 days overdue". */
export function customerDecisionDaysLabel(days: number, locale: SupportedLocale): string {
  if (days === 0) return uxText('chronos_cd_days_today', locale);
  if (days > 0) return uxMessage('chronos_cd_days_left', { days }, `in ${days} days`, locale);
  const overdue = -days;
  return uxMessage('chronos_cd_days_overdue', { days: overdue }, `${overdue} days overdue`, locale);
}

/** A due date (`YYYY-MM-DD` or ISO) with its day offset. */
export function customerDecisionDueLabel(
  due: string | null | undefined,
  days: number | null | undefined,
  locale: SupportedLocale
): string {
  if (!due) return uxText('chronos_cd_none', locale);
  const date = due.slice(0, 10);
  return typeof days === 'number' ? `${date} (${customerDecisionDaysLabel(days, locale)})` : date;
}

/** The CLI verbs that act on what the card shows. */
export function customerDecisionCommands(tenant: string): string[] {
  return [
    `pnpm kyberion customer-decision status --tenant ${tenant} --case <case>`,
    `pnpm kyberion customer-decision confirm --tenant ${tenant} --case <case> --agenda <id> --entry <entry_id> --by user:<member>`,
    `pnpm kyberion customer-decision draft --tenant ${tenant} --case <case> --from-tasks --customer <customer>`,
  ];
}

export function customerDecisionAttentionRows(
  overview: CustomerDecisionOverviewView,
  locale: SupportedLocale,
  limit = CUSTOMER_DECISION_ATTENTION_LIMIT
): Array<Record<string, KbTableCell>> {
  return overview.attention.slice(0, limit).map((item) => ({
    reason: {
      badge: customerDecisionReasonLabel(item.reason, locale),
      tone: REASON_TONE[item.reason],
    },
    item: {
      title: item.title || item.case_id,
      id: item.agenda_id ? `${item.case_id} / ${item.agenda_id}` : item.case_id,
    },
    count: item.count,
    due: item.due ? customerDecisionDueLabel(item.due, item.days, locale) : '',
  }));
}

export function customerDecisionAgendaRow(
  agenda: AgendaOverviewView,
  locale: SupportedLocale
): Record<string, KbTableCell> {
  const counts = agenda.counts;
  return {
    agenda: { title: agenda.title, id: `${agenda.agenda_id} · r${agenda.revision}` },
    status: {
      badge: uxText(`chronos_cd_agenda_status_${agenda.status}`, locale),
      tone: AGENDA_STATUS_TONE[agenda.status],
    },
    counts: uxMessage(
      'chronos_cd_counts',
      {
        confirmed: counts.confirmed,
        provisional: counts.provisional,
        customer: counts.awaiting_customer,
        operator: counts.awaiting_operator_confirmation,
        undecided: counts.undecided,
      },
      `${counts.confirmed} confirmed · ${counts.provisional} provisional`,
      locale
    ),
    respond_by: customerDecisionDueLabel(agenda.respond_by, agenda.respond_by_days, locale),
    override: agenda.next_override_deadline
      ? customerDecisionDueLabel(
          agenda.next_override_deadline.at,
          agenda.next_override_deadline.days,
          locale
        )
      : uxText('chronos_cd_none', locale),
    open: uxMessage(
      'chronos_cd_open_cell',
      {
        changes: agenda.open_change_requests,
        handoffs: agenda.pending_handoffs,
        deciders: agenda.unanswered_deciders,
      },
      `${agenda.open_change_requests} change requests · ${agenda.pending_handoffs} hand-offs`,
      locale
    ),
  };
}

const AGENDA_STATUS_ORDER: readonly OverviewAgendaStatus[] = [
  'sent',
  'approved',
  'pending_approval',
  'draft',
  'closed',
  'withdrawn',
];

/**
 * A case's header: its agenda sets by status ("1 sent · 1 approved"), and
 * "not sent yet" only when none of them was sent or approved.
 */
export function customerDecisionCaseSummary(
  item: Pick<CaseOverviewView, 'case_id' | 'agendas'>,
  locale: SupportedLocale
): string {
  const statuses = AGENDA_STATUS_ORDER.flatMap((status) => {
    const count = item.agendas.filter((agenda) => agenda.status === status).length;
    return count > 0
      ? [
          uxMessage(
            'chronos_cd_status_count',
            { count, status: uxText(`chronos_cd_agenda_status_${status}`, locale) },
            `${count} ${status}`,
            locale
          ),
        ]
      : [];
  });
  const reached = item.agendas.some(
    (agenda) => agenda.status === 'sent' || agenda.status === 'approved'
  );
  return [
    item.case_id,
    uxMessage(
      'chronos_cd_case_summary',
      { count: item.agendas.length },
      `${item.agendas.length} agenda sets`,
      locale
    ),
    ...statuses,
    ...(!reached && item.agendas.length > 0 ? [uxText('chronos_cd_case_draft_only', locale)] : []),
  ].join(' · ');
}

function StackedCell({ cell }: { cell: KbTableCell }) {
  if (typeof cell !== 'object') return <>{String(cell)}</>;
  if ('badge' in cell) return <Badge label={cell.badge} tone={cell.tone} />;
  if ('title' in cell)
    return (
      <span className="chronos-cd-card__title">
        <strong>{cell.title}</strong>
        {cell.id ? <code className="chronos-cd-card__id">{cell.id}</code> : null}
      </span>
    );
  return <>{cell.label ?? cell.status}</>;
}

/**
 * A table on a wide card; under a narrow card (CSS container query in
 * globals.css, `.chronos-cd`) the same rows as stacked cards of label: value
 * pairs, so no column is squeezed and nothing scrolls sideways.
 */
export function CustomerDecisionRows({
  columns,
  rows,
}: {
  columns: Array<{ key: string; label: string; width?: string }>;
  rows: Array<Record<string, KbTableCell>>;
}) {
  const [head, ...rest] = columns;
  return (
    <div className="chronos-cd-rows">
      <div className="chronos-cd-rows__wide">
        <Table columns={columns} rows={rows} />
      </div>
      <ul className="chronos-cd-rows__stacked">
        {rows.map((row, index) => (
          <li key={index} className="chronos-cd-card">
            <div className="chronos-cd-card__head">
              <StackedCell cell={row[head.key]} />
            </div>
            <dl className="chronos-cd-card__fields">
              {rest
                .filter((column) => row[column.key] !== '' && row[column.key] != null)
                .map((column) => (
                  <div key={column.key} className="chronos-cd-card__field">
                    <dt>{column.label}</dt>
                    <dd>
                      <StackedCell cell={row[column.key]} />
                    </dd>
                  </div>
                ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CaseRows({ item, locale }: { item: CaseOverviewView; locale: SupportedLocale }) {
  const summary = customerDecisionCaseSummary(item, locale);
  const tasks = item.tasks;
  return (
    <Disclosure summary={summary}>
      {item.agendas.length > 0 ? (
        <CustomerDecisionRows
          columns={[
            { key: 'agenda', label: uxText('chronos_cd_col_agenda', locale) },
            { key: 'status', label: uxText('chronos_cd_col_status', locale), width: '8rem' },
            { key: 'counts', label: uxText('chronos_cd_col_counts', locale) },
            { key: 'respond_by', label: uxText('chronos_cd_col_respond_by', locale) },
            { key: 'override', label: uxText('chronos_cd_col_override', locale) },
            { key: 'open', label: uxText('chronos_cd_col_open', locale) },
          ]}
          rows={item.agendas.map((agenda) => customerDecisionAgendaRow(agenda, locale))}
        />
      ) : null}
      {tasks.held + tasks.pending_proposals + tasks.ready_to_resume > 0 ? (
        <p className="kb-text kb-text--muted">
          {uxMessage(
            'chronos_cd_case_tasks',
            {
              held: tasks.held,
              proposals: tasks.pending_proposals,
              ready: tasks.ready_to_resume,
            },
            `${tasks.held} held tasks`,
            locale
          )}
        </p>
      ) : null}
    </Disclosure>
  );
}

export type CustomerDecisionOverviewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; overview: CustomerDecisionOverviewView };

/** Presentational card body (rendered statically in tests). */
export function CustomerDecisionOverviewPanel({
  state,
  tenant,
  locale,
  busy = false,
  onRefresh,
}: {
  state: CustomerDecisionOverviewState;
  tenant: string;
  locale: SupportedLocale;
  busy?: boolean;
  onRefresh?: () => void;
}) {
  const overview = state.kind === 'ready' ? state.overview : null;
  const counts = overview?.totals.counts;
  const hidden = overview
    ? Math.max(0, overview.attention.length - CUSTOMER_DECISION_ATTENTION_LIMIT)
    : 0;
  return (
    <div className="chronos-cd">
      <Section
        headingLevel={3}
        title={uxText('chronos_cd_title', locale)}
        description={uxText('chronos_cd_description', locale)}
        actions={
          onRefresh
            ? [
                {
                  label: busy
                    ? uxText('chronos_ac_refreshing', locale)
                    : uxText('chronos_org_refresh', locale),
                  variant: 'ghost',
                  disabled: busy,
                  onClick: onRefresh,
                },
              ]
            : undefined
        }
      >
        {state.kind === 'error' ? (
          <Callout
            tone="danger"
            title={uxText('chronos_cd_load_failed', locale)}
            body={state.message}
          />
        ) : null}
        {state.kind === 'loading' ? (
          <Skeleton shape="card" lines={3} label={uxText('chronos_cd_loading', locale)} />
        ) : null}
        {overview && counts ? (
          overview.totals.cases === 0 && overview.case_failures.length === 0 ? (
            <EmptyState
              title={uxText('chronos_cd_empty_title', locale)}
              body={uxText('chronos_cd_empty_body', locale)}
            />
          ) : (
            <>
              <ChronosInline>
                <Badge label={`${uxText('chronos_tenant', locale)}: ${overview.tenant_slug}`} />
                <ChronosMeta>
                  {uxMessage(
                    'chronos_cd_totals',
                    {
                      cases: overview.totals.cases,
                      open: overview.totals.open_agendas,
                      entries: overview.totals.entries,
                      date: overview.today,
                    },
                    `${overview.totals.cases} cases`,
                    locale
                  )}
                </ChronosMeta>
              </ChronosInline>

              <div className="chronos-metrics">
                <Metric
                  label={uxText('chronos_cd_metric_provisional', locale)}
                  value={counts.provisional}
                  tone={counts.provisional > 0 ? 'warning' : undefined}
                  description={uxText('chronos_cd_metric_provisional_detail', locale)}
                />
                <Metric
                  label={uxText('chronos_cd_metric_awaiting_customer', locale)}
                  value={counts.awaiting_customer}
                />
                <Metric
                  label={uxText('chronos_cd_metric_awaiting_operator', locale)}
                  value={counts.awaiting_operator_confirmation}
                  tone={counts.awaiting_operator_confirmation > 0 ? 'danger' : undefined}
                />
                <Metric
                  label={uxText('chronos_cd_metric_change_requests', locale)}
                  value={overview.totals.open_change_requests}
                  tone={overview.totals.open_change_requests > 0 ? 'warning' : undefined}
                />
                <Metric
                  label={uxText('chronos_cd_metric_handoffs', locale)}
                  value={overview.totals.pending_handoffs}
                  tone={overview.totals.pending_handoffs > 0 ? 'warning' : undefined}
                />
                <Metric
                  label={uxText('chronos_cd_metric_held_tasks', locale)}
                  value={overview.totals.held_tasks}
                />
              </div>

              {overview.case_failures.length > 0 ? (
                <Callout
                  tone="warning"
                  title={uxMessage(
                    'chronos_cd_case_failures',
                    { count: overview.case_failures.length },
                    `${overview.case_failures.length} cases could not be read`,
                    locale
                  )}
                  body={overview.case_failures.map((failure) => failure.case_id).join(', ')}
                />
              ) : null}

              <Section headingLevel={4} title={uxText('chronos_cd_attention', locale)}>
                {overview.attention.length > 0 ? (
                  <>
                    <CustomerDecisionRows
                      columns={[
                        {
                          key: 'reason',
                          label: uxText('chronos_cd_col_reason', locale),
                          width: '12rem',
                        },
                        { key: 'item', label: uxText('chronos_cd_col_item', locale) },
                        {
                          key: 'count',
                          label: uxText('chronos_cd_col_count', locale),
                          width: '5rem',
                        },
                        { key: 'due', label: uxText('chronos_cd_col_due', locale) },
                      ]}
                      rows={customerDecisionAttentionRows(overview, locale)}
                    />
                    {hidden > 0 ? (
                      <ChronosMeta>
                        {uxMessage(
                          'chronos_cd_attention_more',
                          { count: hidden },
                          `${hidden} more`,
                          locale
                        )}
                      </ChronosMeta>
                    ) : null}
                  </>
                ) : (
                  <Callout tone="success" title={uxText('chronos_cd_attention_none', locale)} />
                )}
              </Section>

              {overview.cases.length > 0 ? (
                <Section headingLevel={4} title={uxText('chronos_cd_cases', locale)}>
                  {overview.cases.map((item) => (
                    <CaseRows key={item.case_id} item={item} locale={locale} />
                  ))}
                </Section>
              ) : null}

              <Code
                title={uxText('chronos_cd_how_to_act', locale)}
                language="shell"
                code={customerDecisionCommands(tenant).join('\n')}
              />
            </>
          )
        ) : null}
      </Section>
    </div>
  );
}

/** The card: fetches the viewer-scoped overview of `tenant` and refreshes it. */
export function CustomerDecisionOverviewCard({ tenant }: { tenant: string }) {
  const locale = useChronosLocale();
  const [state, setState] = React.useState<CustomerDecisionOverviewState>({ kind: 'loading' });
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/customer-decisions/overview?${new URLSearchParams({ tenant }).toString()}`,
        { cache: 'no-store' }
      );
      const raw: unknown = await response.json().catch(() => null);
      const overview = response.ok ? parseCustomerDecisionOverviewResponse(raw, tenant) : undefined;
      if (!overview) {
        const message =
          raw && typeof raw === 'object' && 'error' in raw && typeof raw.error === 'string'
            ? raw.error
            : `customer decisions ${response.status}`;
        throw new Error(message);
      }
      setState({ kind: 'ready', overview });
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }, [tenant]);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <CustomerDecisionOverviewPanel
      state={state}
      tenant={tenant}
      locale={locale}
      busy={busy}
      onRefresh={() => void refresh()}
    />
  );
}
