import { safeReadFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { logger } from './core.js';

export type UxVocabularyLocale = 'en' | 'ja';
export type UxStatusDomain =
  | 'readiness'
  | 'connection'
  | 'provider'
  | 'mission'
  | 'progress'
  | 'runtime';

type VocabularyEntry = Record<string, string>;
type VocabularyCatalog = {
  default_locale: string;
  domains?: {
    ux?: Record<string, VocabularyEntry>;
  };
};

const VOCABULARY_PATH = pathResolver.knowledge('product/orchestration/user-facing-vocabulary.json');

let cachedCatalog: VocabularyCatalog | null | undefined;

const STATUS_KEY_MAP: Record<UxStatusDomain, Record<string, string>> = {
  readiness: {
    ready: 'readiness_ready',
    fully_automatable: 'readiness_ready',
    needs_clarification: 'readiness_clarification',
    needs_external_assets: 'readiness_assets',
    needs_assets: 'readiness_assets',
    needs_setup: 'readiness_setup',
    missing_runtime_prerequisites: 'readiness_runtime',
    needs_runtime_prerequisites: 'readiness_runtime',
  },
  connection: {
    ready: 'connection_connected',
    connected: 'connection_connected',
    connecting: 'connection_connecting',
    pending: 'connection_pending',
    blocked: 'connection_blocked',
    missing: 'connection_missing',
    'n/a': 'connection_not_applicable',
    degraded: 'connection_degraded',
    disconnected: 'connection_disconnected',
    offline: 'connection_disconnected',
  },
  provider: {
    available: 'provider_available',
    ready: 'provider_available',
    busy: 'provider_busy',
    fallback: 'provider_fallback',
    error: 'provider_error',
    missing: 'provider_missing',
    unavailable: 'provider_error',
  },
  mission: {
    planned: 'mission_planned',
    active: 'mission_active',
    blocked: 'mission_blocked',
    done: 'mission_completed',
    completed: 'mission_completed',
    failed: 'mission_failed',
    review: 'mission_review',
    recovered: 'mission_recovered',
    paused: 'mission_paused',
    distilling: 'mission_distilling',
    archived: 'mission_archived',
  },
  progress: {
    working: 'progress_working',
    completed: 'progress_completed',
    failed: 'progress_failed',
  },
  runtime: {
    running: 'runtime_running',
    stale: 'runtime_stale',
    stopped: 'runtime_stopped',
  },
};

function loadCatalog(): VocabularyCatalog | null {
  if (cachedCatalog !== undefined) {
    return cachedCatalog;
  }
  try {
    cachedCatalog = JSON.parse(
      String(safeReadFile(VOCABULARY_PATH, { label: 'user-facing vocabulary' }))
    ) as VocabularyCatalog;
  } catch {
    cachedCatalog = null;
  }
  return cachedCatalog;
}

export function resolveVocabularyLocale(locale?: string): UxVocabularyLocale {
  const normalized = String(locale || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  return normalized.startsWith('ja') ? 'ja' : 'en';
}

function renderVocabularyKey(key: string, locale: UxVocabularyLocale): string | null {
  const catalog = loadCatalog();
  const entry = catalog?.domains?.ux?.[key];
  if (!entry) return null;
  const defaultLocale = resolveVocabularyLocale(catalog?.default_locale || 'en');
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
