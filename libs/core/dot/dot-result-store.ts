/** Exact confidential result persistence. This records trusted executor status, not effect authority. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { readJsonLines } from '../foundation/json.js';
import {
  withDotResultStoreCapability,
  DOT_RESULT_STORE_ROLE,
  type DotResultStoreBinding,
  type DotResultStoreOperation,
} from '../foundation/dot-result-store-capability.js';
import {
  assertSafeRepositoryPath,
  safeLstat,
  safeReadFile,
  safeMkdir,
  safeAppendFileSync,
} from '../secure-io.js';
import { findDotCharter, validateDotCharter, type DotCharter } from './dot-charter.js';
import { readDotActionLedgerStrict, assertDotActionJudgmentBinding } from './dot-action-ledger.js';
import { dotWorkItemInput } from './dot-work-item.js';
import { dotStatePath, DOT_WORK_RESULTS_FILE, type DotWorkResultRow } from './dot-state-paths.js';
import { getWorkItem, listCoordinationEvents } from '../workforce/work-coordination.js';
import {
  withCoordinationRoot,
  currentLeaseRecords,
  itemsPath,
} from '../workforce/work-coordination-ledger.js';
import {
  buildWorkItemCreation,
  assertOriginalWorkItemIdentity,
  validateWorkItem,
} from '../workforce/work-coordination-identity.js';
import { workEffectOwnership } from '../workforce/work-effect-ownership.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import {
  consumeDotResultOutcomePermit,
  consumeDotReportMarkerPermit,
} from './dot-result-origin.js';
import {
  dotResultCanonicalJson,
  dotResultHash,
  dotResultDigest,
  dotResultScopeSchema,
  parseDotReportMarker,
  projectDotResultRecords,
  executorReportKey,
  type DotReportMarker,
  type DotResultScope,
} from './dot-result-records.js';

const key = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value);
const time = z
  .string()
  .datetime()
  .refine((value) => new Date(value).toISOString() === value);
const rowSchema = z
  .object({
    dot_id: key,
    work_item_id: key,
    action_ref: key,
    attempt_id: key,
    mode: z.enum(['goal_turn', 'delegated', 'pipeline', 'escalated']),
    status: z.enum(['done', 'blocked', 'failed']),
    summary: z.string().max(600),
    started_at: time,
    completed_at: time,
    tokens_used: z.number().finite().int().nonnegative().optional(),
    report_to_dot_id: key.optional(),
    report_enqueued_at: time.optional(),
    report_suppressed: z.literal('capability_unavailable').optional(),
    reason_code: z.enum(['capability_unavailable', 'pre_effect_failure']).optional(),
    awaiting_approval: z.boolean().optional(),
    pipeline_run_id: key.optional(),
    approval_request_id: key.optional(),
    storage_channel: key.optional(),
    front_desk_verification: z
      .object({
        artifact_path: key,
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        request_digest: key,
        revision: z.number().int().positive(),
        verified_at: time,
      })
      .strict()
      .optional(),
    kr_snapshot: z.record(z.string(), z.number().finite()).optional(),
    signal_snapshot: z.record(z.string(), z.union([z.literal(0), z.literal(1)])).optional(),
  })
  .strict();
export interface ConfidentialDotResultState {
  dot_id: string;
  work_item_id: string;
  action_ref: string;
  attempt_id: string;
  mode: DotWorkResultRow['mode'];
  status: 'done' | 'blocked' | 'failed';
  started_at: string;
  completed_at: string;
  report_to_dot_id?: string;
  report_enqueued_at?: string;
  report_suppressed?: DotWorkResultRow['report_suppressed'];
  reason_code?: DotWorkResultRow['reason_code'];
  awaiting_approval?: boolean;
  result_digest: string;
}
export interface ConfidentialDotResultWrite {
  status: 'persisted';
  appended: boolean;
  result: ConfidentialDotResultState;
}
type Options = { rootDir?: string };
function detach<T>(value: T): T {
  return JSON.parse(dotResultCanonicalJson(value));
}
function normalize(charter: DotCharter, options: Options) {
  dotResultCanonicalJson(charter);
  dotResultCanonicalJson(options);
  const selected = z.object({ rootDir: z.string().optional() }).strict().parse(options);
  const rootDir = selected.rootDir ?? pathResolver.rootDir();
  if (path.resolve(rootDir) !== rootDir || rootDir !== path.resolve(pathResolver.rootDir()))
    throw new Error('Result root differs from canonical repository');
  const captured = validateDotCharter(detach(charter));
  if (captured.authority.authority_role === DOT_RESULT_STORE_ROLE)
    throw new Error('Result store role cannot execute a charter');
  const scope = dotResultScopeSchema.parse(captured.scope);
  // Existing authorized source reader only: no new capability is active here.
  const current = findDotCharter(captured.dot_id, rootDir)?.charter;
  if (
    !current ||
    current.dot_id !== captured.dot_id ||
    dotResultHash(current.scope) !== dotResultHash(scope)
  )
    throw new Error('Persisted DOT ownership differs');
  const binding: DotResultStoreBinding = {
    rootDir,
    scope,
    dotId: captured.dot_id,
    file: dotStatePath(captured, DOT_WORK_RESULTS_FILE),
  };
  return { charter: captured, binding };
}
function privileged<T>(
  binding: DotResultStoreBinding,
  operation: DotResultStoreOperation,
  io: () => T
): T {
  return withDotResultStoreCapability(binding, operation, () =>
    withExecutionContext(
      DOT_RESULT_STORE_ROLE,
      io,
      undefined,
      binding.scope.tenant_slug,
      binding.scope.organization_id
    )
  );
}
function parseRow(value: unknown): DotWorkResultRow & { attempt_id: string } {
  const before = dotResultCanonicalJson(value),
    parsed = rowSchema.parse(value);
  if (
    before !== dotResultCanonicalJson(parsed) ||
    Date.parse(parsed.completed_at) < Date.parse(parsed.started_at)
  )
    throw new Error('Invalid result row');
  if (
    parsed.awaiting_approval &&
    (parsed.status !== 'blocked' ||
      !parsed.pipeline_run_id ||
      !parsed.approval_request_id ||
      !parsed.storage_channel)
  )
    throw new Error('Suspended result proof incomplete');
  if (
    (parsed.reason_code === 'pre_effect_failure' && parsed.status !== 'failed') ||
    (parsed.mode === 'escalated' && parsed.status === 'done')
  )
    throw new Error('Result status and phase differ');
  return parsed;
}
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
interface AppendState {
  exists: boolean;
  bytes: number;
  endsWithLF: boolean;
  fingerprint?: { dev: number; ino: number; size: number; mtimeMs: number };
}
interface RawSnapshot {
  records: unknown[];
  appendState: AppendState;
}
function raw(binding: DotResultStoreBinding): RawSnapshot {
  return privileged(binding, 'read_state', () => {
    const file = assertSafeRepositoryPath(path.join(binding.rootDir, binding.file), {
      allowMissingLeaf: true,
    });
    let stat;
    try {
      stat = safeLstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { records: [], appendState: { exists: false, bytes: 0, endsWithLF: true } };
      throw error;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RESULT_BYTES)
      throw new Error('Invalid retained result file');
    const text = String(safeReadFile(file, { encoding: 'utf8' }));
    const rows: unknown[] = [];
    for (const line of text.split('\n')) if (line.trim()) rows.push(JSON.parse(line));
    const after = safeLstat(file);
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs
    )
      throw new Error('Result file changed while reading');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes !== stat.size) throw new Error('Result byte length differs');
    return {
      records: rows,
      appendState: {
        exists: true,
        bytes,
        endsWithLF: text.endsWith('\n'),
        fingerprint: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs },
      },
    };
  });
}
function projected(records: readonly unknown[], scope: DotResultScope) {
  // Validate every row in the shared file before filtering this DOT. No other DOT body escapes.
  for (const row of records) {
    dotResultCanonicalJson(row);
    if (row && typeof row === 'object' && Object.hasOwn(row, 'kind')) parseDotReportMarker(row);
    else parseRow(row);
  }
  return projectDotResultRecords(records, scope).map(parseRow);
}
function state(row: DotWorkResultRow & { attempt_id: string }): ConfidentialDotResultState {
  return detach({
    dot_id: row.dot_id,
    work_item_id: row.work_item_id,
    action_ref: row.action_ref,
    attempt_id: row.attempt_id,
    mode: row.mode,
    status: row.status as ConfidentialDotResultState['status'],
    started_at: row.started_at,
    completed_at: row.completed_at,
    ...Object.fromEntries(
      [
        'report_to_dot_id',
        'report_enqueued_at',
        'report_suppressed',
        'reason_code',
        'awaiting_approval',
      ]
        .filter((key) => Object.hasOwn(row, key))
        .map((key) => [key, row[key as keyof DotWorkResultRow]])
    ),
    result_digest: dotResultDigest(row),
  });
}
function lock(binding: DotResultStoreBinding): string {
  // Same existing file lock identity as dot-executor-reports, without importing its runtime cycle.
  return (
    'dot-results-' +
    createHash('sha256')
      .update(path.resolve(binding.rootDir, binding.file))
      .digest('hex')
      .slice(0, 24)
  );
}
function append(
  binding: DotResultStoreBinding,
  operation: 'append_result' | 'append_report_marker',
  value: unknown,
  snapshot: AppendState
): void {
  const line =
    (snapshot.bytes > 0 && !snapshot.endsWithLF ? '\n' : '') + dotResultCanonicalJson(value) + '\n';
  if (snapshot.bytes + Buffer.byteLength(line, 'utf8') > MAX_RESULT_BYTES)
    throw new Error('Result append exceeds retained byte limit');
  privileged(binding, operation, () => {
    const file = assertSafeRepositoryPath(path.join(binding.rootDir, binding.file), {
      allowMissingLeaf: true,
    });
    try {
      const stat = safeLstat(file);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid result append target');
      const expected = snapshot.fingerprint;
      if (
        !snapshot.exists ||
        !expected ||
        stat.dev !== expected.dev ||
        stat.ino !== expected.ino ||
        stat.size !== expected.size ||
        stat.mtimeMs !== expected.mtimeMs
      )
        throw new Error('Result file changed before append');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (snapshot.exists) throw new Error('Result file disappeared before append');
    }
    safeMkdir(path.dirname(file), { recursive: true });
    safeAppendFileSync(file, line);
  });
}
function validateOriginalSource(
  charter: DotCharter,
  row: DotWorkResultRow & { attempt_id: string },
  binding: DotResultStoreBinding
) {
  const currentCharter = findDotCharter(charter.dot_id, binding.rootDir)?.charter;
  if (
    !currentCharter ||
    currentCharter.dot_id !== charter.dot_id ||
    dotResultHash(currentCharter.scope) !== dotResultHash(binding.scope)
  )
    throw new Error('Current DOT ownership changed before result publication');
  const records = readDotActionLedgerStrict({ rootDir: binding.rootDir, dotId: charter.dot_id });
  const action = records.filter((record) => record.action_ref === row.action_ref).at(-1);
  if (!action) throw new Error('Original action missing');
  assertDotActionJudgmentBinding(action);
  const actor = 'dot:' + charter.dot_id;
  if (
    action.dot_id !== charter.dot_id ||
    action.actor_id !== actor ||
    action.status !== 'dispatched' ||
    action.work_item_id !== row.work_item_id ||
    !action.admission ||
    dotResultHash(action.scope) !== dotResultHash(binding.scope)
  )
    throw new Error('Original action differs');
  const item = getWorkItem(row.work_item_id, { rootDir: binding.rootDir });
  if (!item) throw new Error('Original WorkItem missing');
  const input = dotWorkItemInput(charter, action, binding.rootDir);
  const history = withCoordinationRoot(binding.rootDir, () =>
    readJsonLines<WorkItem>(itemsPath()).filter((record) => record.item_id === item.item_id)
  );
  history.forEach(validateWorkItem);
  if (!history.length) throw new Error('Original WorkItem history missing');
  assertOriginalWorkItemIdentity(history, buildWorkItemCreation(input));
  const original = history[0];
  if (
    ['source', 'source_ref', 'project_id'].some(
      (field) => item[field as keyof WorkItem] !== original[field as keyof WorkItem]
    ) ||
    dotResultHash(item.context) !== dotResultHash(original.context)
  )
    throw new Error('Current WorkItem creation scope differs');
  for (const field of [
    'dot_id',
    'action_ref',
    'requested_work_shape',
    'pipeline_ref',
    'target',
    'intent',
    'semantic_judgment',
    'front_desk_execution',
    'continuous_work',
    'mission_admission',
    'gate_action_id',
    'admission_only',
  ]) {
    const before = original.metadata ?? {},
      current = item.metadata ?? {};
    if (
      Object.hasOwn(before, field) !== Object.hasOwn(current, field) ||
      (Object.hasOwn(before, field) &&
        dotResultHash(before[field]) !== dotResultHash(current[field]))
    )
      throw new Error('Current immutable execution metadata differs');
  }
  return { item, history, actor, action };
}
function validateActiveSource(
  charter: DotCharter,
  row: DotWorkResultRow & { attempt_id: string },
  binding: DotResultStoreBinding
): string {
  const { item, actor } = validateOriginalSource(charter, row, binding);
  if (
    item.status !== 'in_progress' ||
    item.current_attempt_id !== row.attempt_id ||
    !item.lease_id ||
    item.claimed_by_peer_id !== actor ||
    item.metadata?.dot_id !== charter.dot_id ||
    item.metadata?.action_ref !== row.action_ref ||
    (['tenant_slug', 'organization_id', 'project_id'] as const).some(
      (field) => item.context?.[field] !== binding.scope[field]
    )
  )
    throw new Error('Current claim differs');
  const running = item.attempts?.filter((attempt) => attempt.status === 'running') ?? [];
  const attempt = running[0];
  const lease = withCoordinationRoot(binding.rootDir, () =>
    currentLeaseRecords().find((lease) => lease.lease_id === item.lease_id)
  );
  const now = Date.now();
  if (
    running.length !== 1 ||
    !attempt ||
    attempt.run_id !== row.attempt_id ||
    attempt.lease_id !== item.lease_id ||
    attempt.actor_peer_id !== actor ||
    attempt.ended_at ||
    !lease ||
    lease.status !== 'active' ||
    lease.released_at ||
    lease.item_id !== item.item_id ||
    lease.holder_peer_id !== actor ||
    lease.holder_user_id !== attempt.actor_user_id ||
    lease.holder_user_id !== item.claimed_by_user_id ||
    !Number.isFinite(Date.parse(lease.expires_at)) ||
    Date.parse(lease.expires_at) <= now ||
    !Number.isFinite(Date.parse(attempt.started_at)) ||
    Date.parse(row.started_at) > Date.parse(attempt.started_at) ||
    Date.parse(attempt.started_at) > Date.parse(row.completed_at) ||
    Date.parse(row.completed_at) > now
  )
    throw new Error('Actual attempt or lease differs');
  const ownership = workEffectOwnership(item);
  if (
    ownership &&
    (ownership.state !== 'held' ||
      ownership.actor_id !== actor ||
      ownership.attempt_id !== row.attempt_id ||
      ownership.tenant_slug !== binding.scope.tenant_slug)
  )
    throw new Error('Effect ownership differs');
  return lease.lease_id;
}

/** Expiry proves scheduling ownership ended, never that an unobserved provider effect stopped. */
function validateNegativeRecoverySource(
  charter: DotCharter,
  row: DotWorkResultRow & { attempt_id: string },
  binding: DotResultStoreBinding
): string {
  if (
    row.status !== 'blocked' ||
    row.mode !== 'escalated' ||
    row.reason_code !== undefined ||
    row.awaiting_approval ||
    row.pipeline_run_id ||
    row.approval_request_id ||
    row.storage_channel ||
    row.front_desk_verification ||
    row.tokens_used !== undefined ||
    row.kr_snapshot ||
    row.signal_snapshot
  )
    throw new Error('Negative recovery can record only an unknown blocked effect');
  const { item, history, actor, action } = validateOriginalSource(charter, row, binding);
  const attempt = item.attempts?.at(-1),
    ownership = workEffectOwnership(item),
    now = Date.now();
  if (
    !['ready', 'blocked'].includes(item.status) ||
    item.lease_id ||
    item.current_attempt_id ||
    item.claimed_by_peer_id ||
    item.claimed_by_user_id ||
    item.attempts?.some((value) => value.status === 'running') ||
    !attempt ||
    attempt.run_id !== row.attempt_id ||
    attempt.status !== 'released' ||
    attempt.failure_reason !== 'lease_expired' ||
    attempt.actor_peer_id !== actor ||
    !attempt.lease_id ||
    !attempt.ended_at ||
    !ownership ||
    ownership.state !== 'held' ||
    ownership.attempt_id !== row.attempt_id ||
    ownership.actor_id !== actor ||
    ownership.tenant_slug !== binding.scope.tenant_slug ||
    action.superseded_by ||
    (item.metadata?.dot_executor as { operator_verified_at?: unknown } | undefined)
      ?.operator_verified_at
  )
    throw new Error('Unsupported negative recovery state');
  const leases = withCoordinationRoot(binding.rootDir, currentLeaseRecords),
    lease = leases.find((value) => value.lease_id === attempt.lease_id);
  if (
    !lease ||
    lease.status !== 'expired' ||
    lease.released_at ||
    lease.item_id !== item.item_id ||
    lease.holder_peer_id !== actor ||
    lease.holder_user_id !== attempt.actor_user_id ||
    leases.some((value) => value.item_id === item.item_id && value.status === 'active') ||
    !Number.isFinite(Date.parse(lease.expires_at)) ||
    Date.parse(lease.expires_at) > now ||
    !Number.isFinite(Date.parse(attempt.started_at)) ||
    !Number.isFinite(Date.parse(attempt.ended_at)) ||
    Date.parse(attempt.started_at) > Date.parse(lease.expires_at) ||
    Date.parse(lease.expires_at) > Date.parse(attempt.ended_at) ||
    Date.parse(attempt.ended_at) > Date.parse(row.started_at) ||
    Date.parse(row.completed_at) > now
  )
    throw new Error('Expired lease history differs');
  const claim = history
    .filter(
      (value) =>
        value.status === 'in_progress' &&
        value.current_attempt_id === row.attempt_id &&
        value.lease_id === lease.lease_id
    )
    .at(-1);
  if (
    !claim ||
    claim.claimed_by_peer_id !== actor ||
    claim.claimed_by_user_id !== lease.holder_user_id ||
    dotResultHash(claim.context) !== dotResultHash(item.context) ||
    dotResultHash(workEffectOwnership(claim)) !== dotResultHash(ownership)
  )
    throw new Error('Historical actual claim differs');
  const knownRuns = new Set(claim.attempts?.map((value) => value.run_id));
  if (
    history.some(
      (value) =>
        value.version > claim.version &&
        value.attempts?.some((value) => !knownRuns.has(value.run_id))
    )
  )
    throw new Error('A newer execution attempt supersedes recovery');
  const events = withCoordinationRoot(binding.rootDir, () =>
    listCoordinationEvents({ item_id: item.item_id })
  );
  const unique = (kind: string, predicate: (event: (typeof events)[number]) => boolean) => {
    const rows = events.filter((event) => event.event_type === kind && predicate(event));
    if (rows.length !== 1 || !Number.isFinite(Date.parse(rows[0].ts)))
      throw new Error('Required recovery event missing or ambiguous');
    return rows[0];
  };
  const claimed = unique(
    'item_claimed',
    (event) =>
      event.lease_id === lease.lease_id &&
      event.actor_peer_id === actor &&
      event.actor_user_id === lease.holder_user_id &&
      event.status === 'active' &&
      event.payload?.holder_peer_id === actor &&
      event.payload?.holder_user_id === lease.holder_user_id
  );
  const started = unique(
    'item_attempt_started',
    (event) =>
      event.payload?.run_id === row.attempt_id &&
      event.payload?.lease_id === lease.lease_id &&
      event.payload?.actor_peer_id === actor &&
      event.payload?.actor_user_id === lease.holder_user_id &&
      event.payload?.status === 'running'
  );
  const expired = unique(
    'lease_expired',
    (event) =>
      event.lease_id === lease.lease_id &&
      event.status === 'expired' &&
      event.payload?.holder_peer_id === actor &&
      event.payload?.holder_user_id === lease.holder_user_id &&
      event.payload?.expires_at === lease.expires_at
  );
  const released = unique(
    'item_attempt_released',
    (event) =>
      event.payload?.run_id === row.attempt_id &&
      event.payload?.lease_id === lease.lease_id &&
      event.payload?.actor_peer_id === actor &&
      event.payload?.actor_user_id === lease.holder_user_id &&
      event.payload?.status === 'released' &&
      event.payload?.failure_reason === 'lease_expired' &&
      event.payload?.started_at === attempt.started_at &&
      event.payload?.ended_at === attempt.ended_at
  );
  if (
    Date.parse(claimed.ts) > Date.parse(started.ts) ||
    Date.parse(started.ts) > Date.parse(expired.ts) ||
    Date.parse(expired.ts) < Date.parse(lease.expires_at) ||
    Date.parse(expired.ts) > Date.parse(released.ts) ||
    Date.parse(released.ts) > Date.parse(row.started_at)
  )
    throw new Error('Recovery event order differs');
  return dotResultHash({
    item,
    lease,
    claim,
    action,
    events: [claimed, started, expired, released],
  });
}

/** Active execution and exact expired-lease quarantine only; pipeline continuation remains unavailable. */
export function appendConfidentialDotWorkResult(
  charter: DotCharter,
  row: DotWorkResultRow,
  permit: unknown,
  options: Options = {}
): ConfidentialDotResultWrite {
  const normalized = normalize(charter, options),
    detachedRow = parseRow(row);
  if (
    detachedRow.dot_id !== normalized.charter.dot_id ||
    detachedRow.report_enqueued_at ||
    detachedRow.report_suppressed
  )
    throw new Error('Result DOT or initial receipt differs');
  const active =
    getWorkItem(detachedRow.work_item_id, { rootDir: normalized.binding.rootDir })?.status ===
    'in_progress';
  const phase = active ? 'active_execution' : 'negative_recovery';
  const proof = active
    ? validateActiveSource(normalized.charter, detachedRow, normalized.binding)
    : validateNegativeRecoverySource(normalized.charter, detachedRow, normalized.binding);
  consumeDotResultOutcomePermit(permit, {
    rootDir: normalized.binding.rootDir,
    charter: normalized.charter,
    scope: normalized.binding.scope,
    row: detachedRow,
    phase,
    ...(active ? { leaseId: proof } : {}),
  });
  return withLockSync(lock(normalized.binding), () => {
    const snapshot = raw(normalized.binding);
    const rows = projected(snapshot.records, normalized.binding.scope);
    const existing = rows.filter(
      (entry) =>
        entry.dot_id === detachedRow.dot_id &&
        entry.work_item_id === detachedRow.work_item_id &&
        entry.attempt_id === detachedRow.attempt_id
    );
    if (existing.length) {
      if (existing.length !== 1 || dotResultDigest(existing[0]) !== dotResultDigest(detachedRow))
        throw new Error('Conflicting execution result');
      if (
        (active
          ? validateActiveSource(normalized.charter, detachedRow, normalized.binding)
          : validateNegativeRecoverySource(normalized.charter, detachedRow, normalized.binding)) !==
        proof
      )
        throw new Error('Recovery or claim changed before result adoption');
      return { status: 'persisted', appended: false, result: state(existing[0]) };
    }
    if (
      (active
        ? validateActiveSource(normalized.charter, detachedRow, normalized.binding)
        : validateNegativeRecoverySource(normalized.charter, detachedRow, normalized.binding)) !==
      proof
    )
      throw new Error('Claim changed before result publication');
    append(normalized.binding, 'append_result', detachedRow, snapshot.appendState);
    return { status: 'persisted', appended: true, result: state(detachedRow) };
  });
}
/** Body-free status projection only; no referenced protected artifact or approval is followed. */
export function readConfidentialDotResultState(
  charter: DotCharter,
  options: Options = {}
): ConfidentialDotResultState[] {
  const normalized = normalize(charter, options);
  return projected(raw(normalized.binding).records, normalized.binding.scope)
    .filter((row) => row.dot_id === normalized.charter.dot_id)
    .map(state);
}
export function appendConfidentialDotReportMarker(
  charter: DotCharter,
  marker: DotReportMarker,
  permit: unknown,
  options: Options = {}
): ConfidentialDotResultWrite {
  const normalized = normalize(charter, options),
    receipt = parseDotReportMarker(marker);
  if (
    receipt.dot_id !== normalized.charter.dot_id ||
    dotResultHash(receipt.scope) !== dotResultHash(normalized.binding.scope) ||
    Date.parse(receipt.report_enqueued_at) > Date.now()
  )
    throw new Error('Report DOT scope differs');
  consumeDotReportMarkerPermit(permit, {
    rootDir: normalized.binding.rootDir,
    charter: normalized.charter,
    scope: normalized.binding.scope,
    marker: receipt,
  });
  return withLockSync(lock(normalized.binding), () => {
    const snapshot = raw(normalized.binding),
      records = snapshot.records,
      rows = projected(records, normalized.binding.scope);
    const original = rows.find(
      (row) => dotResultDigest(row) === receipt.result_digest && row.dot_id === receipt.dot_id
    );
    if (!original || executorReportKey(original, receipt.report_to_dot_id) !== receipt.report_key)
      throw new Error('Original report result missing');
    if (original.report_enqueued_at) {
      if (
        original.report_suppressed !== receipt.report_suppressed ||
        Date.parse(receipt.report_enqueued_at) < Date.parse(original.completed_at)
      )
        throw new Error('Existing report suppression or candidate receipt differs');
      projected(
        [...records, { ...receipt, report_enqueued_at: original.report_enqueued_at }],
        normalized.binding.scope
      );
      return { status: 'persisted', appended: false, result: state(original) };
    }
    const updated = projected([...records, receipt], normalized.binding.scope).find(
      (row) => dotResultDigest(row) === receipt.result_digest
    )!;
    append(normalized.binding, 'append_report_marker', receipt, snapshot.appendState);
    return { status: 'persisted', appended: true, result: state(updated) };
  });
}
