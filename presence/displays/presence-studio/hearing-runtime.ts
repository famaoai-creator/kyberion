import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeReadFile,
  safeWriteFile,
  safeMoveSync,
  safeRmSync,
} from '@agent/core/secure-io';
import { withLockSync } from '@agent/core/foundation/lock-utils';
import { readJson } from '@agent/core/foundation/json';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import { humanActor } from '@agent/core/actor';
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
  type HearingDecisionOperation,
  type HearingDecisionIdentity,
  type HearingDecisionReceipt,
  type HearingDecidedBy,
} from './hearing.js';

const HEARING_ROOT = pathResolver.sharedTmp('hearing');

function safeSegment(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u.test(normalized)) {
    throw new Error(`[HEARING_${label.toUpperCase()}_INVALID] value must be a safe path segment`);
  }
  return normalized;
}

function hearingDirectory(namespace: string, sessionId: string): string {
  const session = safeSegment(sessionId, 'SESSION');
  const shared = namespace === 'all' || namespace === 'unscoped';
  if (!shared && !isValidTenantSlug(namespace))
    throw new Error('[HEARING_TENANT_INVALID] canonical tenant slug required');
  const partition = shared ? 'personal/shared' : 'confidential/' + namespace;
  return assertSafeRepositoryPath(
    pathResolver.rootResolve(
      'active/shared/runtime/hearing/' + partition + '/' + namespace + '/' + session
    ),
    { allowMissingLeaf: true }
  );
}
function legacyHearingPath(namespace: string, sessionId: string): string {
  return assertSafeRepositoryPath(
    HEARING_ROOT +
      '/' +
      safeSegment(namespace, 'TENANT') +
      '/' +
      safeSegment(sessionId, 'SESSION') +
      '.json',
    { allowMissingLeaf: true }
  );
}
function hearingPath(namespace: string, sessionId: string): string {
  return hearingDirectory(namespace, sessionId) + '/' + safeSegment(sessionId, 'SESSION') + '.json';
}
const writeDirectories = new Map<string, string>();
function writeKey(namespace: string, sessionId: string): string {
  return namespace + ':' + sessionId;
}
function hearingCanvasPath(namespace: string, sessionId: string, version: string): string {
  const root =
    writeDirectories.get(writeKey(namespace, sessionId)) || hearingDirectory(namespace, sessionId);
  return (
    root +
    '/' +
    safeSegment(sessionId, 'SESSION') +
    '.' +
    safeSegment(version, 'CANVAS_VERSION') +
    '.html'
  );
}
function legacyCanvasPath(namespace: string, sessionId: string, version: string): string {
  return (
    HEARING_ROOT +
    '/' +
    safeSegment(namespace, 'TENANT') +
    '/' +
    safeSegment(sessionId, 'SESSION') +
    '.' +
    safeSegment(version, 'CANVAS_VERSION') +
    '.html'
  );
}

export function loadHearingRecord(namespace: string, sessionId: string): HearingRecord | null {
  const durable = safeExistsSync(hearingDirectory(namespace, sessionId));
  const filePath = durable
    ? hearingPath(namespace, sessionId)
    : legacyHearingPath(namespace, sessionId);
  if (!safeExistsSync(filePath)) {
    if (durable)
      throw new Error(
        '[HEARING_STORE_UNRESOLVED] canonical record missing; operator review required'
      );
    return null;
  }
  const parsed = readJson<HearingRecord>(filePath);
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
  if (hearingRevision(parsed.decision_revision) > hearingRevision(parsed.record_revision))
    throw new Error('[HEARING_RECORD_INVALID] decision revision exceeds record revision');
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
  if (
    !durable &&
    (parsed.decision_receipts !== undefined || parsed.current_decision_operation_id !== undefined)
  )
    throw new Error('[HEARING_RECEIPT_INVALID] legacy storage cannot prove a durable operation');
  try {
    validateDecisionReceipts(parsed, namespace);
  } catch {
    throw new Error('[HEARING_RECEIPT_INVALID] malformed durable decision receipt');
  }
  return parsed;
}

export type HearingConflict =
  | 'stale_snapshot'
  | 'completion_locked'
  | 'handoff_unresolved'
  | 'operation_mismatch'
  | 'migration_required'
  | 'receipt_capacity';

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
    hearingRevision(current.decision_revision) !== hearingRevision(expected.decision_revision) ||
    current.current_decision_operation_id !== expected.current_decision_operation_id ||
    current.decided_at !== expected.decided_at ||
    JSON.stringify(current.decided_by) !== JSON.stringify(expected.decided_by)
  ) {
    throw new HearingConflictError('stale_snapshot');
  }
}

function writeHearingRecord(namespace: string, record: HearingRecord): string {
  const filePath =
    (writeDirectories.get(writeKey(namespace, record.session_id)) ||
      hearingDirectory(namespace, record.session_id)) +
    '/' +
    record.session_id +
    '.json';
  safeWriteFile(filePath, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8' });
  return filePath;
}

/** All writers share this short synchronous read/modify/write fence across processes.
 * No model call or subprocess runs inside it. The mutex requires shared PID/filesystem namespaces.
 */
export function updateHearingRecord(
  namespace: string,
  sessionId: string,
  update: (current: HearingRecord | null) => HearingRecord,
  options: { allowLegacyMigration?: boolean } = {}
): HearingRecord {
  return withLockSync(
    'hearing:' + safeSegment(namespace, 'TENANT') + ':' + safeSegment(sessionId, 'SESSION'),
    () => {
      const current = loadHearingRecord(namespace, sessionId);
      const directory = hearingDirectory(namespace, sessionId);
      const exists = safeExistsSync(directory);
      if (!exists && !options.allowLegacyMigration)
        throw new HearingConflictError('migration_required');
      const stage = exists ? undefined : directory + '.migration-' + randomUUID();
      const key = writeKey(namespace, sessionId);
      writeDirectories.set(key, stage || directory);
      try {
        if (stage && current) {
          for (const version of current.canvas_versions) {
            const legacy = legacyCanvasPath(namespace, sessionId, version);
            if (safeExistsSync(legacy))
              safeWriteFile(hearingCanvasPath(namespace, sessionId, version), safeReadFile(legacy));
          }
        }
        const next = update(current);
        if (next === current && current) return current;
        if (
          !next ||
          next.session_id !== sessionId ||
          typeof (next as unknown as { then?: unknown }).then === 'function'
        ) {
          throw new Error('[HEARING_UPDATE_INVALID] synchronous record update required');
        }
        const changed =
          !current || hearingRequirementsKey(current) !== hearingRequirementsKey(next);
        const committed: HearingRecord = {
          ...next,
          record_revision: hearingRevision(current?.record_revision) + 1,
          requirements_revision:
            hearingRevision(current?.requirements_revision) + (changed ? 1 : 0),
        };
        if (current && changed) {
          delete committed.decided_at;
          delete committed.decided_by;
          delete committed.decision_revision;
          delete committed.current_decision_operation_id;
        }
        validateDecisionReceipts(committed, namespace);
        writeHearingRecord(namespace, committed);
        if (stage) safeMoveSync(stage, directory);
        return committed;
      } finally {
        writeDirectories.delete(key);
        if (stage && safeExistsSync(stage)) safeRmSync(stage, { recursive: true, force: true });
      }
    }
  );
}

/** Compatibility writer for fixtures/callers: replacement requires the current revision.
 * Routes use updateHearingRecord so they can patch the locked latest record instead.
 */
export function saveHearingRecord(namespace: string, record: HearingRecord): string {
  updateHearingRecord(
    namespace,
    record.session_id,
    (current) => {
      if (current) {
        assertHearingEditable(current);
        assertHearingSnapshot(current, record);
      }
      return record;
    },
    { allowLegacyMigration: true }
  );
  return hearingPath(namespace, record.session_id);
}

/** Must be called inside updateHearingRecord. Skip orphan HTML from failed record writes. */
export function saveHearingCanvasVersion(
  namespace: string,
  record: HearingRecord,
  html: string
): string {
  if (!writeDirectories.has(writeKey(namespace, record.session_id)))
    throw new Error('[HEARING_CANVAS_WRITE_UNLOCKED] locked update required');
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
 * Unknown effects retain this durable reservation; it is not proof of the external effect.
 */
export function reserveHearingHandoff(
  namespace: string,
  expected: HearingRecord,
  kind: 'mission' | 'inventory',
  now: string
): HearingRecord {
  return updateHearingRecord(
    namespace,
    expected.session_id,
    (current) => {
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
    },
    { allowLegacyMigration: true }
  );
}

export function finishHearingHandoff(
  namespace: string,
  reserved: HearingRecord,
  patch: Partial<HearingRecord>
): HearingRecord {
  return updateHearingRecord(
    namespace,
    reserved.session_id,
    (current) => {
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
    },
    { allowLegacyMigration: true }
  );
}

export function loadHearingCanvasVersion(
  namespace: string,
  sessionId: string,
  version: string
): string | null {
  const filePath = safeExistsSync(hearingDirectory(namespace, sessionId))
    ? hearingCanvasPath(namespace, sessionId, version)
    : legacyCanvasPath(namespace, sessionId, version);
  if (!safeExistsSync(filePath)) return null;
  const raw = safeReadFile(filePath, { encoding: 'utf8' });
  return typeof raw === 'string' ? raw : raw.toString('utf8');
}

export function hearingNamespace(tenantSlugs: string[] | 'all'): string {
  if (tenantSlugs === 'all') return 'all';
  if (tenantSlugs.some((tenant) => tenant === 'all' || tenant === 'unscoped')) {
    throw new Error('[HEARING_SCOPE_AMBIGUOUS] tenant collides with legacy hearing namespace');
  }
  if (tenantSlugs.length > 1) throw new Error('[HEARING_SCOPE_AMBIGUOUS] select one tenant');
  if (tenantSlugs.length === 0) return 'unscoped';
  const tenant = tenantSlugs[0];
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(tenant))
    throw new Error('[HEARING_SCOPE_INVALID] invalid tenant');
  return tenant;
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
  const card = (
    item: HearingRecord['requirements'][number]
  ) => `<article class="requirement ${item.answer ? 'answered' : 'open'}">
        <h2>${escapeHtml(
          item.label_source === 'tenant' && item.label_text
            ? item.label_text
            : catalogT(item.label_key as VocabularyKey, undefined, locale)
        )}</h2>
        <p>${escapeHtml(item.answer || unanswered)}</p>
      </article>`;
  // Phase-structured sheets are drawn phase by phase (heading + its cards);
  // flat scenarios keep the single list.
  const cards = record.phases?.length
    ? record.phases
        .map((phase) => {
          const own = record.requirements.filter((item) => item.phase_id === phase.id);
          const done = own.filter((item) => item.answer?.trim()).length;
          return `<section class="phase"><h2 class="phase-title">${escapeHtml(
            catalogT(phase.title_key as VocabularyKey, undefined, locale)
          )} <small>${done}/${own.length}</small></h2><div class="grid">${own.map(card).join('\n')}</div></section>`;
        })
        .join('\n')
    : record.requirements.map(card).join('\n');
  const pageTitle = catalogT('front_desk:hearing_canvas_page_title', undefined, locale);
  const heading = catalogT('front_desk:hearing_canvas_heading', undefined, locale);
  const coverage = catalogT(
    'front_desk:hearing_canvas_coverage',
    { complete, total: record.requirements.length },
    locale
  );
  return `<!doctype html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(pageTitle)}</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#faf9f6;color:#26231d}h1{font-size:22px;margin:0 0 8px}.meta{color:#706b60;font-size:13px;margin:0 0 18px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.requirement{padding:14px;border:1px solid #e3ddd1;border-radius:12px;background:#fff}.requirement h2{font-size:14px;margin:0 0 8px}.requirement p{font-size:13px;line-height:1.5;margin:0;color:#706b60}.answered{border-color:#a98a54}.answered p{color:#26231d}.phase-title{font-size:15px;margin:18px 0 8px}.phase-title small{color:#706b60;font-weight:400}</style></head><body><h1>${escapeHtml(heading)}</h1><p class="meta">${escapeHtml(coverage)}</p><main${record.phases?.length ? '' : ' class="grid"'}>${cards}</main></body></html>`;
}

/** Versioned wire contract. Empty legacy bodies never create or backfill receipt proof. */
export class HearingOperationError extends Error {
  readonly status = 400;
}
export function parseHearingDecisionOperation(input: unknown): HearingDecisionOperation | null {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new HearingOperationError('Decision request must be an object.');
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if (!keys.length) return null;
  if (
    keys.length !== 4 ||
    keys.some(
      (key) => !['version', 'operation_id', 'scenario_id', 'requirements_revision'].includes(key)
    ) ||
    value.version !== 1 ||
    typeof value.operation_id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u.test(value.operation_id) ||
    typeof value.scenario_id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u.test(value.scenario_id) ||
    !Number.isSafeInteger(value.requirements_revision) ||
    Number(value.requirements_revision) < 0
  ) {
    throw new HearingOperationError('Invalid versioned hearing decision operation.');
  }
  return {
    version: 1,
    operation_id: value.operation_id,
    scenario_id: value.scenario_id,
    requirements_revision: Number(value.requirements_revision),
  };
}
function operationKey(operation: HearingDecisionOperation): string {
  return JSON.stringify([
    operation.version,
    operation.operation_id,
    operation.scenario_id,
    operation.requirements_revision,
  ]);
}
function identityKey(identity: HearingDecisionIdentity): string {
  return JSON.stringify([
    identity.principal_id,
    identity.member_id,
    identity.source,
    identity.scope_key,
  ]);
}
function validateDecisionReceipts(record: HearingRecord, namespace: string): void {
  if (record.decision_receipts === undefined) {
    if (record.current_decision_operation_id !== undefined)
      throw new Error('[HEARING_RECEIPT_INVALID] current operation has no receipt');
    return;
  }
  if (!Array.isArray(record.decision_receipts) || record.decision_receipts.length > 128)
    throw new Error('[HEARING_RECEIPT_INVALID] invalid receipt collection');
  const seen = new Set<string>();
  let previousRevision = 0;
  for (const receipt of record.decision_receipts) {
    if (
      !receipt ||
      !receipt.identity ||
      !receipt.operation ||
      !parseHearingDecisionOperation(receipt.operation) ||
      typeof receipt.identity.member_id !== 'string' ||
      !receipt.identity.member_id ||
      typeof receipt.identity.principal_id !== 'string' ||
      !receipt.identity.principal_id ||
      typeof receipt.identity.scope_key !== 'string' ||
      !receipt.identity.scope_key ||
      !['loopback', 'token'].includes(receipt.identity.source) ||
      receipt.namespace !== namespace ||
      receipt.session_id !== record.session_id ||
      typeof receipt.decided_at !== 'string' ||
      !Number.isFinite(Date.parse(receipt.decided_at)) ||
      !Number.isSafeInteger(receipt.record_revision) ||
      receipt.record_revision <= previousRevision ||
      receipt.record_revision > hearingRevision(record.record_revision) ||
      receipt.operation.requirements_revision > hearingRevision(record.requirements_revision) ||
      seen.has(receipt.operation.operation_id)
    )
      throw new Error('[HEARING_RECEIPT_INVALID] invalid operation binding');
    seen.add(receipt.operation.operation_id);
    previousRevision = receipt.record_revision;
  }
  if (
    record.current_decision_operation_id !== undefined &&
    (record.decision_receipts.at(-1)?.operation.operation_id !==
      record.current_decision_operation_id ||
      !record.decision_receipts.some(
        (receipt) =>
          receipt.operation.operation_id === record.current_decision_operation_id &&
          receipt.operation.scenario_id === record.scenario &&
          receipt.operation.requirements_revision ===
            hearingRevision(record.requirements_revision) &&
          humanActor(receipt.identity.member_id).id === record.decided_by?.id &&
          receipt.decided_at === record.decided_at
      ))
  ) {
    throw new Error('[HEARING_RECEIPT_INVALID] current decision binding mismatch');
  }
}
export function hearingDecisionReceipt(
  record: HearingRecord | null,
  namespace: string,
  operation: HearingDecisionOperation,
  identity: HearingDecisionIdentity
): { receipt: HearingDecisionReceipt; status: 'current' | 'superseded' } | null {
  if (!record) return null;
  validateDecisionReceipts(record, namespace);
  const receipt = record.decision_receipts?.find(
    (item) => item.operation.operation_id === operation.operation_id
  );
  if (!receipt) return null;
  if (
    operationKey(receipt.operation) !== operationKey(operation) ||
    identityKey(receipt.identity) !== identityKey(identity)
  ) {
    throw new HearingConflictError('operation_mismatch');
  }
  return {
    receipt,
    status:
      record.current_decision_operation_id === operation.operation_id ? 'current' : 'superseded',
  };
}
/** Exact operation replay returns before any record mutation, including revision bumps. */
export function decideHearingRecord(
  namespace: string,
  sessionId: string,
  operation: HearingDecisionOperation | null,
  identity: HearingDecisionIdentity,
  decidedBy: HearingDecidedBy,
  now: string,
  expectedLegacy?: HearingRecord
): HearingRecord {
  return updateHearingRecord(
    namespace,
    sessionId,
    (current) => {
      if (!current) throw new HearingOperationError('Hearing record does not exist yet.');
      if (operation && hearingDecisionReceipt(current, namespace, operation, identity))
        return current;
      assertHearingEditable(current);
      if (!operation && expectedLegacy) assertHearingSnapshot(current, expectedLegacy);
      if (
        operation &&
        (operation.scenario_id !== current.scenario ||
          operation.requirements_revision !== hearingRevision(current.requirements_revision))
      )
        throw new HearingConflictError('stale_snapshot');
      if (
        !current.requirements.length ||
        current.requirements.some((item) => !item.answer?.trim())
      ) {
        throw new HearingOperationError('Hearing has unanswered requirements.');
      }
      const next: HearingRecord = {
        ...current,
        decided_by: decidedBy,
        decided_at: now,
        decision_revision: hearingRevision(current.record_revision) + 1,
        updated_at: now,
      };
      delete next.current_decision_operation_id;
      if (operation) {
        if ((current.decision_receipts?.length || 0) >= 128)
          throw new HearingConflictError('receipt_capacity');
        next.current_decision_operation_id = operation.operation_id;
        next.decision_receipts = [
          ...(current.decision_receipts || []),
          {
            operation,
            identity,
            namespace,
            session_id: sessionId,
            record_revision: hearingRevision(current.record_revision) + 1,
            decided_at: now,
          },
        ];
      }
      return next;
    },
    { allowLegacyMigration: true }
  );
}
