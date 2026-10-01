/**
 * The accountable human's replacement for approval prompts: one short report
 * of what ran under their charter, what they are on the hook for, and the
 * only things that need them. Pure builder + renderer over the charter and its
 * ledger, so it is deterministic and testable; delivery lives in the caller.
 */

import { t } from '../t.js';
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
  expires_at: string;
  expires_in_days: number;
  /** True when nothing needs the accountable human. */
  all_clear: boolean;
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

  const { per_day, per_month, currency } = charter.envelope.money;
  const near: Array<'per_day' | 'per_month'> = [];
  if (per_day > 0 && spentToday / per_day >= NEAR_LIMIT_RATIO) near.push('per_day');
  if (per_month > 0 && spentMonth / per_month >= NEAR_LIMIT_RATIO) near.push('per_month');

  const amendments = [...amendmentCounts.entries()]
    .map(([field, count]) => ({ field, count }))
    .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
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
    denied,
    money: { currency, spent_today: spentToday, spent_this_month: spentMonth, per_day, per_month },
    near_limit: near,
    tripwires_standing: [...standing].sort(),
    amendments,
    expires_at: charter.accountable.expires_at,
    expires_in_days: expiresInDays,
    all_clear: standing.size === 0 && denied === 0 && near.length === 0 && expiresInDays > 14,
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
