'use client';

import type { KbTableCell, KbTone } from '@agent/core/surface/a2ui-catalog';
import { Badge, Callout, Code, EmptyState, KbLink, Metric, Section } from '@agent/shared-ui';
import { ChronosInline, ChronosMeta } from './chronos-ui';
import { uxMessage, uxText, type SupportedLocale } from '../lib/ux-vocabulary';
import type {
  CustomerDecisionLearningViewData,
  LearningSubjectView,
  LearningSuggestionKindView,
  LearningSuggestionView,
} from '../lib/customer-decision-learning-response';
import {
  useCustomerDecisionView,
  type CustomerDecisionViewState,
} from '../lib/customer-decision-view-client';
import {
  CustomerDecisionBreadcrumb,
  CustomerDecisionDetailHeading,
  CustomerDecisionViewNotice,
  type CustomerDecisionHrefs,
} from './CustomerDecisionCaseDetail';
import { CustomerDecisionRows } from './CustomerDecisionOverviewCard';

/**
 * CD-12 drill-down: the tenant's customer-decision learning report as the
 * operator triages it — what the weekly run suggests (with its evidence and
 * the learning candidate it queued) and the tables it came from. Default
 * values and option values are never shown: a default change only says it is
 * suggested, and the operator decides the candidate with
 * `pnpm organization learning transition`.
 */

/** A learning candidate of the organization model (`learning_candidates`). */
export interface CustomerDecisionLearningCandidate {
  learning_id: string;
  title: string;
  status: string;
}

const KIND_TONE: Record<LearningSuggestionKindView, KbTone> = {
  change_org_default: 'warning',
  revise_options: 'info',
  clarify_entry: 'accent',
};

const CANDIDATE_TONE: Record<string, KbTone> = {
  proposed: 'info',
  approved: 'success',
  promoted: 'success',
  rejected: 'neutral',
  created: 'info',
  existing: 'neutral',
  refused: 'warning',
  failed: 'danger',
};

/** The organization model's learning candidate statuses (proposed → approved → promoted, or rejected). */
const MODEL_CANDIDATE_STATUSES: ReadonlySet<string> = new Set([
  'proposed',
  'approved',
  'rejected',
  'promoted',
]);

function subjectCell(subject: LearningSubjectView): KbTableCell {
  return subject.template_id
    ? {
        title: `${subject.item} / ${subject.key}`,
        id: `${subject.template_id}#${subject.entry_id}`,
      }
    : { title: `${subject.item} / ${subject.key}` };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** The candidate's status: the organization model's when it lists it, else the run's outcome. */
export function customerDecisionCandidateStatus(
  suggestion: LearningSuggestionView,
  candidates: readonly CustomerDecisionLearningCandidate[],
  locale: SupportedLocale
): { label: string; tone: KbTone } {
  const candidate = candidates.find((item) => item.learning_id === suggestion.learning_id);
  if (candidate)
    return {
      label: MODEL_CANDIDATE_STATUSES.has(candidate.status)
        ? uxText(`chronos_cd_candidate_${candidate.status}`, locale)
        : candidate.status,
      tone: CANDIDATE_TONE[candidate.status] ?? 'neutral',
    };
  if (suggestion.candidate)
    return {
      label: uxText(`chronos_cd_candidate_${suggestion.candidate}`, locale),
      tone: CANDIDATE_TONE[suggestion.candidate] ?? 'neutral',
    };
  return { label: uxText('chronos_cd_candidate_unknown', locale), tone: 'neutral' };
}

export function customerDecisionSuggestionRows(
  learning: CustomerDecisionLearningViewData,
  candidates: readonly CustomerDecisionLearningCandidate[],
  locale: SupportedLocale
): Array<Record<string, KbTableCell>> {
  return learning.suggestions.map((suggestion) => {
    const status = customerDecisionCandidateStatus(suggestion, candidates, locale);
    const evidence = suggestion.evidence;
    return {
      kind: {
        badge: uxText(`chronos_cd_suggestion_${suggestion.kind}`, locale),
        tone: KIND_TONE[suggestion.kind],
      },
      subject: subjectCell(suggestion),
      what:
        suggestion.kind === 'change_org_default' && suggestion.has_suggested_default
          ? uxText('chronos_cd_suggestion_default_change', locale)
          : uxText(`chronos_cd_suggestion_${suggestion.kind}_detail`, locale),
      evidence: uxMessage(
        evidence.rate === undefined ? 'chronos_cd_evidence' : 'chronos_cd_evidence_rate',
        {
          count: evidence.count,
          samples: evidence.samples,
          rate: evidence.rate === undefined ? '' : percent(evidence.rate),
        },
        `${evidence.count} of ${evidence.samples}`,
        locale
      ),
      learning: { title: suggestion.learning_id },
      candidate: { badge: status.label, tone: status.tone },
    };
  });
}

/** The CLI verbs that act on what the learning view shows. */
export function customerDecisionLearningCommands(
  tenant: string,
  organizationId: string,
  learning: CustomerDecisionLearningViewData
): string[] {
  const scope = `--organization-id ${organizationId} --tier confidential --tenant-slug ${tenant}`;
  const first = learning.suggestions[0]?.learning_id ?? '<learning_id>';
  // One line per status, so each pastes as is.
  return [
    `pnpm organization learning transition ${scope} --learning-id ${first} --record-status approved --dry-run`,
    `pnpm organization learning transition ${scope} --learning-id ${first} --record-status rejected --dry-run`,
    `pnpm kyberion customer-decision learning --tenant ${tenant} --dry-run`,
  ];
}

/** Presentational learning view (rendered statically in tests). */
export function CustomerDecisionLearningView({
  state,
  tenant,
  organizationId,
  date,
  locale,
  hrefs,
  candidates = [],
  onRetry,
}: {
  state: CustomerDecisionViewState<CustomerDecisionLearningViewData>;
  tenant: string;
  organizationId: string;
  date?: string;
  locale: SupportedLocale;
  hrefs: CustomerDecisionHrefs;
  candidates?: readonly CustomerDecisionLearningCandidate[];
  onRetry?: () => void;
}) {
  const learning = state.kind === 'ready' ? state.value : null;
  const title = uxText('chronos_cd_learning_title', locale);
  return (
    <div className="chronos-cd chronos-cd-detail">
      <Section headingLevel={3}>
        <CustomerDecisionBreadcrumb
          locale={locale}
          crumbs={[
            { label: uxText('chronos_cd_title', locale), href: hrefs.overview },
            { label: title },
          ]}
        />
        <CustomerDecisionDetailHeading title={title} focusKey={`learning:${date ?? ''}`} />
        <p className="kb-text kb-text--muted">
          {uxText('chronos_cd_learning_description', locale)}
        </p>
        <p className="kb-visually-hidden" aria-live="polite">
          {state.kind === 'loading'
            ? uxText('chronos_cd_loading_detail', locale)
            : learning
              ? uxMessage(
                  'chronos_cd_learning_loaded',
                  { count: learning.suggestions.length },
                  `${learning.suggestions.length} suggestions`,
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
        {learning ? (
          learning.report_date === null ? (
            <EmptyState
              title={uxText('chronos_cd_learning_empty_title', locale)}
              body={uxMessage(
                'chronos_cd_learning_empty_body',
                { tenant },
                'No learning report yet.',
                locale
              )}
            />
          ) : (
            <>
              <ChronosInline>
                <Badge label={`${uxText('chronos_tenant', locale)}: ${learning.tenant_slug}`} />
                <ChronosMeta>
                  {learning.since
                    ? uxMessage(
                        'chronos_cd_learning_report',
                        { date: learning.report_date, since: learning.since.slice(0, 10) },
                        learning.report_date,
                        locale
                      )
                    : uxMessage(
                        'chronos_cd_learning_report_date',
                        { date: learning.report_date },
                        learning.report_date,
                        locale
                      )}
                </ChronosMeta>
              </ChronosInline>
              {learning.available_dates.length > 1 ? (
                <nav
                  className="chronos-cd-dates"
                  aria-label={uxText('chronos_cd_learning_dates', locale)}
                >
                  <ul>
                    {[...learning.available_dates].reverse().map((item) => (
                      <li key={item}>
                        {item === learning.report_date ? (
                          <span aria-current="page">{item}</span>
                        ) : (
                          <KbLink href={hrefs.learningOf(item)}>{item}</KbLink>
                        )}
                      </li>
                    ))}
                  </ul>
                </nav>
              ) : null}

              <div className="chronos-metrics">
                <Metric
                  label={uxText('chronos_cd_learning_cases', locale)}
                  value={learning.metrics.cases}
                />
                <Metric
                  label={uxText('chronos_cd_learning_agendas', locale)}
                  value={learning.metrics.agendas}
                />
                <Metric
                  label={uxText('chronos_cd_learning_receipts', locale)}
                  value={learning.metrics.receipts}
                />
                <Metric
                  label={uxText('chronos_cd_learning_suggestions', locale)}
                  value={learning.suggestions.length}
                  tone={learning.suggestions.length > 0 ? 'warning' : undefined}
                />
              </div>

              <Section headingLevel={4} title={uxText('chronos_cd_learning_suggestions', locale)}>
                {learning.suggestions.length > 0 ? (
                  <CustomerDecisionRows
                    caption={uxText('chronos_cd_learning_suggestions', locale)}
                    columns={[
                      {
                        key: 'kind',
                        label: uxText('chronos_cd_col_kind', locale),
                        width: '11rem',
                      },
                      { key: 'subject', label: uxText('chronos_cd_col_subject', locale) },
                      { key: 'what', label: uxText('chronos_cd_col_suggestion', locale) },
                      { key: 'evidence', label: uxText('chronos_cd_col_evidence', locale) },
                      { key: 'learning', label: uxText('chronos_cd_col_learning_id', locale) },
                      {
                        key: 'candidate',
                        label: uxText('chronos_cd_col_candidate', locale),
                        width: '9rem',
                      },
                    ]}
                    rows={customerDecisionSuggestionRows(learning, candidates, locale)}
                  />
                ) : (
                  <Callout tone="success" title={uxText('chronos_cd_learning_none', locale)} />
                )}
              </Section>

              {learning.overturns.length > 0 ? (
                <Section headingLevel={4} title={uxText('chronos_cd_learning_overturns', locale)}>
                  <CustomerDecisionRows
                    caption={uxText('chronos_cd_learning_overturns', locale)}
                    columns={[
                      { key: 'subject', label: uxText('chronos_cd_col_subject', locale) },
                      { key: 'from', label: uxText('chronos_cd_col_layer', locale) },
                      { key: 'decided', label: uxText('chronos_cd_col_decided', locale) },
                      { key: 'overturned', label: uxText('chronos_cd_col_overturned', locale) },
                      { key: 'rate', label: uxText('chronos_cd_col_rate', locale) },
                      { key: 'other', label: uxText('chronos_cd_col_other_values', locale) },
                    ]}
                    rows={learning.overturns.map((row) => ({
                      subject: subjectCell(row),
                      from: uxText(`chronos_cd_layer_${row.from_layer}`, locale),
                      decided: row.decided,
                      overturned: row.overturned,
                      rate: percent(row.overturn_rate),
                      other: row.other_values,
                    }))}
                  />
                </Section>
              ) : null}

              {learning.questions.length > 0 ? (
                <Section headingLevel={4} title={uxText('chronos_cd_learning_questions', locale)}>
                  <CustomerDecisionRows
                    caption={uxText('chronos_cd_learning_questions', locale)}
                    columns={[
                      { key: 'subject', label: uxText('chronos_cd_col_subject', locale) },
                      { key: 'agendas', label: uxText('chronos_cd_learning_agendas', locale) },
                      { key: 'off', label: uxText('chronos_cd_col_off_option', locale) },
                      { key: 'comments', label: uxText('chronos_cd_col_comments', locale) },
                    ]}
                    rows={learning.questions.map((row) => ({
                      subject: subjectCell(row),
                      agendas: row.agendas,
                      off: row.off_option,
                      comments: row.comments,
                    }))}
                  />
                </Section>
              ) : null}

              {learning.change_requests.length > 0 ? (
                <Section
                  headingLevel={4}
                  title={uxText('chronos_cd_learning_change_requests', locale)}
                >
                  <CustomerDecisionRows
                    caption={uxText('chronos_cd_learning_change_requests', locale)}
                    columns={[
                      { key: 'subject', label: uxText('chronos_cd_col_subject', locale) },
                      { key: 'answers', label: uxText('chronos_cd_col_answers', locale) },
                      {
                        key: 'changes',
                        label: uxText('chronos_cd_metric_change_requests', locale),
                      },
                      { key: 'rate', label: uxText('chronos_cd_col_rate', locale) },
                    ]}
                    rows={learning.change_requests.map((row) => ({
                      subject: subjectCell(row),
                      answers: row.answers,
                      changes: row.change_requests + row.request_changes + row.reject,
                      rate: percent(row.rate),
                    }))}
                  />
                </Section>
              ) : null}

              <Code
                title={uxText('chronos_cd_how_to_act', locale)}
                language="shell"
                code={customerDecisionLearningCommands(tenant, organizationId, learning).join('\n')}
              />
            </>
          )
        ) : null}
      </Section>
    </div>
  );
}

/** The learning view: fetches the viewer-scoped report of `tenant` (latest, or `date`). */
export function CustomerDecisionLearningPanel({
  tenant,
  organizationId,
  date,
  locale,
  hrefs,
  candidates,
}: {
  tenant: string;
  organizationId: string;
  date?: string;
  locale: SupportedLocale;
  hrefs: CustomerDecisionHrefs;
  candidates?: readonly CustomerDecisionLearningCandidate[];
}) {
  const { state, retry } = useCustomerDecisionView('learning', tenant, date);
  return (
    <CustomerDecisionLearningView
      state={state}
      tenant={tenant}
      organizationId={organizationId}
      date={date}
      locale={locale}
      hrefs={hrefs}
      candidates={candidates}
      onRetry={retry}
    />
  );
}
