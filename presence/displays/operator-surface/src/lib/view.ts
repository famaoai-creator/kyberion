import { formatDateTime, formatNumber, resolveTimeZone } from '@agent/core/format';
import type { KbStatus, KbStatusDomain } from '@agent/core/a2ui-catalog';
import { createTranslator, statusLabel } from '@agent/shared-ui/vanilla';
import { operatorUiMessages, type OperatorLocale, type OperatorTranslate } from './i18n';

/**
 * UI-08 view helpers shared by the server pages: locale-aware date / number
 * formatting and the mapping of record values onto the canonical status
 * vocabulary (`ui:status-pill` shows icon + text, never color alone).
 */

const BCP47: Record<OperatorLocale, string> = { ja: 'ja-JP', en: 'en-US' };

const KB_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'archived',
  'available',
  'blocked',
  'busy',
  'completed',
  'connected',
  'connecting',
  'degraded',
  'disconnected',
  'distilling',
  'done',
  'error',
  'failed',
  'fallback',
  'fully_automatable',
  'missing',
  'missing_runtime_prerequisites',
  'n/a',
  'needs_assets',
  'needs_clarification',
  'needs_external_assets',
  'needs_runtime_prerequisites',
  'needs_setup',
  'offline',
  'paused',
  'pending',
  'planned',
  'ready',
  'recovered',
  'review',
  'running',
  'stale',
  'stopped',
  'unavailable',
  'working',
]);

export function asKbStatus(value: unknown): KbStatus | null {
  return typeof value === 'string' && KB_STATUSES.has(value) ? (value as KbStatus) : null;
}

export function formatTimestamp(
  value: string | number | undefined | null,
  locale: OperatorLocale,
  style: 'datetime' | 'date' | 'time' = 'datetime'
): string {
  if (value === undefined || value === null || value === '') return '—';
  try {
    return formatDateTime(value, { locale: BCP47[locale], timeZone: resolveTimeZone(), style });
  } catch {
    return String(value);
  }
}

export function formatCount(value: number, locale: OperatorLocale): string {
  return formatNumber(value, { locale: BCP47[locale] });
}

export type TierTone = 'info' | 'warning' | 'danger' | 'neutral';

export function tierTone(tier: string | undefined): TierTone {
  if (tier === 'public') return 'info';
  if (tier === 'confidential') return 'warning';
  if (tier === 'personal') return 'danger';
  return 'neutral';
}

export function tierLabel(tier: string | undefined, t: OperatorTranslate): string {
  if (tier === 'public') return t('tier_public');
  if (tier === 'confidential') return t('tier_confidential');
  if (tier === 'personal') return t('tier_personal');
  return tier || '—';
}

/** Audit `result` → status pill (status + localized label). */
export function auditResultStatus(
  result: string,
  t: OperatorTranslate
): { status: KbStatus; label: string } {
  switch (result) {
    case 'allowed':
      return { status: 'ready', label: t('audit_result_allowed') };
    case 'denied':
      return { status: 'blocked', label: t('audit_result_denied') };
    case 'error':
      return { status: 'error', label: t('audit_result_error') };
    case 'completed':
      return { status: 'completed', label: t('audit_result_completed') };
    case 'failed':
      return { status: 'failed', label: t('audit_result_failed') };
    default:
      return { status: 'n/a', label: result || '—' };
  }
}

/** Mission status → canonical pill status (unknown values stay neutral with their raw text). */
export function missionStatus(status: string): { status: KbStatus; label?: string } {
  const known = asKbStatus(status);
  return known ? { status: known } : { status: 'n/a', label: status || '—' };
}

const uiTranslators = new Map<OperatorLocale, ReturnType<typeof createTranslator>>();

/**
 * Localized status wording on the server (tab labels, chart legends, key /
 * value rows) — the same `ui:status_*` vocabulary the status pills use, so a
 * status reads identically everywhere on the page.
 */
export function statusText(
  status: string,
  locale: OperatorLocale,
  domain?: KbStatusDomain
): string {
  if (!status) return '—';
  let translate = uiTranslators.get(locale);
  if (!translate) {
    translate = createTranslator({ messages: operatorUiMessages(locale) });
    uiTranslators.set(locale, translate);
  }
  return statusLabel(status, domain, undefined, translate);
}
