/**
 * SO-02: OrchestratorSession — durable conversation-thread <-> mission-ownership
 * binding.
 *
 * SO-01 (`mission-lifecycle-service.ts`) made the lifecycle verbs callable
 * in-process, but nothing records that a *given conversation thread* is the
 * one steering a *given mission*. This module is that record: a governed,
 * journaled binding between `(surface, channel, thread)` and `mission_id`,
 * modeled on the KD-03 event-sourcing restore contract
 * (`worker-state-journal.ts`: op/model + pure `apply` + silent replay) but
 * on its OWN {@link EventSourcingKernel} instance/model name
 * (`orchestrator_session`) — never the shared `workerStateKernel` singleton.
 *
 * Invariants:
 *   1. **One owner per mission** — at most one ACTIVE session per mission.
 *      Enforced here at the service layer (the reducers themselves enforce
 *      nothing; they are pure last-write appliers, same as KD-03's ops).
 *      Creating a session for a mission that already has a different active
 *      session throws {@link OrchestratorSessionOwnershipConflictError}.
 *      Creating the exact same thread+mission binding again while it is
 *      still active is idempotent (returns the existing record).
 *   2. **Governed writes, ungated reads** — `create`/`release` fail closed
 *      exactly like the SO-01 facade (`resolveRole() === 'mission_controller'`
 *      or an ancestor `withExecutionContext('mission_controller', ...)`
 *      frame). Reads (`getActiveSessionForMission`, `getSessionForThread`,
 *      `listOrchestratorSessions`) are exempt — they never mutate state.
 *   3. **Restart-transparent** — the journal at
 *      `active/shared/coordination/orchestration/orchestrator-sessions.jsonl`
 *      is authoritative; the module-level singleton lazily replays it on
 *      first access, so a process restart transparently sees prior sessions.
 *      Replay runs inside {@link runInRestoreMode} (reused from
 *      worker-state-journal.ts) — no side effects during replay.
 *   4. **Release is idempotent** — releasing an already-released or unknown
 *      session/mission returns `null`, never throws.
 *
 * `deriveSurfaceSessionId` is extracted from
 * `surface-runtime-orchestrator.ts` (`runSurfaceMessageConversation`'s HA-01
 * session key) as the single source of truth; that module now imports it
 * from here instead of inlining the hash, and the derived ids are
 * byte-identical to what it computed before (same input -> same hash).
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { pathResolver } from './path-resolver.js';
import { safeAppendFileSync, safeExistsSync, safeMkdir, safeReadFile } from './secure-io.js';
import { resolveRole, withExecutionContext } from './authority.js';
import { logger } from './core.js';
import {
  EventSourcingKernel,
  journalEventEnvelopeSchema,
  runInRestoreMode,
  assertNotDuringRestore,
  type JournalEventEnvelope,
} from './worker-state-journal.js';
import {
  claimWorkItem,
  createWorkItem,
  getWorkItem,
  releaseWorkItem,
  renewWorkItemLease,
  WorkCoordinationError,
  type WorkLease,
} from './work-coordination.js';

// ---------------------------------------------------------------------------
// Session identity — single source of truth for the surface/channel/thread
// derived session id (HA-01 precedent, extracted verbatim).
// ---------------------------------------------------------------------------

/**
 * Deterministic session id for a `(surface, channel, thread)` tuple.
 * Byte-identical to the derivation `runSurfaceMessageConversation` used to
 * compute inline (`surface-runtime-orchestrator.ts`) — moved here so both
 * the HA-01 background-review-fork session key and this module's own
 * `session_id` share one implementation.
 */
export function deriveSurfaceSessionId(
  surface: string,
  channel?: string | null,
  threadTs?: string | null
): string {
  const sessionKey = [surface, channel || 'default', threadTs || 'default'].join(':');
  return `surface-${createHash('sha256').update(sessionKey).digest('hex').slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_SESSION_STATUSES = ['active', 'released'] as const;
export type OrchestratorSessionStatus = (typeof ORCHESTRATOR_SESSION_STATUSES)[number];

export const ORCHESTRATOR_SESSION_RELEASE_REASONS = ['handoff', 'finish', 'explicit'] as const;
export type OrchestratorSessionReleaseReason =
  (typeof ORCHESTRATOR_SESSION_RELEASE_REASONS)[number];

const orchestratorSessionCorrelationLinkSchema = z
  .object({
    correlation_id: z.string(),
    linked_at: z.string(),
  })
  .strict();

/** IL-02 lineage: correlation ids observed against this session, oldest first. */
export type OrchestratorSessionCorrelationLink = z.infer<
  typeof orchestratorSessionCorrelationLinkSchema
>;

export const orchestratorSessionRecordSchema = z
  .object({
    session_id: z.string(),
    surface: z.string(),
    channel: z.string().optional(),
    thread_ts: z.string().optional(),
    mission_id: z.string(),
    owner_actor: z.string(),
    status: z.enum(ORCHESTRATOR_SESSION_STATUSES),
    created_at: z.string(),
    released_at: z.string().optional(),
    release_reason: z.enum(ORCHESTRATOR_SESSION_RELEASE_REASONS).optional(),
    correlation_lineage: z.array(orchestratorSessionCorrelationLinkSchema).optional(),
    // SO-03: cross-process mission-ownership work-item claim backing this
    // session's owner authority. Optional so pre-SO-03 journal records (no
    // lease fields at all) still parse — the journal version stays 1.
    lease_id: z.string().optional(),
    ownership_item_id: z.string().optional(),
  })
  .strict();

export type OrchestratorSessionRecord = z.infer<typeof orchestratorSessionRecordSchema>;

// ---------------------------------------------------------------------------
// Journaled model: own kernel, own model name (never workerStateKernel)
// ---------------------------------------------------------------------------

export interface OrchestratorSessionState {
  /** Keyed by session-binding id (= deriveSurfaceSessionId(surface, channel, threadTs)). */
  sessions: Record<string, OrchestratorSessionRecord>;
  /** mission_id -> session_id, present only while that session is active. */
  activeByMission: Record<string, string>;
}

function initialOrchestratorSessionState(): OrchestratorSessionState {
  return { sessions: {}, activeByMission: {} };
}

/** SO-02's own kernel — deliberately not the shared `workerStateKernel` singleton. */
export const orchestratorSessionKernel = new EventSourcingKernel();

const orchestratorSessionModel = orchestratorSessionKernel.defineModel<OrchestratorSessionState>(
  'orchestrator_session',
  initialOrchestratorSessionState
);

/** op names as constants so callers/tests never guess the strings (KD-03 pattern). */
export const ORCHESTRATOR_SESSION_OPS = {
  sessionCreated: 'session_created',
  sessionReleased: 'session_released',
} as const;

const sessionCreatedPayloadSchema = z
  .object({
    session_id: z.string(),
    surface: z.string(),
    channel: z.string().optional(),
    thread_ts: z.string().optional(),
    mission_id: z.string(),
    owner_actor: z.string(),
    created_at: z.string(),
    correlation_id: z.string().optional(),
    // SO-03: optional so replay of pre-SO-03 journal lines (written before
    // this module claimed a work-item lease per session) still validates.
    lease_id: z.string().optional(),
    ownership_item_id: z.string().optional(),
  })
  .strict();

const sessionReleasedPayloadSchema = z
  .object({
    session_id: z.string(),
    released_at: z.string(),
    release_reason: z.enum(ORCHESTRATOR_SESSION_RELEASE_REASONS),
  })
  .strict();

orchestratorSessionKernel.defineOp(ORCHESTRATOR_SESSION_OPS.sessionCreated, {
  model: orchestratorSessionModel,
  schema: sessionCreatedPayloadSchema,
  apply: (state, payload) => {
    const record: OrchestratorSessionRecord = {
      session_id: payload.session_id,
      surface: payload.surface,
      channel: payload.channel,
      thread_ts: payload.thread_ts,
      mission_id: payload.mission_id,
      owner_actor: payload.owner_actor,
      status: 'active',
      created_at: payload.created_at,
      ...(payload.lease_id ? { lease_id: payload.lease_id } : {}),
      ...(payload.ownership_item_id ? { ownership_item_id: payload.ownership_item_id } : {}),
      ...(payload.correlation_id
        ? {
            correlation_lineage: [
              { correlation_id: payload.correlation_id, linked_at: payload.created_at },
            ],
          }
        : {}),
    };
    return {
      sessions: { ...state.sessions, [record.session_id]: record },
      activeByMission: { ...state.activeByMission, [record.mission_id]: record.session_id },
    };
  },
});

orchestratorSessionKernel.defineOp(ORCHESTRATOR_SESSION_OPS.sessionReleased, {
  model: orchestratorSessionModel,
  schema: sessionReleasedPayloadSchema,
  apply: (state, payload) => {
    const existing = state.sessions[payload.session_id];
    // Idempotent: releasing an unknown/already-released session is a no-op
    // and MUST return the same reference (KD-03 purity contract).
    if (!existing || existing.status === 'released') return state;
    const released: OrchestratorSessionRecord = {
      ...existing,
      status: 'released',
      released_at: payload.released_at,
      release_reason: payload.release_reason,
    };
    const nextActiveByMission = { ...state.activeByMission };
    if (nextActiveByMission[existing.mission_id] === existing.session_id) {
      delete nextActiveByMission[existing.mission_id];
    }
    return {
      sessions: { ...state.sessions, [released.session_id]: released },
      activeByMission: nextActiveByMission,
    };
  },
});

// ---------------------------------------------------------------------------
// Journal: authoritative append-only JSONL + silent restore (KD-03 pattern)
// ---------------------------------------------------------------------------

/** On-disk schema version for THIS journal (independent of KD-03's worker journal version). */
const ORCHESTRATOR_SESSION_JOURNAL_VERSION = 1;

export interface OrchestratorSessionJournalOptions {
  /** Authoritative append-only JSONL journal (resolved through secure-io/pathResolver). */
  journalPath: string;
  now?: () => string;
}

interface OrchestratorSessionReadResult {
  events: JournalEventEnvelope[];
  maxSeq: number;
}

export class OrchestratorSessionJournal {
  private readonly kernel = orchestratorSessionKernel;
  private readonly journalPath: string;
  private readonly now: () => string;
  private seqLoaded = false;
  private seq = 0;

  constructor(options: OrchestratorSessionJournalOptions) {
    this.journalPath = pathResolver.rootResolve(options.journalPath);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Validate, stamp seq/ts, and append. Refused during restore (no mutation while replaying). */
  append(opName: string, payload: unknown): JournalEventEnvelope {
    assertNotDuringRestore('OrchestratorSessionJournal.append');
    const validated = this.kernel.validatePayload(opName, payload);
    this.ensureSeqLoaded();
    const envelope = journalEventEnvelopeSchema.parse({
      v: ORCHESTRATOR_SESSION_JOURNAL_VERSION,
      seq: this.seq++,
      ts: this.now(),
      op: opName,
      payload: validated,
    });
    this.ensureDir();
    safeAppendFileSync(this.journalPath, `${JSON.stringify(envelope)}\n`);
    return envelope;
  }

  /** Reconstruct state purely from the journal: validate -> silent replay. No side effects. */
  restore(): OrchestratorSessionState {
    const read = this.readJournal();
    this.seq = read.maxSeq + 1;
    this.seqLoaded = true;
    return runInRestoreMode(() => {
      const states = this.kernel.project(read.events);
      return (
        (states.get('orchestrator_session') as OrchestratorSessionState) ??
        initialOrchestratorSessionState()
      );
    });
  }

  private ensureSeqLoaded(): void {
    if (this.seqLoaded) return;
    this.seq = this.readJournal().maxSeq + 1;
    this.seqLoaded = true;
  }

  private readJournal(): OrchestratorSessionReadResult {
    if (!safeExistsSync(this.journalPath)) return { events: [], maxSeq: -1 };
    const raw = String(safeReadFile(this.journalPath, { encoding: 'utf-8' }));
    const events: JournalEventEnvelope[] = [];
    let maxSeq = -1;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = journalEventEnvelopeSchema.parse(JSON.parse(trimmed));
        events.push(parsed);
        if (parsed.seq > maxSeq) maxSeq = parsed.seq;
      } catch {
        // A torn/corrupt line must not poison replay of the rest.
      }
    }
    return { events, maxSeq };
  }

  private ensureDir(): void {
    const dir = this.journalPath.replace(/[/\\][^/\\]+$/, '');
    if (dir && dir !== this.journalPath && !safeExistsSync(dir)) {
      safeMkdir(dir, { recursive: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Governed error types
// ---------------------------------------------------------------------------

export class OrchestratorSessionGovernedError extends Error {
  constructor(verb: string, resolvedRole: string | undefined) {
    super(
      `[orchestrator-session] '${verb}' requires mission_controller execution context ` +
        `(resolved role: ${resolvedRole ?? 'undefined'}). Call it from within ` +
        `withExecutionContext('mission_controller', ...) or from a process whose role ` +
        `resolves to mission_controller (see libs/core/authority.ts resolveRole).`
    );
    this.name = 'OrchestratorSessionGovernedError';
  }
}

/** One-owner-per-mission violation: the mission already has a different active session. */
export class OrchestratorSessionOwnershipConflictError extends Error {
  constructor(
    public readonly missionId: string,
    public readonly existingSessionId: string,
    /**
     * SO-03: extra context when the conflict was detected via the
     * cross-process mission-ownership work-item claim (`lease_conflict`)
     * rather than the in-process journal projection — e.g. the conflicting
     * lease's holder identity, when the local journal hasn't yet observed
     * the winning session's journal append.
     */
    public readonly conflictDetail?: string
  ) {
    super(
      `[orchestrator-session] mission ${missionId} already has an active orchestrator session ` +
        `(${existingSessionId}). One owner per mission: release it (handoff/finish/explicit) ` +
        `before creating a new one.${conflictDetail ? ` ${conflictDetail}` : ''}`
    );
    this.name = 'OrchestratorSessionOwnershipConflictError';
  }
}

function assertOrchestratorSessionGovernedContext(verb: string): void {
  const role = resolveRole();
  if (role !== 'mission_controller') {
    throw new OrchestratorSessionGovernedError(verb, role);
  }
}

// ---------------------------------------------------------------------------
// Service: module-level singleton, lazy replay on first access
// ---------------------------------------------------------------------------

/** Governed storage scope granted to `mission_controller` (SN-01) — see role-write-access.json. */
export const ORCHESTRATOR_SESSION_JOURNAL_PATH = pathResolver.shared(
  'coordination/orchestration/orchestrator-sessions.jsonl'
);

let defaultJournal: OrchestratorSessionJournal | null = null;

function getDefaultJournal(): OrchestratorSessionJournal {
  if (!defaultJournal) {
    defaultJournal = new OrchestratorSessionJournal({
      journalPath: ORCHESTRATOR_SESSION_JOURNAL_PATH,
    });
  }
  return defaultJournal;
}

/**
 * Project the current state fresh from the journal on EVERY access — no
 * in-memory cache. Multiple processes share this journal (CLI mission
 * controller, surface daemons), and downstream callers (SO-04) use these
 * reads to decide steering authority: a stale cached projection could show a
 * session as active after another process released it via handoff/finish.
 * The journal is small (append-only session lifecycle events), so a fresh
 * read-and-replay per access is cheap and always cross-process consistent.
 */
function ensureState(): OrchestratorSessionState {
  return getDefaultJournal().restore();
}

/** Re-project after a live append so the returned record reflects the write. */
function refreshState(): OrchestratorSessionState {
  return getDefaultJournal().restore();
}

/**
 * Test-only hook: point the module-level singleton at a fresh journal path
 * (or the default governed path when omitted) and drop the cached
 * projection. Real callers never need this — the journal path is fixed by
 * the governed storage scope granted to `mission_controller`.
 */
export function resetOrchestratorSessionServiceForTests(
  journalPath: string = ORCHESTRATOR_SESSION_JOURNAL_PATH
): void {
  defaultJournal = new OrchestratorSessionJournal({ journalPath });
}

/** Exported so other SO-03+ modules (surface-steering-authority.ts, tests) normalize identically. */
export function normalizeOrchestratorMissionId(missionId: string): string {
  return missionId.toUpperCase();
}

function normalizeMissionId(missionId: string): string {
  return normalizeOrchestratorMissionId(missionId);
}

/** SO-03: deterministic namespace-safe id for a mission's ownership work-item claim. */
const MISSION_OWNERSHIP_ITEM_PREFIX = 'mission-ownership:';

/** SO-03: purpose tag stamped on the ownership work-item's lease. */
export const ORCHESTRATOR_SESSION_OWNERSHIP_PURPOSE = 'mission_ownership';

/** SO-03: lease TTL for the mission-ownership claim — long-lived (steering sessions can span hours), renewed by SO-04's steering turns via {@link renewOrchestratorSessionLease}. */
export const ORCHESTRATOR_SESSION_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The deterministic work-item id backing `missionId`'s ownership claim.
 * Prefixed and namespaced so it can never collide with a real work item
 * dispatched through the normal WorkItem flow (see work-coordination.ts).
 */
export function deriveMissionOwnershipItemId(missionId: string): string {
  return `${MISSION_OWNERSHIP_ITEM_PREFIX}${normalizeOrchestratorMissionId(missionId)}`;
}

/** Idempotent: create the mission-ownership work item on first use only. */
function ensureMissionOwnershipWorkItem(itemId: string, missionId: string): void {
  if (getWorkItem(itemId)) return;
  createWorkItem({
    itemId,
    title: `Mission ownership: ${missionId}`,
    description:
      `SO-03 mission-ownership claim item for mission ${missionId}. This is not a real unit of ` +
      'work — it exists only so orchestrator-session.ts can serialize "who owns this mission" ' +
      'across processes through the same lease mechanism real work items use.',
    projectId: 'orchestrator-sessions',
    metadata: { mission_id: missionId, kind: 'mission_ownership' },
  });
}

export interface CreateOrchestratorSessionParams {
  surface: string;
  channel?: string;
  threadTs?: string;
  missionId: string;
  ownerActor: string;
  /** Optional IL-02 correlation id to seed the lineage with. */
  correlationId?: string;
}

/**
 * Bind a conversation thread to a mission as its owning orchestrator
 * session. Fails closed outside a `mission_controller` execution context.
 * Rejects with {@link OrchestratorSessionOwnershipConflictError} when the
 * mission already has a different active session (one owner per mission).
 * Idempotent for the exact same thread+mission binding while it is active.
 */
export function createOrchestratorSession(
  params: CreateOrchestratorSessionParams
): OrchestratorSessionRecord {
  assertOrchestratorSessionGovernedContext('createOrchestratorSession');
  const missionId = normalizeMissionId(params.missionId);
  const sessionId = deriveSurfaceSessionId(params.surface, params.channel, params.threadTs);
  const state = ensureState();

  const existingActiveId = state.activeByMission[missionId];
  if (existingActiveId) {
    const existingRecord = state.sessions[existingActiveId];
    if (existingActiveId === sessionId && existingRecord?.status === 'active') {
      return existingRecord; // idempotent: same thread+mission already active
    }
    throw new OrchestratorSessionOwnershipConflictError(missionId, existingActiveId);
  }

  // SO-03: cross-process ownership claim. A bare journal append has no
  // compare-and-set, so it cannot by itself stop two processes that both
  // observed "no active session" above from each appending a
  // `session_created` event for the same mission. work-coordination's lease
  // claim DOES serialize concurrent claimants on the same item_id (see
  // `claimWorkItem`'s existing-lease check), so it is the real mutual
  // exclusion primitive here; the in-process check above is only a fast
  // path for the common (non-racing) case.
  const ownershipItemId = deriveMissionOwnershipItemId(missionId);
  ensureMissionOwnershipWorkItem(ownershipItemId, missionId);

  let lease: WorkLease;
  try {
    lease = claimWorkItem({
      itemId: ownershipItemId,
      actorPeerId: params.ownerActor,
      purpose: ORCHESTRATOR_SESSION_OWNERSHIP_PURPOSE,
      ttlMs: ORCHESTRATOR_SESSION_LEASE_TTL_MS,
      // Idempotency key = session_id: the exact same thread+mission binding
      // re-creating (e.g. after a restart, before the journal replay above
      // even runs) re-claims the SAME lease rather than conflicting with
      // itself.
      idempotencyKey: sessionId,
      metadata: {
        surface: params.surface,
        channel: params.channel,
        thread_ts: params.threadTs,
        mission_id: missionId,
      },
    }).lease;
  } catch (error) {
    if (error instanceof WorkCoordinationError && error.code === 'lease_conflict') {
      // Prefer the locally-visible active session (already appended) for
      // the error's `existingSessionId`; fall back to describing the raw
      // work-item claim holder for the narrow window where the winning
      // process claimed the lease but hasn't appended its journal event yet.
      const knownActive = getActiveSessionForMission(missionId);
      if (knownActive) {
        throw new OrchestratorSessionOwnershipConflictError(missionId, knownActive.session_id);
      }
      const conflictingItem = getWorkItem(ownershipItemId);
      const holderDetail = conflictingItem?.claimed_by_peer_id
        ? `Conflicting holder: ${conflictingItem.claimed_by_peer_id} ` +
          `(work-item lease ${conflictingItem.lease_id ?? 'unknown'}).`
        : `Conflicting work-item claim on ${ownershipItemId}.`;
      throw new OrchestratorSessionOwnershipConflictError(
        missionId,
        'cross-process-claim-holder',
        holderDetail
      );
    }
    throw error;
  }

  const createdAt = new Date().toISOString();
  const payload = {
    session_id: sessionId,
    surface: params.surface,
    channel: params.channel,
    thread_ts: params.threadTs,
    mission_id: missionId,
    owner_actor: params.ownerActor,
    created_at: createdAt,
    lease_id: lease.lease_id,
    ownership_item_id: ownershipItemId,
    ...(params.correlationId ? { correlation_id: params.correlationId } : {}),
  };
  // Defense-in-depth: the gate above already required mission_controller
  // context, but re-assert it around the actual write (see
  // surface-mission-proposals.ts:439) so the governed-path policy on
  // active/shared/coordination/orchestration/ sees it too, regardless of
  // how the caller's own context was scoped.
  withExecutionContext('mission_controller', () => {
    getDefaultJournal().append(ORCHESTRATOR_SESSION_OPS.sessionCreated, payload);
  });
  const next = refreshState();
  const record = next.sessions[sessionId];
  if (!record) {
    throw new Error(`[orchestrator-session] internal: session ${sessionId} missing after create`);
  }
  return record;
}

/** Read-only, ungated: the active session bound to `missionId`, or `null`. */
export function getActiveSessionForMission(missionId: string): OrchestratorSessionRecord | null {
  const state = ensureState();
  const sessionId = state.activeByMission[normalizeMissionId(missionId)];
  if (!sessionId) return null;
  const record = state.sessions[sessionId];
  return record && record.status === 'active' ? record : null;
}

/** Read-only, ungated: the active session bound to a `(surface, channel, thread)` tuple, or `null`. */
export function getSessionForThread(
  surface: string,
  channel?: string,
  threadTs?: string
): OrchestratorSessionRecord | null {
  const state = ensureState();
  const sessionId = deriveSurfaceSessionId(surface, channel, threadTs);
  const record = state.sessions[sessionId];
  return record && record.status === 'active' ? record : null;
}

/** Read-only, ungated: every known session (active and released), oldest first. */
export function listOrchestratorSessions(): OrchestratorSessionRecord[] {
  const state = ensureState();
  return Object.values(state.sessions).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Release a session by id. Fails closed outside a `mission_controller`
 * execution context. Idempotent: releasing an unknown or already-released
 * session returns `null` rather than throwing.
 */
export function releaseOrchestratorSession(
  sessionId: string,
  reason: OrchestratorSessionReleaseReason
): OrchestratorSessionRecord | null {
  assertOrchestratorSessionGovernedContext('releaseOrchestratorSession');
  const state = ensureState();
  const existing = state.sessions[sessionId];
  if (!existing || existing.status === 'released') return null;

  const releasedAt = new Date().toISOString();
  withExecutionContext('mission_controller', () => {
    getDefaultJournal().append(ORCHESTRATOR_SESSION_OPS.sessionReleased, {
      session_id: sessionId,
      released_at: releasedAt,
      release_reason: reason,
    });
  });
  const next = refreshState();

  // SO-03: best-effort release of the cross-process ownership lease. The
  // journal release above already committed, so a missing/expired/foreign
  // lease here (already reclaimed, TTL lapsed, pre-SO-03 record with no
  // lease at all, ...) must never fail this call — only log.
  if (existing.lease_id && existing.ownership_item_id) {
    try {
      releaseWorkItem({
        itemId: existing.ownership_item_id,
        leaseId: existing.lease_id,
        actorPeerId: existing.owner_actor,
      });
    } catch (error) {
      logger.warn(
        `[orchestrator-session] best-effort ownership-lease release for session ${sessionId} ` +
          `(item ${existing.ownership_item_id}, lease ${existing.lease_id}) failed: ${
            error instanceof Error ? error.message : String(error)
          }`
      );
    }
  }

  return next.sessions[sessionId] ?? null;
}

/**
 * SO-03: thin wrapper over `renewWorkItemLease` for the session's ownership
 * lease. SO-04's steering turns call this to keep a long-running conversation
 * thread's mission-ownership claim from expiring under
 * {@link ORCHESTRATOR_SESSION_LEASE_TTL_MS} while the mission is still being
 * actively steered. Fails closed outside a `mission_controller` execution
 * context, like every other write in this module. Throws (does not swallow)
 * on a missing/expired lease or an inactive/unknown session — callers that
 * want best-effort semantics should catch at the call site, mirroring how
 * {@link releaseOrchestratorSessionForMissionBestEffort} wraps
 * {@link releaseOrchestratorSessionForMission}.
 */
export function renewOrchestratorSessionLease(sessionId: string): WorkLease {
  assertOrchestratorSessionGovernedContext('renewOrchestratorSessionLease');
  const state = ensureState();
  const record = state.sessions[sessionId];
  if (!record || record.status !== 'active') {
    throw new Error(
      `[orchestrator-session] cannot renew ownership lease: session ${sessionId} is not active`
    );
  }
  if (!record.lease_id) {
    throw new Error(
      `[orchestrator-session] cannot renew ownership lease: session ${sessionId} has no ` +
        'ownership lease on record (pre-SO-03 session).'
    );
  }
  return renewWorkItemLease({ leaseId: record.lease_id, ttlMs: ORCHESTRATOR_SESSION_LEASE_TTL_MS });
}

/**
 * Release whichever session is currently active for `missionId`, if any.
 * Fails closed outside a `mission_controller` execution context. Idempotent:
 * a mission with no active session returns `null` rather than throwing.
 * This is the seam `mission-lifecycle-service.ts` (`finish`) and
 * `scripts/mission_controller.ts` (`handoffMission`) call as a best-effort
 * post-condition.
 */
export function releaseOrchestratorSessionForMission(
  missionId: string,
  reason: OrchestratorSessionReleaseReason
): OrchestratorSessionRecord | null {
  assertOrchestratorSessionGovernedContext('releaseOrchestratorSessionForMission');
  const active = getActiveSessionForMission(missionId);
  if (!active) return null;
  return releaseOrchestratorSession(active.session_id, reason);
}

/**
 * Best-effort release hook: swallows and logs any failure so a release
 * problem never fails the caller's mission-lifecycle operation (finish /
 * handoff). Re-establishes `mission_controller` execution context itself so
 * it works regardless of how the caller's own context was scoped (see the
 * `withExecutionContext` synchronous-scope note in
 * mission-lifecycle-service.test.ts).
 */
export function releaseOrchestratorSessionForMissionBestEffort(
  missionId: string | null | undefined,
  reason: OrchestratorSessionReleaseReason
): void {
  if (!missionId) return;
  try {
    withExecutionContext('mission_controller', () =>
      releaseOrchestratorSessionForMission(missionId, reason)
    );
  } catch (error) {
    logger.warn(
      `[orchestrator-session] best-effort release for mission ${missionId} (reason: ${reason}) failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
