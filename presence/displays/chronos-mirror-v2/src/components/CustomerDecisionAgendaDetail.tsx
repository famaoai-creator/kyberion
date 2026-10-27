'use client';

import type { KbTableCell, KbTone } from '@agent/core/surface/a2ui-catalog';
import { Badge, Callout, Code, Disclosure, KeyValue, Section } from '@agent/shared-ui';
import { ChronosInline, ChronosMeta } from './chronos-ui';
import { uxMessage, uxText, type SupportedLocale } from '../lib/ux-vocabulary';
import type {
  CaseAgendaView,
  CaseEntryView,
  CustomerDecisionCaseDetailView,
} from '../lib/customer-decision-case-response';
import type { CustomerDecisionViewState } from '../lib/customer-decision-view-client';
import type { OverviewEntryStatus } from '../lib/customer-decision-overview-response';
import {
  CustomerDecisionBreadcrumb,
  CustomerDecisionDetailHeading,
  CustomerDecisionViewNotice,
  type CustomerDecisionHrefs,
} from './CustomerDecisionCaseDetail';
import { CustomerDecisionRows, customerDecisionAgendaRow } from './CustomerDecisionOverviewCard';

/**
 * CD-12 drill-down: one agenda set of a case — its entries (status, layer,
 * the question cut to 200 characters), and what is open around it: change
 * requests, hand-offs, reminders, invites and Bolt-review routing. Never a
 * decision value, option, rationale, comment or participant name: the
 * response does not carry them. A client-side selection of the case response.
 */

const ENTRY_STATUS_TONE: Record<OverviewEntryStatus, KbTone> = {
  confirmed: 'success',
  provisional: 'warning',
  awaiting_customer: 'info',
  awaiting_operator_confirmation: 'danger',
  undecided: 'neutral',
};

/** Commands listed per entry awaiting confirmation (the rest: the placeholder form). */
const CONFIRM_COMMAND_LIMIT = 5;

function yesNo(value: boolean, locale: SupportedLocale): string {
  return uxText(value ? 'chronos_cd_yes' : 'chronos_cd_no', locale);
}

export function customerDecisionEntryRows(
  entries: CaseEntryView[],
  locale: SupportedLocale
): Array<Record<string, KbTableCell>> {
  return entries.map((entry) => ({
    entry: { title: entry.question, id: `${entry.entry_id} · ${entry.item} / ${entry.key}` },
    status: {
      badge: uxText(`chronos_cd_entry_status_${entry.status}`, locale),
      tone: ENTRY_STATUS_TONE[entry.status],
    },
    layer: uxText(`chronos_cd_layer_${entry.layer}`, locale),
    override: entry.override_until_at
      ? entry.override_until_at.slice(0, 10)
      : uxText('chronos_cd_none', locale),
    confirmed: yesNo(entry.operator_confirmed, locale),
    extras: uxMessage(
      'chronos_cd_entry_extras',
      { attachments: entry.attachment_count, links: entry.link_count },
      `${entry.attachment_count} attachments · ${entry.link_count} links`,
      locale
    ),
  }));
}

/** The CLI verbs for one agenda set, with its real ids filled in. */
export function customerDecisionAgendaCommands(
  tenant: string,
  caseId: string,
  agenda: CaseAgendaView
): string[] {
  const scope = `--tenant ${tenant} --case ${caseId} --agenda ${agenda.agenda_id}`;
  const awaiting = agenda.entries.filter(
    (entry) => entry.status === 'awaiting_operator_confirmation'
  );
  const confirms = awaiting.length
    ? awaiting
        .slice(0, CONFIRM_COMMAND_LIMIT)
        .map(
          (entry) =>
            `pnpm kyberion customer-decision confirm ${scope} --entry ${entry.entry_id} --by user:<member>`
        )
    : [`pnpm kyberion customer-decision confirm ${scope} --entry <entry_id> --by user:<member>`];
  return [
    `pnpm kyberion customer-decision status ${scope}`,
    ...confirms,
    `pnpm kyberion customer-decision remind --tenant ${tenant} --case ${caseId} --dry-run`,
  ];
}

function MoreNote({
  total,
  shown,
  locale,
}: {
  total: number;
  shown: number;
  locale: SupportedLocale;
}) {
  const hidden = Math.max(0, total - shown);
  if (hidden === 0) return null;
  return (
    <ChronosMeta>
      {uxMessage('chronos_cd_attention_more', { count: hidden }, `${hidden} more`, locale)}
    </ChronosMeta>
  );
}

function disclosureSummary(key: string, count: number, locale: SupportedLocale): string {
  return uxMessage(key, { count }, `${count}`, locale);
}

function AgendaBody({
  detail,
  agenda,
  tenant,
  locale,
}: {
  detail: CustomerDecisionCaseDetailView;
  agenda: CaseAgendaView;
  tenant: string;
  locale: SupportedLocale;
}) {
  const reminders = agenda.reminders;
  const invites = agenda.invites;
  return (
    <>
      <ChronosInline>
        <Badge label={`${uxText('chronos_tenant', locale)}: ${detail.tenant_slug}`} />
        <Badge
          label={uxText(`chronos_cd_agenda_status_${agenda.status}`, locale)}
          tone={agenda.status === 'sent' ? 'accent' : 'neutral'}
        />
        <ChronosMeta mono>{`${agenda.agenda_id} · r${agenda.revision}`}</ChronosMeta>
        <ChronosMeta>
          {uxMessage(
            'chronos_cd_agenda_meta',
            { customer: agenda.customer, phase: agenda.phase, locale: agenda.locale },
            `${agenda.customer} · ${agenda.phase}`,
            locale
          )}
        </ChronosMeta>
      </ChronosInline>

      <CustomerDecisionRows
        caption={uxText('chronos_cd_agenda_summary', locale)}
        columns={[
          { key: 'counts', label: uxText('chronos_cd_col_counts', locale) },
          { key: 'respond_by', label: uxText('chronos_cd_col_respond_by', locale) },
          { key: 'override', label: uxText('chronos_cd_col_override', locale) },
          { key: 'open', label: uxText('chronos_cd_col_open', locale) },
        ]}
        rows={[customerDecisionAgendaRow(agenda, locale)]}
      />

      <Section headingLevel={4} title={uxText('chronos_cd_entries', locale)}>
        {agenda.entries.length > 0 ? (
          <CustomerDecisionRows
            caption={uxMessage(
              'chronos_cd_entries_caption',
              { title: agenda.title },
              agenda.title,
              locale
            )}
            columns={[
              { key: 'entry', label: uxText('chronos_cd_col_question', locale) },
              { key: 'status', label: uxText('chronos_cd_col_status', locale), width: '10rem' },
              { key: 'layer', label: uxText('chronos_cd_col_layer', locale), width: '8rem' },
              { key: 'override', label: uxText('chronos_cd_col_override', locale), width: '8rem' },
              {
                key: 'confirmed',
                label: uxText('chronos_cd_col_confirmed', locale),
                width: '6rem',
              },
              { key: 'extras', label: uxText('chronos_cd_col_extras', locale) },
            ]}
            rows={customerDecisionEntryRows(agenda.entries, locale)}
          />
        ) : (
          <p className="kb-text kb-text--muted">{uxText('chronos_cd_no_entries', locale)}</p>
        )}
        <MoreNote total={agenda.entries_total} shown={agenda.entries.length} locale={locale} />
      </Section>

      <Disclosure
        summary={disclosureSummary(
          'chronos_cd_change_requests_summary',
          agenda.change_requests_total,
          locale
        )}
      >
        {agenda.change_requests.length > 0 ? (
          <CustomerDecisionRows
            caption={uxText('chronos_cd_metric_change_requests', locale)}
            columns={[
              { key: 'entry', label: uxText('chronos_cd_col_entry', locale) },
              { key: 'receipt', label: uxText('chronos_cd_col_receipt', locale) },
              { key: 'at', label: uxText('chronos_cd_col_at', locale) },
            ]}
            rows={agenda.change_requests.map((item) => ({
              entry: item.entry_id,
              receipt: item.receipt_id,
              at: item.at.slice(0, 10),
            }))}
          />
        ) : (
          <p className="kb-text kb-text--muted">{uxText('chronos_cd_none', locale)}</p>
        )}
        <MoreNote
          total={agenda.change_requests_total}
          shown={agenda.change_requests.length}
          locale={locale}
        />
      </Disclosure>

      <Disclosure
        summary={disclosureSummary('chronos_cd_handoffs_summary', agenda.handoffs_total, locale)}
      >
        {agenda.handoffs.length > 0 ? (
          <CustomerDecisionRows
            caption={uxText('chronos_cd_metric_handoffs', locale)}
            columns={[
              { key: 'receipt', label: uxText('chronos_cd_col_receipt', locale) },
              { key: 'what', label: uxText('chronos_cd_col_what', locale) },
              { key: 'state', label: uxText('chronos_cd_col_status', locale), width: '9rem' },
              { key: 'inbox', label: uxText('chronos_cd_col_inbox', locale) },
              { key: 'at', label: uxText('chronos_cd_col_at', locale) },
            ]}
            rows={agenda.handoffs.map((item) => ({
              receipt: item.receipt_id,
              what: uxMessage(
                'chronos_cd_handoff_what',
                {
                  off: item.off_option,
                  comments: item.comments,
                  question: item.general_question ? 1 : 0,
                },
                `${item.off_option} off-option · ${item.comments} comments`,
                locale
              ),
              state: {
                badge: uxText(
                  item.done
                    ? 'chronos_cd_handoff_done'
                    : item.notified
                      ? 'chronos_cd_handoff_notified'
                      : 'chronos_cd_handoff_pending',
                  locale
                ),
                tone: item.done ? 'success' : item.notified ? 'info' : 'warning',
              },
              inbox: item.inbox_entry_id ?? uxText('chronos_cd_none', locale),
              at: item.at ? item.at.slice(0, 10) : '',
            }))}
          />
        ) : (
          <p className="kb-text kb-text--muted">{uxText('chronos_cd_none', locale)}</p>
        )}
        <MoreNote total={agenda.handoffs_total} shown={agenda.handoffs.length} locale={locale} />
      </Disclosure>

      <Disclosure
        summary={disclosureSummary(
          'chronos_cd_reminders_summary',
          reminders.records_total + reminders.upcoming_total,
          locale
        )}
      >
        <ChronosMeta>
          {uxMessage(
            'chronos_cd_reminders_counts',
            {
              due: reminders.due,
              approval: reminders.pending_approval,
              manual: reminders.manual,
              next: reminders.next_send_on ?? uxText('chronos_cd_none', locale),
            },
            `${reminders.due} due`,
            locale
          )}
        </ChronosMeta>
        {reminders.upcoming.length > 0 ? (
          <CustomerDecisionRows
            caption={uxText('chronos_cd_reminders_upcoming', locale)}
            columns={[
              { key: 'kind', label: uxText('chronos_cd_col_kind', locale) },
              { key: 'send_on', label: uxText('chronos_cd_col_send_on', locale) },
              { key: 'target', label: uxText('chronos_cd_col_target_date', locale) },
            ]}
            rows={reminders.upcoming.map((item) => ({
              kind: uxText(`chronos_cd_reminder_kind_${item.kind}`, locale),
              send_on: item.send_on,
              target: item.target_date,
            }))}
          />
        ) : null}
        <MoreNote
          total={reminders.upcoming_total}
          shown={reminders.upcoming.length}
          locale={locale}
        />
        {reminders.records.length > 0 ? (
          <CustomerDecisionRows
            caption={uxText('chronos_cd_reminders_sent', locale)}
            columns={[
              { key: 'kind', label: uxText('chronos_cd_col_kind', locale) },
              { key: 'status', label: uxText('chronos_cd_col_status', locale), width: '10rem' },
              { key: 'target', label: uxText('chronos_cd_col_target_date', locale) },
              { key: 'detail', label: uxText('chronos_cd_col_detail', locale) },
              { key: 'at', label: uxText('chronos_cd_col_at', locale) },
            ]}
            rows={reminders.records.map((item) => ({
              kind: uxText(`chronos_cd_reminder_kind_${item.kind}`, locale),
              status: {
                badge: uxText(`chronos_cd_reminder_status_${item.status}`, locale),
                tone:
                  item.status === 'sent'
                    ? 'success'
                    : item.status === 'manual' || item.status === 'approval_pending'
                      ? 'warning'
                      : 'neutral',
              },
              target: item.target_date,
              detail: item.reason
                ? uxText(`chronos_cd_reminder_reason_${item.reason}`, locale)
                : (item.approval_request_id ?? ''),
              at: item.at.slice(0, 10),
            }))}
          />
        ) : null}
        <MoreNote
          total={reminders.records_total}
          shown={reminders.records.length}
          locale={locale}
        />
      </Disclosure>

      <Disclosure summary={disclosureSummary('chronos_cd_invites_summary', invites.active, locale)}>
        <KeyValue
          items={[
            { label: uxText('chronos_cd_invites_active', locale), value: invites.active },
            { label: uxText('chronos_cd_invites_deciders', locale), value: invites.deciders },
            {
              label: uxText('chronos_cd_invites_contributors', locale),
              value: invites.contributors,
            },
            { label: uxText('chronos_cd_invites_expired', locale), value: invites.expired },
            { label: uxText('chronos_cd_invites_revoked', locale), value: invites.revoked },
            {
              label: uxText('chronos_cd_approved_at', locale),
              value: agenda.approval
                ? `${agenda.approval.approved_at.slice(0, 10)}${
                    agenda.approval.approved_by_type
                      ? ` (${uxText(`chronos_cd_approver_${agenda.approval.approved_by_type}`, locale)})`
                      : ''
                  }`
                : uxText('chronos_cd_none', locale),
            },
          ]}
        />
      </Disclosure>

      <Disclosure
        summary={disclosureSummary('chronos_cd_routing_summary', agenda.bolt_routing_total, locale)}
      >
        {agenda.bolt_routing.length > 0 ? (
          <CustomerDecisionRows
            caption={uxText('chronos_cd_routing', locale)}
            columns={[
              { key: 'entry', label: uxText('chronos_cd_col_entry', locale) },
              { key: 'outcome', label: uxText('chronos_cd_col_outcome', locale) },
              { key: 'work_item', label: uxText('chronos_cd_col_work_item', locale) },
              { key: 'notified', label: uxText('chronos_cd_col_notified', locale), width: '6rem' },
              { key: 'at', label: uxText('chronos_cd_col_at', locale) },
            ]}
            rows={agenda.bolt_routing.map((item) => ({
              entry: item.entry_id,
              outcome: {
                badge: uxText(`chronos_cd_routing_${item.outcome}`, locale),
                tone: item.outcome === 'reject' ? 'danger' : 'warning',
              },
              work_item: item.work_item_id ?? uxText('chronos_cd_none', locale),
              notified: yesNo(item.notified, locale),
              at: item.at.slice(0, 10),
            }))}
          />
        ) : (
          <p className="kb-text kb-text--muted">{uxText('chronos_cd_none', locale)}</p>
        )}
        <MoreNote
          total={agenda.bolt_routing_total}
          shown={agenda.bolt_routing.length}
          locale={locale}
        />
      </Disclosure>

      <Code
        title={uxText('chronos_cd_how_to_act', locale)}
        language="shell"
        code={customerDecisionAgendaCommands(tenant, detail.case_id, agenda).join('\n')}
      />
    </>
  );
}

/** Presentational agenda view (rendered statically in tests). */
export function CustomerDecisionAgendaPanel({
  state,
  tenant,
  caseId,
  agendaId,
  locale,
  hrefs,
  onRetry,
}: {
  state: CustomerDecisionViewState<CustomerDecisionCaseDetailView>;
  tenant: string;
  caseId: string;
  agendaId: string;
  locale: SupportedLocale;
  hrefs: CustomerDecisionHrefs;
  onRetry?: () => void;
}) {
  const detail = state.kind === 'ready' ? state.value : null;
  const agenda = detail?.agendas.find((item) => item.agenda_id === agendaId);
  const caseHref = hrefs.caseOf(caseId);
  return (
    <div className="chronos-cd chronos-cd-detail">
      <Section headingLevel={3}>
        <CustomerDecisionBreadcrumb
          locale={locale}
          crumbs={[
            { label: uxText('chronos_cd_title', locale), href: hrefs.overview },
            { label: caseId, href: caseHref },
            { label: agenda?.title ?? agendaId },
          ]}
        />
        <CustomerDecisionDetailHeading
          title={agenda?.title ?? agendaId}
          focusKey={`agenda:${caseId}:${agendaId}`}
        />
        <p className="kb-visually-hidden" aria-live="polite">
          {state.kind === 'loading'
            ? uxText('chronos_cd_loading_detail', locale)
            : agenda
              ? uxMessage(
                  'chronos_cd_agenda_loaded',
                  { entries: agenda.entries_total },
                  `${agenda.entries_total} entries`,
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
        {detail && !agenda ? (
          <Callout
            tone="warning"
            title={uxText('chronos_cd_agenda_not_found_title', locale)}
            body={uxMessage(
              'chronos_cd_agenda_not_found_body',
              { agenda: agendaId, case: caseId },
              `${agendaId} is not an agenda set of ${caseId}.`,
              locale
            )}
            action={{ label: uxText('chronos_cd_back_to_case', locale), href: caseHref }}
          />
        ) : null}
        {detail && agenda ? (
          <AgendaBody detail={detail} agenda={agenda} tenant={tenant} locale={locale} />
        ) : null}
      </Section>
    </div>
  );
}
