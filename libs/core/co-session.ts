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
      releaseCoSessionLease({
        session_id,
        path: lease.path,
        provider,
        participant_id,
      });
      released += 1;
    }
  }
  appendEvent(session_id, 'session_left', provider, { participant_id, released_leases: released });
  return { released_leases: released };
}

export function closeCoSession(input: { session_id?: string; provider: string }): CoSessionRecord {
  const provider = assertProvider(input.provider);
  const session_id = resolveCoSessionId(input.session_id);
  const session = readSession(session_id);
  if (session.status === 'closed') return session;
  for (const lease of listCoSessionLeases(session_id)) {
    if (lease.status === 'active') {
      releaseCoSessionLease({
        session_id,
        path: lease.path,
        provider: lease.holder_provider,
        participant_id: lease.holder_participant_id,
        force: true,
      });
    }
  }
  const closed: CoSessionRecord = { ...session, status: 'closed', closed_at: nowIso() };
  writeSession(closed);
  const current = getCurrentCoSessionId();
  if (current === session_id && safeExistsSync(currentPointerFile())) {
    withCoSessionWrite(() => safeRmSync(currentPointerFile()));
  }
  appendEvent(session_id, 'session_closed', provider);
  return closed;
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
  const prev = safeExistsSync(file) ? String(safeReadFile(file, { encoding: 'utf8' })) : '';
  const block = `\n## ${nowIso()} — ${provider}\n\n${text}\n`;
  withCoSessionWrite(() => {
    safeWriteFile(file, prev + block, { encoding: 'utf8', mkdir: true });
  });
  appendEvent(session_id, 'blackboard_appended', provider, { chars: text.length });
  return readCoSessionBlackboard(session_id);
}

function leaseFile(sessionId: string, pathHash: string): string {
  return path.join(leasesDir(sessionId), `${pathHash}.json`);
}

function refreshLeaseStatus(lease: CoSessionPathLease): CoSessionPathLease {
  if (lease.status !== 'active') return lease;
  if (Date.parse(lease.expires_at) <= Date.now()) {
    const expired: CoSessionPathLease = { ...lease, status: 'expired' };
    writeJson(leaseFile(lease.session_id, lease.path_hash), expired);
    appendEvent(lease.session_id, 'lease_expired', lease.holder_provider, {
      path: lease.path,
      lease_id: lease.lease_id,
    });
    return expired;
  }
  return lease;
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
    .map(refreshLeaseStatus);
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
  readSession(session_id);
  const repoPath = normalizeCoSessionPath(input.path);
  const path_hash = pathHashForLease(repoPath);
  const participant_id = input.participant_id?.trim() || `${provider}-${process.pid}`;
  const existing = readJsonIfPresent<CoSessionPathLease>(leaseFile(session_id, path_hash));
  const current = existing ? refreshLeaseStatus(existing) : undefined;
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
  const lease: CoSessionPathLease = {
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
    writeJson(leaseFile(session_id, path_hash), lease);
  });
  appendEvent(session_id, 'lease_acquired', provider, {
    path: repoPath,
    lease_id: lease.lease_id,
    expires_at: lease.expires_at,
  });
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
  const existing = readJsonIfPresent<CoSessionPathLease>(leaseFile(session_id, path_hash));
  if (!existing) throw new CoSessionError('not_found', `no lease for path: ${repoPath}`);
  const current = refreshLeaseStatus(existing);
  const participant_id = input.participant_id?.trim() || `${provider}-${process.pid}`;
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
  const released: CoSessionPathLease = {
    ...current,
    status: 'released',
    released_at: nowIso(),
  };
  writeJson(leaseFile(session_id, path_hash), released);
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
  appendJsonl(handoffsFile(session_id), handoff);
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
      if (row.to_participant_id === target) return true;
      // Provider-broadcast handoffs (no participant) are visible to every instance.
      if (!row.to_participant_id && provider && row.to_provider === provider) return true;
      return false;
    });
  } else if (opts.to_provider) {
    const provider = assertProvider(opts.to_provider);
    rows = rows.filter((row) => row.to_provider === provider);
  }
  return rows;
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
  const acked: CoSessionHandoff = {
    ...current,
    acked_at: nowIso(),
    acked_by: provider,
    acked_by_participant_id: participant_id,
  };
  // Rewrite handoffs file deterministically (small local log).
  const file = handoffsFile(session_id);
  withCoSessionWrite(() => {
    if (safeExistsSync(file)) safeRmSync(file);
    for (const row of rows.map((row, i) => (i === index ? acked : row))) {
      appendJsonLine(assertSafeRepositoryPath(file, { allowMissingLeaf: true }), row);
    }
  });
  appendEvent(session_id, 'handoff_acked', provider, {
    handoff_id: acked.handoff_id,
    participant_id,
  });
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
