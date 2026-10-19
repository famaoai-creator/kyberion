import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { isValidTenantSlug } from '../entity-scope.js';
import { safeLstat, safePublishExclusiveFileSync, safeReadFileSnapshot } from '../secure-io.js';
import { nowIso } from '../foundation/time.js';
import { withDiscussionRequestReceiptAccess } from './discussion-request-storage-scope.js';
import {
  createReservedDiscussionRoom,
  DiscussionUserError,
  normalizeDiscussionConfig,
  readDiscussionRequestRoom,
} from './discussion-store.js';
import type {
  DiscussionConfig,
  DiscussionRequestBinding,
  DiscussionRoomState,
  DiscussionScope,
} from './discussion-types.js';

export interface DiscussionRequestActor {
  principal_id: string;
  source: 'token' | 'loopback';
  member_id?: string;
}

export interface DiscussionRequestIdentity {
  request_id: string;
  /** Authenticated server identity, never a body-provided actor. */
  actor: DiscussionRequestActor;
  /** The caller authorizes the complete scope; receipt access never authorizes room/provider work. */
  scope: DiscussionScope;
}

export interface CreateDiscussionRequestInput extends DiscussionRequestIdentity {
  input: { goal: string; title?: string; config?: Partial<DiscussionConfig> };
  /** Static readiness only; this never records a provider failure as a rejection. */
  rejection?: 'prerequisites_blocked';
}

export interface DiscussionRequestResult {
  request: {
    request_id: string;
    status: 'created' | 'rejected' | 'unconfirmed';
    room_id?: string;
    reason?: string;
  };
  room?: DiscussionRoomState;
  /** Only the original reservation winner can receive this once, after verified commit. */
  should_start: boolean;
}

export class DiscussionRequestConflictError extends DiscussionUserError {
  constructor() {
    super('This discussion request ID is already bound to a different intent');
    this.name = 'DiscussionRequestConflictError';
  }
}

type CanonicalScope = DiscussionScope & { tier: 'confidential'; tenant_slug: string };
interface Intent {
  goal: string;
  title: string;
  config: DiscussionConfig;
  actor: DiscussionRequestActor;
  scope: CanonicalScope;
}
interface Namespace extends Omit<DiscussionRequestBinding, 'intent_sha256'> {
  actor: DiscussionRequestActor;
  scope: CanonicalScope;
  room_id: string;
  directory: string;
}
interface Reservation {
  version: 1;
  request_id: string;
  room_id: string;
  actor_sha256: string;
  scope_sha256: string;
  intent_sha256: string;
  actor: DiscussionRequestActor;
  scope: CanonicalScope;
  reserved_at: string;
}
interface Receipt {
  version: 1;
  request_id: string;
  room_id: string;
  actor_sha256: string;
  scope_sha256: string;
  intent_sha256: string;
  status: 'created' | 'rejected';
  reason?: 'prerequisites_blocked';
  committed_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_RECORD_SNAPSHOT_ATTEMPTS = 8;

/** Sort keys recursively so property insertion order never changes semantic identity. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => JSON.stringify(key) + ':' + canonical(entry))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'undefined';
}
function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}
function text(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new DiscussionUserError('Invalid discussion ' + label);
  return value.trim();
}
function normalizeActor(input: DiscussionRequestActor): DiscussionRequestActor {
  if (!input || (input.source !== 'token' && input.source !== 'loopback'))
    throw new DiscussionUserError('Invalid discussion request actor');
  return {
    principal_id: text(input.principal_id, 'principal'),
    source: input.source,
    ...(input.member_id === undefined ? {} : { member_id: text(input.member_id, 'member') }),
  };
}
function normalizeScope(input: DiscussionScope): CanonicalScope {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new DiscussionUserError('Invalid discussion scope');
  if (input.tier !== undefined && input.tier !== 'confidential')
    throw new DiscussionUserError('Discussion requests require confidential scope');
  if (input.tenant_slug === undefined)
    throw new DiscussionUserError('A tenant is required for this discussion request');
  const tenant = text(input.tenant_slug, 'tenant').toLowerCase();
  if (!isValidTenantSlug(tenant)) throw new DiscussionUserError('Invalid discussion tenant');
  const scope: CanonicalScope = { tier: 'confidential', tenant_slug: tenant };
  for (const key of ['organization_id', 'project_id', 'mission_id'] as const)
    if (input[key] !== undefined) scope[key] = text(input[key], key);
  return scope;
}
function namespace(input: DiscussionRequestIdentity): Namespace {
  if (typeof input.request_id !== 'string' || !UUID.test(input.request_id))
    throw new DiscussionUserError('A valid discussion request UUID is required');
  const request_id = input.request_id.toLowerCase();
  const actor = normalizeActor(input.actor);
  const scope = normalizeScope(input.scope);
  const actor_sha256 = digest(actor);
  const scope_sha256 = digest(scope);
  const room_id = 'disc-request-' + digest({ request_id, actor_sha256, scope_sha256 });
  return {
    request_id,
    actor,
    scope,
    actor_sha256,
    scope_sha256,
    room_id,
    directory: path.join(
      pathResolver.shared('runtime/discussion-create-requests'),
      'confidential',
      scope.tenant_slug,
      'by-actor',
      actor_sha256,
      scope_sha256,
      request_id
    ),
  };
}
function normalizeIntent(input: CreateDiscussionRequestInput['input'], ns: Namespace): Intent {
  if (!input || typeof input.goal !== 'string')
    throw new DiscussionUserError('A discussion goal is required');
  const goal = input.goal.trim();
  if (!goal) throw new DiscussionUserError('A discussion goal is required');
  if (goal.length > 2000) throw new DiscussionUserError('Discussion goal is too long');
  if (input.title !== undefined && typeof input.title !== 'string')
    throw new DiscussionUserError('Invalid discussion title');
  return {
    goal,
    title: (input.title?.trim() || goal).slice(0, 120),
    config: normalizeDiscussionConfig(input.config),
    actor: ns.actor,
    scope: ns.scope,
  };
}
function recordPath(ns: Namespace, name: 'reservation' | 'receipt'): string {
  return path.join(ns.directory, name + '.json');
}
function readRecord(ns: Namespace, name: 'reservation' | 'receipt'): unknown | null {
  let bytes: Buffer;
  let observedRecord = false;
  try {
    // Snapshot pins a regular, non-symlink inode and enforces the byte bound.
    bytes = withDiscussionRequestReceiptAccess(
      { directory: ns.directory, scope: ns.scope, write: false },
      () => {
        const file = recordPath(ns, name);
        let pinned: ReturnType<typeof safeLstat> | undefined;
        const verifyLeaf = () => {
          const stat = safeLstat(file);
          observedRecord = true;
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES)
            throw new Error('Invalid discussion request record file');
          if (
            pinned &&
            (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const).some(
              (key) => pinned![key] !== stat[key]
            )
          )
            throw new Error('Discussion request record changed between snapshots');
          pinned ??= stat;
        };
        // Losing exclusive publishers briefly create/remove temporary siblings.
        // Discard a failed snapshot; retry only this known ancestor-instability
        // diagnostic, with the original leaf pinned. Every attempt still runs
        // complete secure-io authorization, no-link and stable-inode checks.
        // No write, parsing failure, policy denial or leaf-change error is retried.
        for (let attempt = 0; attempt < MAX_RECORD_SNAPSHOT_ATTEMPTS; attempt++) {
          verifyLeaf();
          try {
            const snapshot = safeReadFileSnapshot(file, MAX_RECORD_BYTES);
            verifyLeaf();
            return snapshot;
          } catch (error) {
            if (
              !(error instanceof Error) ||
              error.message !== '[SECURITY] Snapshot ancestor changed during read' ||
              attempt + 1 === MAX_RECORD_SNAPSHOT_ATTEMPTS
            )
              throw error;
          }
        }
        throw new Error('Discussion request snapshot attempts exhausted');
      }
    );
  } catch (error) {
    if (!observedRecord && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  // Strict parsing is intentional: missing, empty, torn and corrupt claims are distinct.
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isRecord(value)) throw new Error('Invalid discussion request record');
  return value;
}
function publishRecord(
  ns: Namespace,
  name: 'reservation' | 'receipt',
  value: Reservation | Receipt
): void {
  withDiscussionRequestReceiptAccess(
    { directory: ns.directory, scope: ns.scope, write: true },
    () => safePublishExclusiveFileSync(recordPath(ns, name), JSON.stringify(value) + '\n')
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}
function readReservation(ns: Namespace): Reservation | null {
  const value = readRecord(ns, 'reservation');
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !validTimestamp(value.reserved_at) ||
    typeof value.intent_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.intent_sha256)
  )
    throw new Error('Invalid discussion reservation');
  const expected: Reservation = {
    version: 1,
    request_id: ns.request_id,
    room_id: ns.room_id,
    actor_sha256: ns.actor_sha256,
    scope_sha256: ns.scope_sha256,
    intent_sha256: value.intent_sha256,
    actor: ns.actor,
    scope: ns.scope,
    reserved_at: value.reserved_at,
  };
  if (canonical(value) !== canonical(expected)) throw new Error('Discussion reservation mismatch');
  return expected;
}
function binding(reservation: DiscussionRequestBinding): DiscussionRequestBinding {
  return {
    request_id: reservation.request_id,
    actor_sha256: reservation.actor_sha256,
    scope_sha256: reservation.scope_sha256,
    intent_sha256: reservation.intent_sha256,
  };
}
function readReceipt(ns: Namespace, reservation: Reservation): Receipt | null {
  const value = readRecord(ns, 'receipt');
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !validTimestamp(value.committed_at) ||
    (value.status !== 'created' && value.status !== 'rejected')
  )
    throw new Error('Invalid discussion commitment');
  const expected: Receipt = {
    version: 1,
    ...binding(reservation),
    room_id: ns.room_id,
    status: value.status,
    ...(value.status === 'rejected' ? { reason: 'prerequisites_blocked' as const } : {}),
    committed_at: value.committed_at,
  };
  if (canonical(value) !== canonical(expected)) throw new Error('Discussion commitment mismatch');
  return expected;
}
function unconfirmed(ns: Namespace): DiscussionRequestResult {
  return {
    request: { request_id: ns.request_id, status: 'unconfirmed', reason: 'outcome_unconfirmed' },
    should_start: false,
  };
}
function inspectRoom(ns: Namespace, reservation: Reservation) {
  const evidence = readDiscussionRequestRoom(ns.room_id);
  if (!evidence) return null;
  const event = evidence.created;
  const intent: Intent = {
    goal: event.goal,
    title: event.title,
    config: event.config,
    scope: event.scope as CanonicalScope,
    actor: ns.actor,
  };
  if (
    canonical(event.request_binding) !== canonical(binding(reservation)) ||
    event.created_by !== ns.actor.principal_id ||
    canonical(intent) !== canonical(normalizeIntent(event, ns)) ||
    digest(intent) !== reservation.intent_sha256
  )
    throw new Error('Discussion room creation binding mismatch');
  return evidence.room;
}
function recover(ns: Namespace, reservation: Reservation): DiscussionRequestResult {
  try {
    const receipt = readReceipt(ns, reservation);
    const room = inspectRoom(ns, reservation);
    if (receipt?.status === 'rejected') {
      if (room) return unconfirmed(ns);
      return {
        request: { request_id: ns.request_id, status: 'rejected', reason: 'prerequisites_blocked' },
        should_start: false,
      };
    }
    if (!room) return unconfirmed(ns);
    // Original creation evidence can recover metadata, never provider execution permission.
    return {
      request: { request_id: ns.request_id, status: 'created', room_id: ns.room_id },
      room,
      should_start: false,
    };
  } catch {
    return unconfirmed(ns);
  }
}

/** Read-only, scope-local recovery. No scans, callbacks, room creation, reclaim or engine launch. */
export function recoverDiscussionRequest(
  input: DiscussionRequestIdentity
): DiscussionRequestResult {
  const ns = namespace(input);
  try {
    const reservation = readReservation(ns);
    return reservation ? recover(ns, reservation) : unconfirmed(ns);
  } catch {
    return unconfirmed(ns);
  }
}

/**
 * Permanently reserve before writing a room or rejection. Only a successful
 * exclusive reservation in this invocation can create the predetermined room.
 * There is no TTL/reclaim. An uncertain write can sacrifice liveness, never
 * silently repeat a potentially charged execution. No full power-loss durability
 * is claimed for the separate, subsequently appended room event log.
 */
export function createDiscussionRequest(
  input: CreateDiscussionRequestInput
): DiscussionRequestResult {
  const ns = namespace(input);
  const intent = normalizeIntent(input.input, ns);
  if (input.rejection !== undefined && input.rejection !== 'prerequisites_blocked')
    throw new DiscussionUserError('Invalid discussion rejection');
  let existing: Reservation | null;
  try {
    existing = readReservation(ns);
  } catch {
    return unconfirmed(ns);
  }
  if (existing) {
    if (existing.intent_sha256 !== digest(intent)) throw new DiscussionRequestConflictError();
    return recover(ns, existing);
  }
  const reservation: Reservation = {
    version: 1,
    ...binding({ ...ns, intent_sha256: digest(intent) }),
    room_id: ns.room_id,
    actor: ns.actor,
    scope: ns.scope,
    reserved_at: nowIso(),
  };
  try {
    // A lost reservation must not turn surviving commitment/room state into a new launch.
    if (readRecord(ns, 'receipt') !== null || readDiscussionRequestRoom(ns.room_id))
      return unconfirmed(ns);
    publishRecord(ns, 'reservation', reservation);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      let winner: Reservation | null;
      try {
        winner = readReservation(ns);
      } catch {
        return unconfirmed(ns);
      }
      if (winner && winner.intent_sha256 !== reservation.intent_sha256)
        throw new DiscussionRequestConflictError();
      return winner ? recover(ns, winner) : unconfirmed(ns);
    }
    return unconfirmed(ns);
  }
  try {
    if (canonical(readReservation(ns)) !== canonical(reservation)) return unconfirmed(ns);
    if (readRecord(ns, 'receipt') !== null || readDiscussionRequestRoom(ns.room_id))
      return unconfirmed(ns);
    if (!input.rejection) {
      createReservedDiscussionRoom(
        {
          id: ns.room_id,
          goal: intent.goal,
          title: intent.title,
          config: intent.config,
          scope: intent.scope,
          created_by: ns.actor.principal_id,
        },
        binding(reservation)
      );
      if (!inspectRoom(ns, reservation)) return unconfirmed(ns);
    }
    const receipt: Receipt = {
      version: 1,
      ...binding(reservation),
      room_id: ns.room_id,
      status: input.rejection ? 'rejected' : 'created',
      ...(input.rejection ? { reason: input.rejection } : {}),
      committed_at: nowIso(),
    };
    publishRecord(ns, 'receipt', receipt);
    if (canonical(readReceipt(ns, reservation)) !== canonical(receipt)) return unconfirmed(ns);
    const result = recover(ns, reservation);
    return { ...result, should_start: !input.rejection && result.request.status === 'created' };
  } catch {
    // Even EEXIST/partial failure is uncertain here; duplicates can only recover metadata.
    return unconfirmed(ns);
  }
}
