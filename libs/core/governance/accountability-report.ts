/**
 * The accountable human's replacement for approval prompts: one short report
 * of what ran under their charter, what they are on the hook for, and the
 * only things that need them. Pure builder + renderer over the charter and its
 * ledger, so it is deterministic and testable; delivery lives in the caller.
 */

import { t } from '../t.js';
import {
  loadCharterObservationPolicy,
  type CharterObservationPolicy,
} from './charter-decision-vocabulary.js';
import type { SupportedLocale } from '../locale-normalize.js';
import type { Charter } from './accountability-charter.js';
import type { LedgerEntry } from './accountability-charter-registry.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NEAR_LIMIT_RATIO = 0.8;

export interface AccountabilityReport {
  charter_id: string;
  responsible: string;
  generated_at: string;
  since: string;
  executed: number;
  /** Verified results, separate from the legacy admission/consumption count above. */
  execution_outcomes: {
    succeeded: number;
    failed: number;
    unknown: number;
    needs_verification: number;
  };
  denied: number;
  money: {
    currency: string;
    spent_today: number;
    spent_this_month: number;
    per_day: number;
    per_month: number;
  };
  /** Budgets at or above 80%. */
  near_limit: Array<'per_day' | 'per_month'>;
  tripwires_standing: string[];
  /** Charter fields agents asked to widen, most requested first. */
  amendments: Array<{ field: string; count: number }>;
  /** Concrete widenings the accountable human may accept as a new charter (never applied automatically). */
  amendment_proposals: AmendmentSuggestion[];
  /** Information-flow denials in the window, grouped for the owner. */
  information_flow: InformationFlowReport;
  /**
   * Narrowing / stop advice derived from those denials. Advice only: applying
   * any of it requires the accountable human to accept a new charter.
   */
  scope_proposals: ScopeProposal[];
  expires_at: string;
  expires_in_days: number;
  /** True when nothing needs the accountable human. */
  all_clear: boolean;
}

export interface InformationFlowReport {
  denied: number;
  by_reason: Array<{ reason: string; count: number }>;
  purposes: Array<{ purpose: string; count: number }>;
  recipients: Array<{ recipient_class: string; count: number }>;
  processors: Array<{ processor_id: string; count: number }>;
  categories: Array<{ category: string; count: number }>;
  last_seen?: string;
}

export interface ScopeProposal {
  kind: 'narrow' | 'stop';
  field: string;
  value: string;
  count: number;
  reason: 'repeated_denials_under_delegated_scope' | 'frequent_information_flow_denials';
  last_seen: string;
}

const INFORMATION_FLOW_REASON_PREFIX = 'information_flow';

const topCounts = (counts: Map<string, number>): Array<{ key: string; count: number }> =>
  [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

/**
 * Group information-flow denials by the scope that produced them. Only reason
 * strings carrying the `information_flow` prefix count, so a budget denial is
 * never reported as a recipient issue.
 */
export function buildInformationFlowReport(
  ledger: readonly LedgerEntry[],
  sinceMs: number
): InformationFlowReport {
  const reasons = new Map<string, number>();
  const purposes = new Map<string, number>();
  const recipients = new Map<string, number>();
  const processors = new Map<string, number>();
  const categories = new Map<string, number>();
  let denied = 0;
  let lastSeen: string | undefined;
  for (const entry of ledger) {
    if (entry.kind !== 'denied' || Date.parse(entry.ts) < sinceMs) continue;
    const flowReasons = entry.reasons.filter((r) => r.startsWith(INFORMATION_FLOW_REASON_PREFIX));
    if (flowReasons.length === 0) continue;
    denied += 1;
    if (!lastSeen || entry.ts > lastSeen) lastSeen = entry.ts;
    for (const reason of flowReasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    const facts = entry.information_flow;
    if (!facts) continue;
    purposes.set(facts.purpose, (purposes.get(facts.purpose) ?? 0) + 1);
    if (facts.recipient_class) {
      recipients.set(facts.recipient_class, (recipients.get(facts.recipient_class) ?? 0) + 1);
    }
    if (facts.processor_id) {
      processors.set(facts.processor_id, (processors.get(facts.processor_id) ?? 0) + 1);
    }
    for (const category of facts.categories) {
      categories.set(category, (categories.get(category) ?? 0) + 1);
    }
  }
  return {
    denied,
    by_reason: topCounts(reasons).map(({ key, count }) => ({ reason: key, count })),
    purposes: topCounts(purposes).map(({ key, count }) => ({ purpose: key, count })),
    recipients: topCounts(recipients).map(({ key, count }) => ({ recipient_class: key, count })),
    processors: topCounts(processors).map(({ key, count }) => ({ processor_id: key, count })),
    categories: topCounts(categories).map(({ key, count }) => ({ category: key, count })),
    ...(lastSeen ? { last_seen: lastSeen } : {}),
  };
}

/**
 * Repeated denials under a scope the charter actually delegates mean the
 * delegation is not matching reality (usually a category the action needs was
 * left out). The safe response is to reduce autonomy, never to widen it
 * automatically: narrow that purpose/class/processor out, or stop autonomous
 * information flow until the human re-accepts a narrower charter.
 */
export function buildScopeProposals(
  charter: Charter,
  report: InformationFlowReport,
  policy: CharterObservationPolicy = loadCharterObservationPolicy()
): ScopeProposal[] {
  const flow = charter.envelope.information_flow;
  if (!flow || report.denied === 0) return [];
  const out: ScopeProposal[] = [];
  const lastSeen = report.last_seen ?? new Date(0).toISOString();
  const proposed = (values: Set<string>, value: string): boolean => values.has(value);
  const purposes = new Set(flow.purposes);
  const recipients = new Set<string>(flow.recipient_classes);
  const processors = new Set<string>(flow.processor_ids ?? []);

  for (const { purpose, count } of report.purposes) {
    if (count < policy.repeated_denial_threshold || !proposed(purposes, purpose)) continue;
    out.push({
      kind: 'narrow',
      field: 'envelope.information_flow.purposes',
      value: purpose,
      count,
      reason: 'repeated_denials_under_delegated_scope',
      last_seen: lastSeen,
    });
  }
  for (const { recipient_class, count } of report.recipients) {
    if (count < policy.repeated_denial_threshold || !proposed(recipients, recipient_class))
      continue;
    out.push({
      kind: 'narrow',
      field: 'envelope.information_flow.recipient_classes',
      value: recipient_class,
      count,
      reason: 'repeated_denials_under_delegated_scope',
      last_seen: lastSeen,
    });
  }
  for (const { processor_id, count } of report.processors) {
    if (count < policy.repeated_denial_threshold || !proposed(processors, processor_id)) continue;
    out.push({
      kind: 'narrow',
      field: 'envelope.information_flow.processor_ids',
      value: processor_id,
      count,
      reason: 'repeated_denials_under_delegated_scope',
      last_seen: lastSeen,
    });
  }
  if (report.denied >= policy.frequent_denial_threshold) {
    out.push({
      kind: 'stop',
      field: 'envelope.information_flow',
      value: 'external_egress',
      count: report.denied,
      reason: 'frequent_information_flow_denials',
      last_seen: lastSeen,
    });
  }
  return out.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === 'stop' ? -1 : 1) ||
      b.count - a.count ||
      a.field.localeCompare(b.field) ||
      a.value.localeCompare(b.value)
  );
}

export interface AmendmentSuggestion {
  field: string;
  count: number;
  current?: unknown;
  /** Smallest widening that would have admitted every denied action (numeric fields: the maximum asked). */
  requested?: unknown;
  action_classes: string[];
  last_seen: string;
}

/** Group denials by the charter field they asked to widen. Pure; proposals are advice, not authority. */
export function buildAmendmentSuggestions(
  ledger: readonly LedgerEntry[],
  sinceMs: number
): AmendmentSuggestion[] {
  const byField = new Map<string, AmendmentSuggestion>();
  for (const entry of ledger) {
    if (entry.kind !== 'denied' || !entry.amendment_field) continue;
    if (Date.parse(entry.ts) < sinceMs) continue;
    const found = byField.get(entry.amendment_field);
    const suggestion: AmendmentSuggestion = found ?? {
      field: entry.amendment_field,
      count: 0,
      current: entry.amendment_current,
      requested: entry.amendment_requested,
      action_classes: [],
      last_seen: entry.ts,
    };
    suggestion.count += 1;
    if (!suggestion.action_classes.includes(entry.action_class)) {
      suggestion.action_classes.push(entry.action_class);
    }
    if (entry.ts > suggestion.last_seen) suggestion.last_seen = entry.ts;
    const asked = entry.amendment_requested;
    if (typeof asked === 'number' && typeof suggestion.requested === 'number') {
      suggestion.requested = Math.max(suggestion.requested, asked);
    } else if (suggestion.requested === undefined) {
      suggestion.requested = asked;
    }
    byField.set(entry.amendment_field, suggestion);
  }
  return [...byField.values()]
    .map((s) => ({ ...s, action_classes: [...s.action_classes].sort() }))
    .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
}

export function buildAccountabilityReport(input: {
  charter: Charter;
  ledger: readonly LedgerEntry[];
  now: Date;
  hours?: number;
}): AccountabilityReport {
  const { charter, ledger, now } = input;
  const sinceMs = now.getTime() - (input.hours ?? 24) * HOUR_MS;
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);

  let executed = 0;
  const outcomes = { succeeded: 0, failed: 0, unknown: 0, needs_verification: 0 };
  const latestOutcomes = new Map<string, Extract<LedgerEntry, { kind: 'execution_outcome' }>>();
  const externalAdmissions = new Set<string>();
  let denied = 0;
  let spentToday = 0;
  let spentMonth = 0;
  const amendmentCounts = new Map<string, number>();
  const standing = new Set<string>();

  for (const entry of ledger) {
    const at = Date.parse(entry.ts);
    if (entry.kind === 'consumption') {
      if (entry.ts.startsWith(month)) spentMonth += entry.money;
      if (entry.ts.startsWith(day)) spentToday += entry.money;
      if (at >= sinceMs) executed += 1;
      if (entry.correlation_id?.startsWith('external:'))
        externalAdmissions.add(entry.correlation_id);
    } else if (entry.kind === 'execution_started') {
      externalAdmissions.add(entry.correlation_id);
    } else if (entry.kind === 'execution_outcome') {
      latestOutcomes.set(entry.correlation_id, entry);
    } else if (entry.kind === 'reservation_release') {
      if (entry.consumption_ts.startsWith(month)) spentMonth -= entry.money;
      if (entry.consumption_ts.startsWith(day)) spentToday -= entry.money;
    } else if (entry.kind === 'denied') {
      if (at >= sinceMs) {
        denied += 1;
        if (entry.amendment_field) {
          amendmentCounts.set(
            entry.amendment_field,
            (amendmentCounts.get(entry.amendment_field) ?? 0) + 1
          );
        }
      }
    } else if (entry.kind === 'tripwire') {
      standing.add(entry.tripwire);
    } else if (entry.kind === 'tripwire_clear') {
      standing.delete(entry.tripwire);
    }
  }
  for (const entry of latestOutcomes.values()) {
    if (entry.outcome === 'unknown') {
      outcomes.unknown += 1;
      outcomes.needs_verification += 1;
    } else if (Date.parse(entry.ts) >= sinceMs) outcomes[entry.outcome] += 1;
  }
  // A crash after admission/start but before outcome logging is not success.
  for (const correlationId of externalAdmissions) {
    if (!latestOutcomes.has(correlationId)) {
      outcomes.unknown += 1;
      outcomes.needs_verification += 1;
    }
  }

  const { per_day, per_month, currency } = charter.envelope.money;
  const near: Array<'per_day' | 'per_month'> = [];
  if (per_day > 0 && spentToday / per_day >= NEAR_LIMIT_RATIO) near.push('per_day');
  if (per_month > 0 && spentMonth / per_month >= NEAR_LIMIT_RATIO) near.push('per_month');

  const amendments = [...amendmentCounts.entries()]
    .map(([field, count]) => ({ field, count }))
    .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
  const informationFlow = buildInformationFlowReport(ledger, sinceMs);
  const scopeProposals = buildScopeProposals(charter, informationFlow);
  const expiresInDays = Math.max(
    0,
    Math.ceil((Date.parse(charter.accountable.expires_at) - now.getTime()) / DAY_MS)
  );

  return {
    charter_id: charter.charter_id,
    responsible: charter.accountable.actor,
    generated_at: now.toISOString(),
    since: new Date(sinceMs).toISOString(),
    executed,
    execution_outcomes: outcomes,
    denied,
    money: { currency, spent_today: spentToday, spent_this_month: spentMonth, per_day, per_month },
    near_limit: near,
    tripwires_standing: [...standing].sort(),
    amendments,
    amendment_proposals: buildAmendmentSuggestions(ledger, sinceMs),
    information_flow: informationFlow,
    scope_proposals: scopeProposals,
    expires_at: charter.accountable.expires_at,
    expires_in_days: expiresInDays,
    all_clear:
      standing.size === 0 &&
      denied === 0 &&
      outcomes.failed === 0 &&
      outcomes.unknown === 0 &&
      near.length === 0 &&
      expiresInDays > 14,
  };
}

function money(currency: string, value: number): string {
  return `${currency} ${Math.round(value).toLocaleString('en-US')}`;
}

function percent(spent: number, limit: number): string {
  return limit > 0 ? String(Math.round((spent / limit) * 100)) : '0';
}

/** First line is the title (used as the notification title); the rest is the body. */
export function renderAccountabilityReportText(
  report: AccountabilityReport,
  options: { locale?: SupportedLocale } = {}
): string {
  const locale = options.locale ?? 'ja';
  const lines: string[] = [
    t(
      'decision:charter_report_title',
      { charter: report.charter_id, time: report.generated_at.slice(0, 16).replace('T', ' ') },
      locale
    ),
    t(
      'decision:charter_report_headline',
      { executed: String(report.executed), denied: String(report.denied) },
      locale
    ),
  ];
  if (
    report.execution_outcomes &&
    Object.values(report.execution_outcomes).some((count) => count > 0)
  ) {
    const o = report.execution_outcomes;
    lines.push(
      t(
        'decision:charter_report_execution_outcomes',
        {
          succeeded: String(o.succeeded),
          failed: String(o.failed),
          unknown: String(o.needs_verification),
        },
        locale
      )
    );
  }
  // The stop is the one thing that can never be missed: it goes first.
  if (report.tripwires_standing.length > 0) {
    lines.splice(
      1,
      0,
      `🛑 ${t('decision:charter_report_tripwire', { items: report.tripwires_standing.join(', ') }, locale)}`
    );
  }
  const m = report.money;
  if (m.per_day > 0) {
    lines.push(
      t(
        'decision:charter_report_money_day',
        {
          spent: money(m.currency, m.spent_today),
          limit: money(m.currency, m.per_day),
          percent: percent(m.spent_today, m.per_day),
        },
        locale
      )
    );
    lines.push(
      t(
        'decision:charter_report_money_month',
        {
          spent: money(m.currency, m.spent_this_month),
          limit: money(m.currency, m.per_month),
          percent: percent(m.spent_this_month, m.per_month),
        },
        locale
      )
    );
  }
  if (report.near_limit.length > 0) {
    lines.push(
      `⚠️ ${t('decision:charter_report_near_limit', { items: report.near_limit.join(', ') }, locale)}`
    );
  }
  for (const a of report.amendments.slice(0, 5)) {
    lines.push(
      t('decision:charter_report_amendment', { field: a.field, count: String(a.count) }, locale)
    );
  }
  if (report.information_flow.denied > 0) {
    lines.push(
      t(
        'decision:charter_report_information_flow',
        {
          denied: String(report.information_flow.denied),
          reasons: report.information_flow.by_reason
            .slice(0, 3)
            .map((r) => `${r.reason} ×${r.count}`)
            .join('; '),
        },
        locale
      )
    );
  }
  for (const proposal of report.scope_proposals.slice(0, 3)) {
    lines.push(
      t(
        proposal.kind === 'stop'
          ? 'decision:charter_report_scope_stop'
          : 'decision:charter_report_scope_narrow',
        {
          field: proposal.field,
          value: proposal.value,
          count: String(proposal.count),
        },
        locale
      )
    );
  }
  if (report.expires_in_days <= 14) {
    lines.push(
      t(
        'decision:charter_report_expiry',
        { days: String(report.expires_in_days), date: report.expires_at.slice(0, 10) },
        locale
      )
    );
  }
  if (report.all_clear) lines.push(t('decision:charter_report_all_clear', undefined, locale));
  return lines.join('\n');
}
