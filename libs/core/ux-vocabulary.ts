import { logger } from './core.js';
import { normalizeLocale, resolveDefaultLocale, type SupportedLocale } from './locale.js';
import { loadVocabularyCatalog, resolveVocabularyEntry } from './vocabulary-catalog.js';

/** @deprecated Use `SupportedLocale` from `./locale.js` instead. */
export type UxVocabularyLocale = SupportedLocale;
export type UxStatusDomain =
  | 'readiness'
  | 'connection'
  | 'provider'
  | 'mission'
  | 'progress'
  | 'runtime';

// I18N-02: renderStatus's key map targets the `status` namespace exactly —
// these are the domains renderStatus() has always served, and they moved
// into `status` verbatim when the catalog split out of the single flat
// `domains.ux`. Qualifying the lookup avoids any ambiguity if a future
// namespace ever adds a same-named bare key.
const STATUS_KEY_MAP: Record<UxStatusDomain, Record<string, string>> = {
  readiness: {
    ready: 'status:readiness_ready',
    fully_automatable: 'status:readiness_ready',
    needs_clarification: 'status:readiness_clarification',
    needs_external_assets: 'status:readiness_assets',
    needs_assets: 'status:readiness_assets',
    needs_setup: 'status:readiness_setup',
    missing_runtime_prerequisites: 'status:readiness_runtime',
    needs_runtime_prerequisites: 'status:readiness_runtime',
  },
  connection: {
    ready: 'status:connection_connected',
    connected: 'status:connection_connected',
    connecting: 'status:connection_connecting',
    pending: 'status:connection_pending',
    blocked: 'status:connection_blocked',
    missing: 'status:connection_missing',
    'n/a': 'status:connection_not_applicable',
    degraded: 'status:connection_degraded',
    disconnected: 'status:connection_disconnected',
    offline: 'status:connection_disconnected',
  },
  provider: {
    available: 'status:provider_available',
    ready: 'status:provider_available',
    busy: 'status:provider_busy',
    fallback: 'status:provider_fallback',
    error: 'status:provider_error',
    missing: 'status:provider_missing',
    unavailable: 'status:provider_error',
  },
  mission: {
    planned: 'status:mission_planned',
    active: 'status:mission_active',
    blocked: 'status:mission_blocked',
    done: 'status:mission_completed',
    completed: 'status:mission_completed',
    failed: 'status:mission_failed',
    review: 'status:mission_review',
    recovered: 'status:mission_recovered',
    paused: 'status:mission_paused',
    distilling: 'status:mission_distilling',
    archived: 'status:mission_archived',
  },
  progress: {
    working: 'status:progress_working',
    completed: 'status:progress_completed',
    failed: 'status:progress_failed',
  },
  runtime: {
    running: 'status:runtime_running',
    stale: 'status:runtime_stale',
    stopped: 'status:runtime_stopped',
  },
};

/**
 * @deprecated Thin wrapper over `./locale.js`. Kept for call-site
 * compatibility — this remains an arg-only resolver (it does not consult
 * identity/env; callers that need the full precedence chain should call
 * `resolveLocale()` themselves and pass its result in, as
 * `scripts/intent.ts` now does). The only behavior change is the fallback
 * for a missing/unknown `locale`: it now comes from the catalog's
 * `default_locale` via `resolveDefaultLocale()` instead of a hardcoded
 * `'en'` (the two happen to agree today, but this keeps the default in
 * one place).
 */
export function resolveVocabularyLocale(locale?: string): UxVocabularyLocale {
  return normalizeLocale(locale) ?? resolveDefaultLocale();
}

function renderVocabularyKey(key: string, locale: UxVocabularyLocale): string | null {
  const resolved = resolveVocabularyEntry(key);
  if (!resolved) return null;
  const catalog = loadVocabularyCatalog();
  const defaultLocale = resolveVocabularyLocale(catalog?.default_locale || 'en');
  const entry = resolved.entry;
  return entry[locale] || entry[defaultLocale] || entry.en || entry.ja || null;
}

export function renderVocabularyText(key: string, locale?: string): string {
  const resolvedLocale = resolveVocabularyLocale(locale);
  return renderVocabularyKey(key, resolvedLocale) || key;
}

function warnFallback(domain: UxStatusDomain, value: string): void {
  logger.warn(
    `[UX_VOCAB] Missing user-facing vocabulary for ${domain}.${value}; using fallback text`
  );
}

export function renderStatus(domain: UxStatusDomain, value: string, locale?: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  const mappedKey = STATUS_KEY_MAP[domain][normalized.toLowerCase()] || normalized;
  const resolvedLocale = resolveVocabularyLocale(locale);
  const catalogValue = renderVocabularyKey(mappedKey, resolvedLocale);
  if (catalogValue) {
    return catalogValue;
  }
  warnFallback(domain, mappedKey);
  return normalized;
}
