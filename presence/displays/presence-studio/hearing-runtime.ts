import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import { createHearingRecord, type HearingRecord, type HearingScenario } from './hearing.js';

const HEARING_ROOT = pathResolver.sharedTmp('hearing');

function safeSegment(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u.test(normalized)) {
    throw new Error(`[HEARING_${label.toUpperCase()}_INVALID] value must be a safe path segment`);
  }
  return normalized;
}

function hearingPath(namespace: string, sessionId: string): string {
  const tenant = safeSegment(namespace, 'TENANT');
  const session = safeSegment(sessionId, 'SESSION');
  return assertSafeRepositoryPath(`${HEARING_ROOT}/${tenant}/${session}.json`, {
    allowMissingLeaf: true,
  });
}

function hearingCanvasPath(namespace: string, sessionId: string, version: string): string {
  const tenant = safeSegment(namespace, 'TENANT');
  const session = safeSegment(sessionId, 'SESSION');
  const safeVersion = safeSegment(version, 'CANVAS_VERSION');
  return assertSafeRepositoryPath(`${HEARING_ROOT}/${tenant}/${session}.${safeVersion}.html`, {
    allowMissingLeaf: true,
  });
}

export function loadHearingRecord(namespace: string, sessionId: string): HearingRecord | null {
  const filePath = hearingPath(namespace, sessionId);
  if (!safeExistsSync(filePath)) return null;
  const rawValue = safeReadFile(filePath, { encoding: 'utf8' });
  const raw = typeof rawValue === 'string' ? rawValue : rawValue.toString('utf8');
  const parsed = JSON.parse(raw) as HearingRecord;
  if (
    !parsed ||
    parsed.session_id !== sessionId ||
    typeof parsed.scenario !== 'string' ||
    !Array.isArray(parsed.requirements) ||
    !parsed.requirements.every(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.label_key === 'string' &&
        typeof item.confidence === 'number'
    )
  ) {
    throw new Error('[HEARING_RECORD_INVALID] stored record does not match the contract');
  }
  return parsed;
}

export function saveHearingRecord(namespace: string, record: HearingRecord): string {
  const filePath = hearingPath(namespace, record.session_id);
  const directory = assertSafeRepositoryPath(
    `${HEARING_ROOT}/${safeSegment(namespace, 'TENANT')}`,
    {
      allowMissingLeaf: true,
    }
  );
  if (!safeExistsSync(directory)) safeMkdir(directory, { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8' });
  return filePath;
}

export function saveHearingCanvasVersion(
  namespace: string,
  record: HearingRecord,
  html: string
): string {
  const version = `v${record.canvas_versions.length + 1}`;
  const filePath = hearingCanvasPath(namespace, record.session_id, version);
  safeWriteFile(filePath, html, { encoding: 'utf8' });
  return version;
}

export function loadHearingCanvasVersion(
  namespace: string,
  sessionId: string,
  version: string
): string | null {
  const filePath = hearingCanvasPath(namespace, sessionId, version);
  if (!safeExistsSync(filePath)) return null;
  const raw = safeReadFile(filePath, { encoding: 'utf8' });
  return typeof raw === 'string' ? raw : raw.toString('utf8');
}

export function hearingNamespace(tenantSlugs: string[] | 'all'): string {
  if (tenantSlugs === 'all') return 'all';
  return tenantSlugs[0] || 'unscoped';
}

export function defaultHearingRecord(
  sessionId: string,
  now: string,
  scenario?: HearingScenario
): HearingRecord {
  return createHearingRecord(sessionId, now, scenario);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** HT-01/HT-06 fixed canvas: safe, deterministic, and free of external
 * resources. All fixed chrome text (title, heading, coverage, unanswered
 * fallback) resolves through the `front_desk` vocabulary catalog at render
 * time via `locale` — only the requirement labels (via `label_key`) and the
 * free-form answers are per-record data, and answers stay escaped. */
export function renderHearingCanvas(record: HearingRecord, locale: SupportedLocale = 'en'): string {
  const complete = record.requirements.filter((item) => item.answer?.trim()).length;
  const unanswered = catalogT('front_desk:hearing_canvas_unanswered', undefined, locale);
  const cards = record.requirements
    .map(
      (item) => `<article class="requirement ${item.answer ? 'answered' : 'open'}">
        <h2>${escapeHtml(catalogT(item.label_key as VocabularyKey, undefined, locale))}</h2>
        <p>${escapeHtml(item.answer || unanswered)}</p>
      </article>`
    )
    .join('\n');
  const pageTitle = catalogT('front_desk:hearing_canvas_page_title', undefined, locale);
  const heading = catalogT('front_desk:hearing_canvas_heading', undefined, locale);
  const coverage = catalogT(
    'front_desk:hearing_canvas_coverage',
    { complete, total: record.requirements.length },
    locale
  );
  return `<!doctype html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(pageTitle)}</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#faf9f6;color:#26231d}h1{font-size:22px;margin:0 0 8px}.meta{color:#706b60;font-size:13px;margin:0 0 18px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.requirement{padding:14px;border:1px solid #e3ddd1;border-radius:12px;background:#fff}.requirement h2{font-size:14px;margin:0 0 8px}.requirement p{font-size:13px;line-height:1.5;margin:0;color:#706b60}.answered{border-color:#a98a54}.answered p{color:#26231d}</style></head><body><h1>${escapeHtml(heading)}</h1><p class="meta">${escapeHtml(coverage)}</p><main class="grid">${cards}</main></body></html>`;
}
