import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import { withLockSync } from '@agent/core/foundation/lock-utils';
import { randomUUID } from 'node:crypto';
import { pathResolver } from '@agent/core/path-resolver';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import {
  createHearingRecord,
  hearingRevision,
  hearingRequirementsKey,
  type HearingRecord,
  type HearingScenario,
} from './hearing.js';

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
  hearingRevision(parsed.record_revision);
  hearingRevision(parsed.requirements_revision);
  if (parsed.handoff_pending !== undefined) {
    const pending = parsed.handoff_pending;
    if (
      !pending ||
      typeof pending.token !== 'string' ||
      !pending.token ||
      !['mission', 'inventory'].includes(pending.kind) ||
      typeof pending.started_at !== 'string' ||
      !Number.isFinite(Date.parse(pending.started_at)) ||
      pending.requirements_revision === undefined
    ) {
      throw new Error('[HEARING_RECORD_INVALID] invalid handoff reservation');
    }
    hearingRevision(pending.requirements_revision);
  }
  return parsed;
}

export type HearingConflict = 'stale_snapshot' | 'completion_locked' | 'handoff_unresolved';

export class HearingConflictError extends Error {
  readonly status = 409;
  constructor(readonly conflict: HearingConflict) {
    super('Hearing update conflict: ' + conflict);
  }
}

const completionFields = [
  'mission_id',
  'approval_request_id',
  'handed_off_at',
  'work_inventory_entry_id',
  'work_inventory_scope',
  'work_inventory_steps',
] as const;

/** Partial markers are protective too; they never authorize creating a replacement. */
export function assertHearingEditable(record: HearingRecord | null): void {
  if (record?.handoff_pending) throw new HearingConflictError('handoff_unresolved');
  if (record && completionFields.some((key) => key in record)) {
    throw new HearingConflictError('completion_locked');
  }
}

/** A completion replay must not contradict an unresolved or mixed-kind record. */
export function assertHearingHandoffReplay(
  record: HearingRecord,
  kind: 'mission' | 'inventory'
): void {
  if (record.handoff_pending) throw new HearingConflictError('handoff_unresolved');
  const other = kind === 'mission' ? completionFields.slice(3) : completionFields.slice(0, 3);
  if (other.some((key) => key in record)) throw new HearingConflictError('completion_locked');
}

export function assertHearingSnapshot(
  current: HearingRecord | null,
  expected: HearingRecord | null
): void {
  if (
    Boolean(current) !== Boolean(expected) ||
    (current &&
      expected &&
      (hearingRevision(current.record_revision) !== hearingRevision(expected.record_revision) ||
        current.scenario !== expected.scenario))
  ) {
    throw new HearingConflictError('stale_snapshot');
  }
}

/** Compare only decision inputs, allowing unrelated canvas metadata to advance. */
export function assertHearingDecisionSnapshot(
  current: HearingRecord | null,
  expected: HearingRecord
): asserts current is HearingRecord {
  if (
    !current ||
    current.session_id !== expected.session_id ||
    hearingRevision(current.requirements_revision) !==
      hearingRevision(expected.requirements_revision) ||
    hearingRequirementsKey(current) !== hearingRequirementsKey(expected) ||
    current.decided_at !== expected.decided_at ||
    JSON.stringify(current.decided_by) !== JSON.stringify(expected.decided_by)
  ) {
    throw new HearingConflictError('stale_snapshot');
  }
}

function writeHearingRecord(namespace: string, record: HearingRecord): string {
  const filePath = hearingPath(namespace, record.session_id);
  safeWriteFile(filePath, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8' });
  return filePath;
}

/** All writers share this short synchronous read/modify/write fence across processes.
 * No model call or subprocess runs inside it. The mutex requires shared PID/filesystem namespaces.
 */
export function updateHearingRecord(
  namespace: string,
  sessionId: string,
  update: (current: HearingRecord | null) => HearingRecord
): HearingRecord {
  return withLockSync(
    'hearing:' + safeSegment(namespace, 'TENANT') + ':' + safeSegment(sessionId, 'SESSION'),
    () => {
      const current = loadHearingRecord(namespace, sessionId);
      const next = update(current);
      if (
        !next ||
        next.session_id !== sessionId ||
        typeof (next as unknown as { then?: unknown }).then === 'function'
      ) {
        throw new Error('[HEARING_UPDATE_INVALID] synchronous record update required');
      }
      const changed = !current || hearingRequirementsKey(current) !== hearingRequirementsKey(next);
      const committed: HearingRecord = {
        ...next,
        record_revision: hearingRevision(current?.record_revision) + 1,
        requirements_revision: hearingRevision(current?.requirements_revision) + (changed ? 1 : 0),
      };
      if (current && changed) {
        delete committed.decided_at;
        delete committed.decided_by;
      }
      writeHearingRecord(namespace, committed);
      return committed;
    }
  );
}

/** Compatibility writer for fixtures/callers: replacement requires the current revision.
 * Routes use updateHearingRecord so they can patch the locked latest record instead.
 */
export function saveHearingRecord(namespace: string, record: HearingRecord): string {
  updateHearingRecord(namespace, record.session_id, (current) => {
    if (current) {
      assertHearingEditable(current);
      assertHearingSnapshot(current, record);
    }
    return record;
  });
  return hearingPath(namespace, record.session_id);
}

/** Must be called inside updateHearingRecord. Skip orphan HTML from failed record writes. */
export function saveHearingCanvasVersion(
  namespace: string,
  record: HearingRecord,
  html: string
): string {
  let index =
    record.canvas_versions.reduce((max, version) => {
      const match = /^v([0-9]+)$/.exec(version);
      const value = match ? Number(match[1]) : 0;
      return Number.isSafeInteger(value) ? Math.max(max, value) : max;
    }, 0) + 1;
  let version = 'v' + index;
  while (safeExistsSync(hearingCanvasPath(namespace, record.session_id, version))) {
    if (!Number.isSafeInteger(++index))
      throw new Error('[HEARING_CANVAS_VERSION_INVALID] exhausted versions');
    version = 'v' + index;
  }
  safeWriteFile(hearingCanvasPath(namespace, record.session_id, version), html, {
    encoding: 'utf8',
    createOnly: true,
  });
  return version;
}

/** Reserve only immediately before the first external effect, after pure/async preparation.
 * Unknown effects keep this reservation. It is not a receipt or protection beyond tmp retention.
 */
export function reserveHearingHandoff(
  namespace: string,
  expected: HearingRecord,
  kind: 'mission' | 'inventory',
  now: string
): HearingRecord {
  return updateHearingRecord(namespace, expected.session_id, (current) => {
    assertHearingEditable(current);
    assertHearingDecisionSnapshot(current, expected);
    if (
      !current.decided_at ||
      !current.decided_by ||
      current.requirements.some((item) => !item.answer?.trim())
    ) {
      throw new HearingConflictError('stale_snapshot');
    }
    return {
      ...current,
      handoff_pending: {
        token: randomUUID(),
        kind,
        requirements_revision: hearingRevision(current.requirements_revision),
        started_at: now,
      },
    };
  });
}

export function finishHearingHandoff(
  namespace: string,
  reserved: HearingRecord,
  patch: Partial<HearingRecord>
): HearingRecord {
  return updateHearingRecord(namespace, reserved.session_id, (current) => {
    assertHearingDecisionSnapshot(current, reserved);
    if (
      !reserved.handoff_pending ||
      current.handoff_pending?.token !== reserved.handoff_pending.token ||
      current.handoff_pending.kind !== reserved.handoff_pending.kind
    ) {
      throw new HearingConflictError('handoff_unresolved');
    }
    const finished = { ...current, ...patch };
    delete finished.handoff_pending;
    return finished;
  });
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
