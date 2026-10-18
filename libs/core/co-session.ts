/**
 * co-session.ts — same-checkout multi-provider coordination (mission-optional).
 *
 * Local coordination face aligned with work-coordination / Mesh vocabulary.
 * Does not replace peer messaging (transport) or mission ownership (.git).
 *
 * @see knowledge/product/architecture/co-session-coordination.md
 */
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  appendJsonLine,
  readJsonLines,
  writeJson as foundationWriteJson,
  readJsonIfPresent,
} from './foundation/json.js';
import { nowIso } from './foundation/time.js';
import { withLockSync } from './foundation/lock-utils.js';
import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';

export const CO_SESSION_HANDOFF_KINDS = [
  'review.request',
  'workitem.claim',
  'workitem.handoff',
  'workitem.status_update',
  'notification.publish',
] as const;

export type CoSessionHandoffKind = (typeof CO_SESSION_HANDOFF_KINDS)[number];

export const CO_SESSION_PROVIDERS = [
  'claude',
  'cursor',
  'codex',
  'agy',
  'grok',
  'gemini',
  'copilot',
  'opencode',
  'other',
] as const;

export type CoSessionProvider = (typeof CO_SESSION_PROVIDERS)[number];

export type CoSessionStatus = 'open' | 'closed';

export interface CoSessionRecord {
  version: 1;
  session_id: string;
  goal: string;
  status: CoSessionStatus;
  checkout_root: string;
  created_at: string;
  created_by: CoSessionProvider;
  closed_at?: string;
}

export interface CoSessionPresence {
  provider: CoSessionProvider;
  participant_id: string;
  seen_at: string;
  pid?: number;
  note?: string;
}

export type CoSessionLeaseStatus = 'active' | 'released' | 'expired';

export interface CoSessionPathLease {
  lease_id: string;
  session_id: string;
  path: string;
  path_hash: string;
  holder_provider: CoSessionProvider;
  holder_participant_id: string;
  purpose: string;
  status: CoSessionLeaseStatus;
  created_at: string;
  expires_at: string;
  renewed_at: string;
  released_at?: string;
}

export interface CoSessionHandoff {
  handoff_id: string;
  session_id: string;
  kind: CoSessionHandoffKind;
  from_provider: CoSessionProvider;
  from_participant_id?: string;
  to_provider?: CoSessionProvider;
  to_participant_id?: string;
  subject?: string;
  body: string;
  created_at: string;
  acked_at?: string;
  acked_by?: CoSessionProvider;
  acked_by_participant_id?: string;
}

export type CoSessionEventType =
  | 'session_started'
  | 'session_joined'
  | 'session_left'
  | 'heartbeat'
  | 'blackboard_appended'
  | 'lease_acquired'
  | 'lease_released'
  | 'lease_expired'
  | 'handoff_created'
  | 'handoff_acked'
  | 'session_closed';

export interface CoSessionEvent {
  event_id: string;
  session_id: string;
  type: CoSessionEventType;
  at: string;
  actor_provider?: CoSessionProvider;
  detail?: Record<string, unknown>;
}

export class CoSessionError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'CoSessionError';
  }
}

const RUNTIME_ROOT = 'active/shared/runtime/co-sessions';
const OBS_ROOT = 'active/shared/observability/co-sessions';
export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_PRESENCE_STALE_MS = 5 * 60 * 1000;

let namespaceOverride: string | undefined;

export function setCoSessionNamespace(namespace: string): void {
  const trimmed = namespace.trim();
  if (!trimmed || trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new CoSessionError('invalid_namespace', 'invalid co-session namespace');
  }
  namespaceOverride = trimmed;
}

export function clearCoSessionNamespace(): void {
  namespaceOverride = undefined;
}

function namespaced(base: string): string {
  return namespaceOverride ? `${base}/${namespaceOverride}` : base;
}

function runtimeRoot(): string {
  return pathResolver.rootResolve(namespaced(RUNTIME_ROOT));
}

function obsRoot(): string {
  return pathResolver.rootResolve(namespaced(OBS_ROOT));
}

function sessionDir(sessionId: string): string {
  return path.join(runtimeRoot(), sessionId);
}

function sessionFile(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'session.json');
}

function presenceFile(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'presence.jsonl');
}

function blackboardFile(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'blackboard.md');
}

function leasesDir(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'leases');
}

function handoffsFile(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'handoffs.jsonl');
}

function eventsFile(sessionId: string): string {
  return path.join(obsRoot(), sessionId, 'events.jsonl');
}

function currentPointerFile(): string {
  return path.join(runtimeRoot(), 'CURRENT');
}

function assertProvider(value: string): CoSessionProvider {
  if ((CO_SESSION_PROVIDERS as readonly string[]).includes(value)) {
    return value as CoSessionProvider;
  }
  throw new CoSessionError('invalid_provider', `unknown provider: ${value}`);
}

function assertHandoffKind(value: string): CoSessionHandoffKind {
  if ((CO_SESSION_HANDOFF_KINDS as readonly string[]).includes(value)) {
    return value as CoSessionHandoffKind;
  }
  throw new CoSessionError(
    'invalid_kind',
    `unknown handoff kind: ${value} (allowed: ${CO_SESSION_HANDOFF_KINDS.join(', ')})`
  );
}

export function normalizeCoSessionPath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new CoSessionError('invalid_path', 'path is required');
  const relative = pathResolver.toRepoRelative(trimmed).replaceAll('\\', '/');
  if (!relative || path.isAbsolute(relative) || /^[A-Za-z]:\//u.test(relative)) {
    throw new CoSessionError('invalid_path', `path must be inside the repository: ${inputPath}`);
  }
  if (relative.split('/').includes('..')) {
    throw new CoSessionError('invalid_path', `path must not contain ..: ${inputPath}`);
  }
  return relative;
}

export function pathHashForLease(repoRelativePath: string): string {
  return createHash('sha256').update(repoRelativePath).digest('hex').slice(0, 24);
}

function withCoSessionWrite<T>(fn: () => T): T {
  return withExecutionContext('infrastructure_sentinel', fn);
}

function writeJson(filePath: string, value: unknown): void {
  withCoSessionWrite(() => {
    foundationWriteJson(filePath, value);
  });
}

function appendJsonl(filePath: string, record: unknown): void {
  withCoSessionWrite(() => {
    safeMkdir(path.dirname(filePath), { recursive: true });
    appendJsonLine(assertSafeRepositoryPath(filePath, { allowMissingLeaf: true }), record);
  });
}

function appendEvent(
  sessionId: string,
  type: CoSessionEventType,
  actor?: CoSessionProvider,
  detail?: Record<string, unknown>
): void {
  const event: CoSessionEvent = {
    event_id: `cse-${randomUUID()}`,
    session_id: sessionId,
    type,
    at: nowIso(),
    ...(actor ? { actor_provider: actor } : {}),
    ...(detail ? { detail } : {}),
  };
  appendJsonl(eventsFile(sessionId), event);
}

function readSession(sessionId: string): CoSessionRecord {
  const file = sessionFile(sessionId);
  if (!safeExistsSync(file)) {
    throw new CoSessionError('not_found', `co-session not found: ${sessionId}`);
  }
  const record = readJsonIfPresent<CoSessionRecord>(file);
  if (!record) throw new CoSessionError('not_found', `co-session unreadable: ${sessionId}`);
  return record;
}

function writeSession(record: CoSessionRecord): void {
  withCoSessionWrite(() => {
    safeMkdir(sessionDir(record.session_id), { recursive: true });
    writeJson(sessionFile(record.session_id), record);
  });
}

function setCurrentSessionId(sessionId: string): void {
  withCoSessionWrite(() => {
    safeMkdir(runtimeRoot(), { recursive: true });
    safeWriteFile(currentPointerFile(), `${sessionId}\n`, { encoding: 'utf8' });
  });
}

export function getCurrentCoSessionId(): string | undefined {
  const file = currentPointerFile();
  if (!safeExistsSync(file)) return undefined;
  const text = String(safeReadFile(file, { encoding: 'utf8' })).trim();
  return text || undefined;
}

export function resolveCoSessionId(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const current = getCurrentCoSessionId();
  if (current) return current;
  throw new CoSessionError(
    'no_session',
    'no sticky co-session; pass --session-id or run co-session start'
  );
}

export function startCoSession(input: {
  goal: string;
  provider: string;
  session_id?: string;
  sticky?: boolean;
}): CoSessionRecord {
  const provider = assertProvider(input.provider);
  const goal = input.goal.trim();
  if (!goal) throw new CoSessionError('invalid_goal', 'goal is required');
  const session_id = input.session_id?.trim() || `cos-${randomUUID()}`;
  if (safeExistsSync(sessionFile(session_id))) {
    throw new CoSessionError('already_exists', `co-session already exists: ${session_id}`);
  }
  const rootRel = pathResolver.toRepoRelative(pathResolver.rootDir()).replaceAll('\\', '/');
  const record: CoSessionRecord = {
    version: 1,
    session_id,
    goal,
    status: 'open',
    checkout_root:
      !rootRel || path.isAbsolute(rootRel) || /^[A-Za-z]:\//u.test(rootRel) ? '.' : rootRel,
    created_at: nowIso(),
    created_by: provider,
  };
  writeSession(record);
  withCoSessionWrite(() => {
    safeWriteFile(blackboardFile(session_id), `# Co-session blackboard\n\nGoal: ${goal}\n\n`, {
      encoding: 'utf8',
      mkdir: true,
    });
    safeMkdir(leasesDir(session_id), { recursive: true });
  });
  joinCoSession({ session_id, provider });
  if (input.sticky !== false) setCurrentSessionId(session_id);
  appendEvent(session_id, 'session_started', provider, { goal });
  return record;
}

function writePresence(input: {
  session_id: string;
  provider: CoSessionProvider;
  note?: string;
  participant_id?: string;
}): CoSessionPresence {
  const presence: CoSessionPresence = {
    provider: input.provider,
    participant_id: input.participant_id?.trim() || `${input.provider}-${process.pid}`,
    seen_at: nowIso(),
    pid: process.pid,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
  };
  appendJsonl(presenceFile(input.session_id), presence);
  return presence;
}

export function joinCoSession(input: {
  provider: string;
  session_id?: string;
  note?: string;
  participant_id?: string;
}): CoSessionPresence {
  const provider = assertProvider(input.provider);
  const session_id = resolveCoSessionId(input.session_id);
  const session = readSession(session_id);
  if (session.status !== 'open') {
    throw new CoSessionError('closed', `co-session is closed: ${session_id}`);
  }
  const presence = writePresence({
    session_id,
    provider,
    note: input.note,
    participant_id: input.participant_id,
  });
  appendEvent(session_id, 'session_joined', provider, {
    participant_id: presence.participant_id,
  });
  return presence;
}

export function heartbeatCoSession(input: {
  provider: string;
  session_id?: string;
  note?: string;
  participant_id?: string;
}): CoSessionPresence {
  const provider = assertProvider(input.provider);
  const session_id = resolveCoSessionId(input.session_id);
  const session = readSession(session_id);
  if (session.status !== 'open') {
    throw new CoSessionError('closed', `co-session is closed: ${session_id}`);
  }
  const presence = writePresence({
    session_id,
    provider,
    note: input.note,
    participant_id: input.participant_id,
  });
  appendEvent(session_id, 'heartbeat', provider);
  return presence;
}

export function listCoSessionPresence(
  sessionId?: string,
  opts: { staleMs?: number } = {}
): CoSessionPresence[] {
  const session_id = resolveCoSessionId(sessionId);
  readSession(session_id);
  const staleMs = opts.staleMs ?? DEFAULT_PRESENCE_STALE_MS;
  const rows = readJsonLines<CoSessionPresence>(
    assertSafeRepositoryPath(presenceFile(session_id), { allowMissingLeaf: true })
  );
  const latest = new Map<string, CoSessionPresence>();
  for (const row of rows) {
    const key = `${row.provider}:${row.participant_id}`;
    latest.set(key, row);
  }
  const cutoff = Date.now() - staleMs;
  return [...latest.values()].filter((row) => Date.parse(row.seen_at) >= cutoff);
}

export function leaveCoSession(input: {
  provider: string;
  session_id?: string;
  participant_id?: string;
}): { released_leases: number } {
  const provider = assertProvider(input.provider);
  const session_id = resolveCoSessionId(input.session_id);
  readSession(session_id);
  const participant_id = input.participant_id?.trim() || `${provider}-${process.pid}`;
  let released = 0;
  for (const lease of listCoSessionLeases(session_id)) {
    if (
      lease.status === 'active' &&
      lease.holder_provider === provider &&
      lease.holder_participant_id === participant_id
    ) {
      try {
        releaseCoSessionLease({
          session_id,
          path: lease.path,
          provider,
          participant_id,
        });
        released += 1;
      } catch (error) {
        // A vanished or re-held lease must not strand the remaining releases
        // or suppress the leave event — a lease whose holder changed is no
        // longer this participant's to release.
        if (
          error instanceof CoSessionError &&
          (error.code === 'not_found' || error.code === 'lease_held')
        ) {
          continue;
        }
        throw error;
      }
    }
  }
  // Emit the event only when there is something to report — on closed
  // sessions or for participants that never joined, session_left is noise
  // (SessionEnd hooks fire this for every provider session). Re-read the
  // session after the loop: it may have closed mid-release.
  if (readSession(session_id).status === 'closed') return { released_leases: released };
  const joined = listCoSessionPresence(session_id, { staleMs: Number.MAX_SAFE_INTEGER }).some(
    (row) => row.provider === provider && row.participant_id === participant_id
  );
  if (released > 0 || joined) {
    appendEvent(session_id, 'session_left', provider, {
      participant_id,
      released_leases: released,
    });
  }
  return { released_leases: released };
}

export function closeCoSession(input: { session_id?: string; provider: string }): CoSessionRecord {
  const provider = assertProvider(input.provider);
  const session_id = resolveCoSessionId(input.session_id);
  const session = readSession(session_id);
  const sweepLeases = () => {
    for (const lease of listCoSessionLeases(session_id)) {
      if (lease.status === 'active') {
        try {
          releaseCoSessionLease({
            session_id,
            path: lease.path,
            provider: lease.holder_provider,
            participant_id: lease.holder_participant_id,
            force: true,
          });
        } catch (error) {
          // A lease that vanished (self-deleted by a losing acquirer) or
          // changed hands must not strand the remaining releases — and the
          // sweep must remain retryable after a partial failure.
          if (
            error instanceof CoSessionError &&
            (error.code === 'not_found' || error.code === 'lease_held')
          ) {
            continue;
          }
          throw error;
        }
      }
    }
  };
  const alreadyClosed = session.status === 'closed';
  const record: CoSessionRecord = alreadyClosed
    ? session
    : { ...session, status: 'closed', closed_at: nowIso() };
  const cleanupCurrent = () => {
    const current = getCurrentCoSessionId();
    if (current === session_id && safeExistsSync(currentPointerFile())) {
      withCoSessionWrite(() => safeRmSync(currentPointerFile()));
    }
  };
  if (alreadyClosed) {
    // Still sweep: a prior close may have died mid-loop — retry is the only
    // path to finish the cleanup (leases + CURRENT pointer).
    sweepLeases();
    cleanupCurrent();
    return record;
  }
  // Flip to closed BEFORE releasing leases: an acquire that slips between
  // release-enumeration and the status write would otherwise leave an active
  // lease behind (acquire re-checks status inside the path lock). The
  // transition event is journaled before the fallible sweep so a retry that
  // only finishes cleanup does not lose it.
  writeSession(record);
  appendEvent(session_id, 'session_closed', provider);
  sweepLeases();
  cleanupCurrent();
  return record;
}

export function readCoSessionBlackboard(sessionId?: string): string {
  const session_id = resolveCoSessionId(sessionId);
  readSession(session_id);
  const file = blackboardFile(session_id);
  if (!safeExistsSync(file)) return '';
  return String(safeReadFile(file, { encoding: 'utf8' }));
}

export function appendCoSessionBlackboard(input: {
  session_id?: string;
  provider: string;
  text: string;
}): string {
  const provider = assertProvider(input.provider);
  const session_id = resolveCoSessionId(input.session_id);
  readSession(session_id);
  const text = input.text.trim();
  if (!text) throw new CoSessionError('invalid_text', 'blackboard text is required');
  const file = blackboardFile(session_id);
  const block = `\n## ${nowIso()} — ${provider}\n\n${text}\n`;
  // read+rewrite must be serialized: two appends racing on the previous
  // content lose one note.
  withLockSync(`co-session-blackboard:${session_id}`, () => {
    const prev = safeExistsSync(file) ? String(safeReadFile(file, { encoding: 'utf8' })) : '';
    withCoSessionWrite(() => {
      safeWriteFile(file, prev + block, { encoding: 'utf8', mkdir: true });
    });
  });
  appendEvent(session_id, 'blackboard_appended', provider, { chars: text.length });
  return readCoSessionBlackboard(session_id);
}

function leaseFile(sessionId: string, pathHash: string): string {
  return path.join(leasesDir(sessionId), `${pathHash}.json`);
}

/**
 * One inter-process fence per (session, path). The lease read-check-write
 * below was previously unserialized, so two competing processes could both
 * observe "no active lease" and both acquire. Same pattern as
 * work-coordination's `withCoordinationMutation`.
 */
function leaseLockId(sessionId: string, pathHash: string): string {
  return `co-session-lease:${sessionId}:${pathHash}`;
}

/**
 * Pure expiry evaluation — no writes. Readers must not persist state: a
 * lock-free write here could clobber an active lease created between the
 * read and the write. Persisting the flip is hygiene, done separately by
 * `persistLeaseExpiry` under the path lock.
 */
function refreshLeaseStatus(lease: CoSessionPathLease): CoSessionPathLease {
  if (lease.status === 'active' && Date.parse(lease.expires_at) <= Date.now()) {
    return { ...lease, status: 'expired' };
  }
  return lease;
}

/**
 * Persist an expired-status flip under the path lock, re-reading first and
 * skipping when the file no longer matches what the caller observed (a new
 * lease may have been acquired meanwhile). Never called from inside the
 * lease lock — it takes the lock itself.
 */
function persistLeaseExpiry(lease: CoSessionPathLease): void {
  if (lease.status !== 'expired') return;
  let flipped = false;
  try {
    flipped = withLockSync(leaseLockId(lease.session_id, lease.path_hash), () => {
      const onDisk = readJsonIfPresent<CoSessionPathLease>(
        leaseFile(lease.session_id, lease.path_hash)
      );
      // lease_id is preserved across same-holder renewals, so identity alone
      // is not enough — persist only when the on-disk record is still the
      // genuinely expired lease the caller observed.
      if (
        onDisk?.lease_id !== lease.lease_id ||
        onDisk.status !== 'active' ||
        Date.parse(onDisk.expires_at) > Date.now()
      ) {
        return false;
      }
      writeJson(leaseFile(lease.session_id, lease.path_hash), lease);
      return true;
    });
  } catch {
    // Persisting the flip is hygiene — the in-memory refresh already gave
    // callers the correct answer; a contended or failing lock must not crash
    // read/status/cleanup paths.
    return;
  }
  if (flipped) {
    appendEvent(lease.session_id, 'lease_expired', lease.holder_provider, {
      path: lease.path,
      lease_id: lease.lease_id,
    });
  }
}

/**
 * Read a single lease for a repo path — the cheap hot path for hook gates
 * (no dir scan, no presence/handoff reads, no expiry persistence). Returns
 * the refreshed (possibly expired-marked) lease, or undefined.
 */
export function getCoSessionLease(
  sessionId: string | undefined,
  repoPath: string
): { session_status: CoSessionRecord['status']; lease: CoSessionPathLease | undefined } {
  const session_id = resolveCoSessionId(sessionId);
  const session = readSession(session_id);
  const path_hash = pathHashForLease(normalizeCoSessionPath(repoPath));
  const existing = readJsonIfPresent<CoSessionPathLease>(leaseFile(session_id, path_hash));
  return {
    session_status: session.status,
    lease: existing ? refreshLeaseStatus(existing) : undefined,
  };
}

export function listCoSessionLeases(sessionId?: string): CoSessionPathLease[] {
  const session_id = resolveCoSessionId(sessionId);
  readSession(session_id);
  const dir = leasesDir(session_id);
  if (!safeExistsSync(dir)) return [];
  const files = safeReaddir(dir).filter((name) => name.endsWith('.json'));
  return files
    .map((name) => readJsonIfPresent<CoSessionPathLease>(path.join(dir, name)))
    .filter((row): row is CoSessionPathLease => Boolean(row))
    .map((lease) => {
      const refreshed = refreshLeaseStatus(lease);
      if (refreshed.status === 'expired' && refreshed.status !== lease.status) {
        persistLeaseExpiry(refreshed);
      }
      return refreshed;
    });
}

export function acquireCoSessionLease(input: {
  session_id?: string;
  provider: string;
  path: string;
  purpose?: string;
  ttl_ms?: number;
  participant_id?: string;
}): CoSessionPathLease {
  const provider = assertProvider(input.provider);
  const session_id = resolveCoSessionId(input.session_id);
  const session = readSession(session_id);
  if (session.status !== 'open') {
    throw new CoSessionError('closed', `co-session is closed: ${session_id}`);
  }
  const repoPath = normalizeCoSessionPath(input.path);
  const path_hash = pathHashForLease(repoPath);
  const participant_id = input.participant_id?.trim() || `${provider}-${process.pid}`;
  let displacedLease: CoSessionPathLease | undefined;
  const lease = withLockSync(leaseLockId(session_id, path_hash), () => {
    // closeCoSession flips the session to closed BEFORE releasing leases, so
    // re-checking inside the per-path lock closes the acquire-vs-close race.
    if (readSession(session_id).status !== 'open') {
      throw new CoSessionError('closed', `co-session is closed: ${session_id}`);
    }
    const existing = readJsonIfPresent<CoSessionPathLease>(leaseFile(session_id, path_hash));
    const current = existing ? refreshLeaseStatus(existing) : undefined;
    if (existing?.status === 'active' && current?.status === 'expired') {
      displacedLease = current;
    }
    if (
      current?.status === 'active' &&
      !(current.holder_provider === provider && current.holder_participant_id === participant_id)
    ) {
      throw new CoSessionError(
        'lease_held',
        `path leased by ${current.holder_provider}/${current.holder_participant_id} until ${current.expires_at}`
      );
    }
    const now = nowIso();
    const ttl = input.ttl_ms ?? DEFAULT_LEASE_TTL_MS;
    const next: CoSessionPathLease = {
      lease_id: current?.lease_id || `csl-${randomUUID()}`,
      session_id,
      path: repoPath,
      path_hash,
      holder_provider: provider,
      holder_participant_id: participant_id,
      purpose: input.purpose?.trim() || 'implementation',
      status: 'active',
      created_at: current?.created_at || now,
      expires_at: new Date(Date.now() + ttl).toISOString(),
      renewed_at: now,
    };
    withCoSessionWrite(() => {
      safeMkdir(leasesDir(session_id), { recursive: true });
      writeJson(leaseFile(session_id, path_hash), next);
    });
    // Post-write re-check: a close that flipped the session after our earlier
    // check enumerated leases before our write — self-delete so no active
    // lease survives on a closed session.
    if (readSession(session_id).status !== 'open') {
      withCoSessionWrite(() => safeRmSync(leaseFile(session_id, path_hash)));
      throw new CoSessionError('closed', `co-session is closed: ${session_id}`);
    }
    return next;
  });
  appendEvent(session_id, 'lease_acquired', provider, {
    path: repoPath,
    lease_id: lease.lease_id,
    expires_at: lease.expires_at,
  });
  if (displacedLease) {
    appendEvent(session_id, 'lease_expired', displacedLease.holder_provider, {
      path: repoPath,
      lease_id: displacedLease.lease_id,
    });
  }
  return lease;
}

export function releaseCoSessionLease(input: {
  session_id?: string;
  provider: string;
  path: string;
  participant_id?: string;
  force?: boolean;
}): CoSessionPathLease {
  const provider = assertProvider(input.provider);
  const session_id = resolveCoSessionId(input.session_id);
  readSession(session_id);
  const repoPath = normalizeCoSessionPath(input.path);
  const path_hash = pathHashForLease(repoPath);
  const participant_id = input.participant_id?.trim() || `${provider}-${process.pid}`;
  const released = withLockSync(leaseLockId(session_id, path_hash), () => {
    const existing = readJsonIfPresent<CoSessionPathLease>(leaseFile(session_id, path_hash));
    if (!existing) throw new CoSessionError('not_found', `no lease for path: ${repoPath}`);
    const current = refreshLeaseStatus(existing);
    if (
      !input.force &&
      current.status === 'active' &&
      (current.holder_provider !== provider || current.holder_participant_id !== participant_id)
    ) {
      throw new CoSessionError(
        'lease_held',
        `cannot release lease held by ${current.holder_provider}/${current.holder_participant_id}`
      );
    }
    const next: CoSessionPathLease = {
      ...current,
      status: 'released',
      released_at: nowIso(),
    };
    writeJson(leaseFile(session_id, path_hash), next);
    return next;
  });
  appendEvent(session_id, 'lease_released', provider, {
    path: repoPath,
    lease_id: released.lease_id,
  });
  return released;
}

export function createCoSessionHandoff(input: {
  session_id?: string;
  kind: string;
  from_provider: string;
  from_participant_id?: string;
  to_provider?: string;
  to_participant_id?: string;
  subject?: string;
  body: string;
}): CoSessionHandoff {
  const from_provider = assertProvider(input.from_provider);
  const kind = assertHandoffKind(input.kind);
  const session_id = resolveCoSessionId(input.session_id);
  readSession(session_id);
  const body = input.body.trim();
  if (!body) throw new CoSessionError('invalid_body', 'handoff body is required');
  const from_participant_id =
    input.from_participant_id?.trim() || `${from_provider}-${process.pid}`;
  const to_provider = input.to_provider ? assertProvider(input.to_provider) : undefined;
  const to_participant_id = input.to_participant_id?.trim() || undefined;
  if (to_participant_id && to_provider) {
    const live = listCoSessionPresence(session_id);
    const match = live.find((row) => row.participant_id === to_participant_id);
    if (match && match.provider !== to_provider) {
      throw new CoSessionError(
        'participant_mismatch',
        `to_participant_id ${to_participant_id} is provider ${match.provider}, not ${to_provider}`
      );
    }
  }
  const handoff: CoSessionHandoff = {
    handoff_id: `csh-${randomUUID()}`,
    session_id,
    kind,
    from_provider,
    from_participant_id,
    ...(to_provider ? { to_provider } : {}),
    ...(to_participant_id ? { to_participant_id } : {}),
    ...(input.subject?.trim() ? { subject: input.subject.trim() } : {}),
    body,
    created_at: nowIso(),
  };
  // Same fence as ack: an unprotected append landing between ack's
  // read and rewrite would be silently deleted.
  withLockSync(handoffsLockId(session_id), () => {
    appendJsonl(handoffsFile(session_id), handoff);
  });
  appendEvent(session_id, 'handoff_created', from_provider, {
    handoff_id: handoff.handoff_id,
    kind,
    to_provider: handoff.to_provider,
    to_participant_id: handoff.to_participant_id,
    from_participant_id: handoff.from_participant_id,
  });
  return handoff;
}

export function listCoSessionHandoffs(
  sessionId?: string,
  opts: {
    pendingOnly?: boolean;
    to_provider?: string;
    to_participant_id?: string;
  } = {}
): CoSessionHandoff[] {
  const session_id = resolveCoSessionId(sessionId);
  readSession(session_id);
  let rows = readJsonLines<CoSessionHandoff>(
    assertSafeRepositoryPath(handoffsFile(session_id), { allowMissingLeaf: true })
  );
  if (opts.pendingOnly) rows = rows.filter((row) => !row.acked_at);
  if (opts.to_participant_id?.trim()) {
    const target = opts.to_participant_id.trim();
    const provider = opts.to_provider ? assertProvider(opts.to_provider) : undefined;
    rows = rows.filter((row) => {
      if (provider) {
        // Ack-able only — mirrors ackCoSessionHandoff's targeting rules.
        return coSessionHandoffTargets(row, provider, target);
      }
      // No provider context: exact participant match plus unaddressed
      // broadcasts (ack-able by anyone).
      return row.to_participant_id === target || (!row.to_provider && !row.to_participant_id);
    });
  } else if (opts.to_provider) {
    const provider = assertProvider(opts.to_provider);
    rows = rows.filter(
      (row) => row.to_provider === provider || (!row.to_provider && !row.to_participant_id)
    );
  }
  return rows;
}

/**
 * Whether a handoff can be delivered AND acked by <provider>/<participant_id>
 * — mirrors ackCoSessionHandoff's targeting rules: a participant-targeted
 * handoff addressed to a different provider is invisible, a provider-targeted
 * handoff is visible to every participant of that provider, and a handoff
 * with no addressing is a broadcast.
 */
export function coSessionHandoffTargets(
  handoff: Pick<CoSessionHandoff, 'to_provider' | 'to_participant_id'>,
  provider: string,
  participant_id: string
): boolean {
  return (
    (handoff.to_participant_id === participant_id &&
      (!handoff.to_provider || handoff.to_provider === provider)) ||
    (!handoff.to_participant_id && handoff.to_provider === provider) ||
    (!handoff.to_provider && !handoff.to_participant_id)
  );
}

/** Per-session fence for handoffs.jsonl — the file is read-modify-rewritten
 * on ack, so create and ack must share one lock to avoid lost appends and
 * reverted acks. */
function handoffsLockId(sessionId: string): string {
  return `co-session-handoffs:${sessionId}`;
}

export function ackCoSessionHandoff(input: {
  session_id?: string;
  handoff_id: string;
  provider: string;
  participant_id?: string;
}): CoSessionHandoff {
  const provider = assertProvider(input.provider);
  const session_id = resolveCoSessionId(input.session_id);
  readSession(session_id);
  const participant_id = input.participant_id?.trim() || `${provider}-${process.pid}`;
  let freshlyAcked = false;
  const acked = withLockSync(handoffsLockId(session_id), () => {
    // Read inside the lock — a row appended between an outside read and the
    // rewrite would be silently deleted.
    const rows = listCoSessionHandoffs(session_id);
    const index = rows.findIndex((row) => row.handoff_id === input.handoff_id);
    if (index < 0) throw new CoSessionError('not_found', `handoff not found: ${input.handoff_id}`);
    const current = rows[index]!;
    if (current.acked_at) return current;
    if (current.to_participant_id && current.to_participant_id !== participant_id) {
      throw new CoSessionError(
        'handoff_not_for_participant',
        `handoff is addressed to ${current.to_participant_id}, not ${participant_id}`
      );
    }
    if (current.to_provider && current.to_provider !== provider) {
      throw new CoSessionError(
        'handoff_not_for_provider',
        `handoff is addressed to provider ${current.to_provider}, not ${provider}`
      );
    }
    freshlyAcked = true;
    const next: CoSessionHandoff = {
      ...current,
      acked_at: nowIso(),
      acked_by: provider,
      acked_by_participant_id: participant_id,
    };
    // Rewrite handoffs file deterministically (small local log).
    const file = handoffsFile(session_id);
    withCoSessionWrite(() => {
      if (safeExistsSync(file)) safeRmSync(file);
      for (const row of rows.map((row, i) => (i === index ? next : row))) {
        appendJsonLine(assertSafeRepositoryPath(file, { allowMissingLeaf: true }), row);
      }
    });
    return next;
  });
  if (freshlyAcked) {
    appendEvent(session_id, 'handoff_acked', provider, {
      handoff_id: acked.handoff_id,
      participant_id,
    });
  }
  return acked;
}

export function getCoSessionStatus(sessionId?: string): {
  session: CoSessionRecord;
  presence: CoSessionPresence[];
  leases: CoSessionPathLease[];
  pending_handoffs: CoSessionHandoff[];
  sticky: boolean;
} {
  const session_id = resolveCoSessionId(sessionId);
  const session = readSession(session_id);
  return {
    session,
    presence: listCoSessionPresence(session_id),
    leases: listCoSessionLeases(session_id).filter((lease) => lease.status === 'active'),
    pending_handoffs: listCoSessionHandoffs(session_id, { pendingOnly: true }),
    sticky: getCurrentCoSessionId() === session_id,
  };
}

export function clearCoSessionStore(): void {
  withCoSessionWrite(() => {
    const runtime = runtimeRoot();
    const obs = obsRoot();
    if (safeExistsSync(runtime)) safeRmSync(runtime, { recursive: true, force: true });
    if (safeExistsSync(obs)) safeRmSync(obs, { recursive: true, force: true });
  });
}

/** Hook delivery receipts are not acknowledgements. Serialize across short-lived
 * hook processes and retain only pending ids so repeated tool events stay quiet. */
export function takeUnseenCoSessionHandoffs(
  sessionId: string,
  participantId: string,
  readPending: () => CoSessionHandoff[],
  limit = 10
): CoSessionHandoff[] {
  const session = readSession(sessionId);
  if (session.status !== 'open') return [];
  const key = createHash('sha256').update(participantId).digest('hex');
  const file = path.join(sessionDir(sessionId), 'hook-deliveries', `${key}.json`);
  return withLockSync(`co-session-delivery:${sessionId}:${key}`, () => {
    // Read inside the receipt lock: a stale pre-lock snapshot could erase a
    // newer delivery receipt and make a later hook echo that message again.
    const pending = readPending();
    const previous = readJsonIfPresent<unknown>(file);
    const seen = new Set(
      Array.isArray(previous) ? previous.filter((id) => typeof id === 'string') : []
    );
    const fresh = pending.filter((h) => !seen.has(h.handoff_id)).slice(0, limit);
    for (const handoff of fresh) seen.add(handoff.handoff_id);
    if (fresh.length) {
      withCoSessionWrite(() => safeMkdir(path.dirname(file), { recursive: true }));
      writeJson(
        file,
        pending.filter((h) => seen.has(h.handoff_id)).map((h) => h.handoff_id)
      );
    }
    return fresh;
  });
}

export function buildCoSessionPromoteHint(sessionId?: string): {
  session_id: string;
  peer_lift: string;
  mission_lift: string;
  note: string;
} {
  const session_id = resolveCoSessionId(sessionId);
  const session = readSession(session_id);
  return {
    session_id,
    peer_lift:
      'Lift handoffs via peer messaging / Mesh Hub using the same kind (review.request, workitem.handoff, …). Recipient must explicitly accept; do not auto-start a mission.',
    mission_lift: `When git ownership or customer evidence is required: pnpm exec tsx scripts/mission_controller.ts create <ID> --tier public --goal ${JSON.stringify(session.goal)}`,
    note: 'co-session never writes .git; peer ACK is transport-only; mission remains the authority for commits and approvals.',
  };
}
