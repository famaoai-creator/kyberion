/**
 * NI-04: task-scoped short-lived grants — audience-bound authority.
 *
 * Before this module, the only temporal authority mechanism was the legacy
 * `active/shared/auth-grants.json` mission-level grants read by
 * `authority.resolveIdentityContext` (mission_id + expiry, no grantee, no
 * task audience). This module adds the internal analogue of **RFC 8707
 * Resource Indicators** (audience restriction, plan §2): a
 * {@link TaskScopedGrant} names a grantee NHI (`grantee_nhi_id`, NI-01), an
 * explicit audience (`{ mission_id, task_id? }`) and a mandatory bounded
 * `expires_at`. Exactly as an RFC 8707-constrained access token is only
 * accepted by the resource it was minted for, a task-scoped grant is served
 * ONLY when the requesting execution context matches its declared audience:
 * the mission must match, and when the grant names a `task_id` the requesting
 * task must match too. Outside that audience — different mission, different
 * task, or no task context at all — the grant contributes NOTHING
 * (fail-closed silence; deny attempts are audit-recorded).
 *
 * Lifecycle (least privilege, no standing authority):
 *   - **Issued at task dispatch** (mission-workitem-dispatch.ts) for the
 *     dispatched worker's nhi_id, audience = the dispatched mission/task.
 *   - **Revoked at task completion/failure** ({@link revokeGrantsForTask},
 *     wired into `reflectTicketOutcome` next to AL-03's task-artifact GC).
 *   - **Lazy expiry** — there is no cron: an expired grant is simply never
 *     served ({@link resolveGrantsForActor} / {@link listActiveGrants} filter
 *     on `now < expires_at`), so `expires_at` reaching the past IS the
 *     revocation for any path the completion hook missed.
 *   - **TTL is clamped, not rejected**: a caller-supplied `expires_at`
 *     beyond {@link TASK_GRANT_MAX_TTL_MS} (24h) is clamped down to the max;
 *     the effective expiry is the SHORTEST of (caller-supplied expiry or the
 *     {@link TASK_GRANT_DEFAULT_TTL_MS} default), the task deadline when one
 *     is supplied, and the max TTL. Only an expiry that is already in the
 *     past is rejected ({@link TaskGrantValidationError}).
 *
 * Storage: a dedicated append-only JSONL store
 * (`active/shared/coordination/identity/task-grants.jsonl`) — deliberately
 * NOT the legacy `auth-grants.json` file, whose shape and consumers stay
 * untouched; `authority.resolveIdentityContext` learns to read BOTH. Each
 * line is a full {@link TaskScopedGrant} record; the LAST record per
 * `grant_id` wins (revocation appends the same record with
 * `revoked_at`/`revoke_reason` set). Corrupt/torn lines are tolerated on
 * read. Writes are governed (same role allowlist + vitest
 * default-path-repoint discipline as agent-identity.ts); reads never gate.
 *
 * NOTE for authority.ts: this module writes through secure-io, and
 * secure-io's policy chain imports authority.ts — so authority.ts CANNOT
 * import this module (the TDZ cycle documented at the top of authority.ts).
 * The read-side audience filter in `resolveIdentityContext` is therefore a
 * small, intentionally duplicated raw-read twin of
 * {@link resolveGrantsForActor}; both honor {@link TASK_GRANTS_PATH_ENV} so
 * they always read the same store.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pathResolver } from './path-resolver.js';
import { safeAppendFileSync, safeExistsSync, safeMkdir, safeReadFile } from './secure-io.js';
import { resolveRole, withExecutionContext } from './authority.js';
import { auditChain } from './audit-chain.js';
import { logger } from './core.js';
import { AGENT_IDENTITY_WRITE_ROLES, NHI_ID_PATTERN } from './agent-identity.js';

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

export const TASK_GRANT_TIER_ACCESS = ['public', 'confidential', 'personal'] as const;
export type TaskGrantTierAccess = (typeof TASK_GRANT_TIER_ACCESS)[number];

export const taskGrantScopeSchema = z
  .object({
    /**
     * Capability names. Entries that name an `Authority` value (GIT_WRITE,
     * SECRET_READ, NETWORK_FETCH, SYSTEM_EXEC, KNOWLEDGE_WRITE — never SUDO)
     * are translated into authorities by `authority.resolveIdentityContext`
     * when the grant's audience matches; other entries are opaque capability
     * tags for capability-layer consumers.
     */
    capabilities: z.array(z.string()).optional(),
    write_scopes: z.array(z.string()).optional(),
    tier_access: z.array(z.enum(TASK_GRANT_TIER_ACCESS)).optional(),
  })
  .strict();

export type TaskGrantScope = z.infer<typeof taskGrantScopeSchema>;

export const taskGrantAudienceSchema = z
  .object({
    mission_id: z.string().min(1),
    /**
     * When present, the grant is valid ONLY inside this task's execution
     * context; when absent, the grant is mission-wide (any task of the
     * mission, or no task context).
     */
    task_id: z.string().min(1).optional(),
  })
  .strict();

export type TaskGrantAudience = z.infer<typeof taskGrantAudienceSchema>;

export const taskScopedGrantSchema = z
  .object({
    grant_id: z.string().min(1),
    grantee_nhi_id: z.string().regex(NHI_ID_PATTERN),
    scope: taskGrantScopeSchema,
    audience: taskGrantAudienceSchema,
    /** ISO-8601. Mandatory and bounded — see module doc for the clamp rules. */
    expires_at: z.string().min(1),
    issued_by: z.string().min(1),
    issued_at: z.string().min(1),
    revoked_at: z.string().optional(),
    revoke_reason: z.string().optional(),
  })
  .strict();

export type TaskScopedGrant = z.infer<typeof taskScopedGrantSchema>;

// ---------------------------------------------------------------------------
// TTL bounds
// ---------------------------------------------------------------------------

/** Hard ceiling: no task grant outlives 24h, whatever the caller asked for (clamped). */
export const TASK_GRANT_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** Default TTL when the caller supplies neither `expiresAt` nor a task deadline. */
export const TASK_GRANT_DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Store path (env-repointable — the same path resolution authority.ts uses)
// ---------------------------------------------------------------------------

/**
 * Env override for the store path (relative paths resolve against the repo
 * root). Doubles as the hermetic-test repoint hook: under vitest, WRITES to
 * the governed default path are refused unless this override is set (reads
 * are always allowed) — same discipline as agent-identity.ts's journal guard.
 */
export const TASK_GRANTS_PATH_ENV = 'KYBERION_TASK_GRANTS_PATH';

/** Governed default store (mission_controller write scope, like the NI-01 identity journal). */
export const TASK_GRANTS_STORE_PATH = pathResolver.shared(
  'coordination/identity/task-grants.jsonl'
);

export function resolveTaskGrantsStorePath(): string {
  const override = process.env[TASK_GRANTS_PATH_ENV]?.trim();
  if (override) return pathResolver.rootResolve(override);
  return TASK_GRANTS_STORE_PATH;
}

// ---------------------------------------------------------------------------
// Governed gate + typed errors
// ---------------------------------------------------------------------------

/** Same role allowlist as the NI-01 identity ledger — grants are runtime-management writes. */
export const TASK_GRANT_WRITE_ROLES = AGENT_IDENTITY_WRITE_ROLES;

export class TaskGrantGovernedError extends Error {
  constructor(verb: string, resolvedRole: string | undefined) {
    super(
      `[task-scoped-grants] '${verb}' requires an agent-runtime-managing execution context ` +
        `(one of: ${TASK_GRANT_WRITE_ROLES.join(', ')}; resolved role: ` +
        `${resolvedRole ?? 'undefined'}). Call it from within ` +
        `withExecutionContext('mission_controller', ...).`
    );
    this.name = 'TaskGrantGovernedError';
  }
}

export class TaskGrantValidationError extends Error {
  constructor(message: string) {
    super(`[task-scoped-grants] ${message}`);
    this.name = 'TaskGrantValidationError';
  }
}

function assertTaskGrantGovernedContext(verb: string): void {
  const role = resolveRole();
  if (!role || !(TASK_GRANT_WRITE_ROLES as readonly string[]).includes(role)) {
    throw new TaskGrantGovernedError(verb, role);
  }
}

// ---------------------------------------------------------------------------
// Audit seam (NI-02 sink pattern: injectable, best-effort, vitest no-op)
// ---------------------------------------------------------------------------

export const TASK_GRANT_ISSUED_EVENT = 'task_grant_issued';
export const TASK_GRANT_REVOKED_EVENT = 'task_grant_revoked';
/** Audience-mismatch attempt observed at {@link resolveGrantsForActor}. */
export const TASK_GRANT_DENIED_EVENT = 'task_grant_denied';

export interface TaskGrantAuditEvent {
  action:
    | typeof TASK_GRANT_ISSUED_EVENT
    | typeof TASK_GRANT_REVOKED_EVENT
    | typeof TASK_GRANT_DENIED_EVENT;
  grant_id: string;
  grantee_nhi_id: string;
  audience: TaskGrantAudience;
  context: string;
  result: 'allowed' | 'denied';
  reason?: string;
}

type TaskGrantAuditSink = (event: TaskGrantAuditEvent) => void;

/**
 * Injectable audit sink (hermetic-test seam; `null` restores the default).
 * Default sink discipline mirrors nhi-actor-verification.ts: real runs append
 * to the shared audit chain; under vitest WITHOUT an injected sink the
 * default sink is a no-op (the audit chain writes the real
 * `active/shared/logs/audit/` tree and has no repoint hook).
 */
let auditSinkOverride: TaskGrantAuditSink | null = null;

export function setTaskGrantAuditSinkForTests(sink: TaskGrantAuditSink | null): void {
  auditSinkOverride = sink;
}

function recordGrantAudit(event: TaskGrantAuditEvent): void {
  // Best-effort by contract: an audit failure must never take down the
  // issue/revoke/resolve path it is observing.
  try {
    if (auditSinkOverride) {
      auditSinkOverride(event);
      return;
    }
    if (process.env.VITEST) return; // hermetic guard — see setTaskGrantAuditSinkForTests
    auditChain.record({
      agentId: event.grantee_nhi_id,
      action: event.action,
      operation: event.context,
      result: event.result,
      reason:
        event.reason ?? `task grant ${event.grant_id} ${event.action} for ${event.grantee_nhi_id}`,
      metadata: {
        grant_id: event.grant_id,
        nhi_id: event.grantee_nhi_id,
        audience: event.audience,
      },
    });
  } catch (error) {
    logger.warn(
      `[task-scoped-grants] audit append failed (best-effort): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

// ---------------------------------------------------------------------------
// Store IO
// ---------------------------------------------------------------------------

/** Last record per grant_id wins (revocations re-append the full record). */
function readGrantRecords(): Map<string, TaskScopedGrant> {
  const storePath = resolveTaskGrantsStorePath();
  const latest = new Map<string, TaskScopedGrant>();
  if (!safeExistsSync(storePath)) return latest;
  const raw = String(safeReadFile(storePath, { encoding: 'utf-8' }));
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = taskScopedGrantSchema.parse(JSON.parse(trimmed));
      latest.set(parsed.grant_id, parsed);
    } catch {
      // A torn/corrupt line must not poison replay of the rest.
    }
  }
  return latest;
}

function appendGrantRecord(record: TaskScopedGrant): void {
  if (process.env.VITEST && !process.env[TASK_GRANTS_PATH_ENV]?.trim()) {
    throw new Error(
      '[task-scoped-grants] refusing to write the governed default store under vitest — ' +
        `set process.env.${TASK_GRANTS_PATH_ENV} to an active/shared/tmp/... path in your ` +
        'suite setup (hermetic-test contract: tests never write the real active/ tree)'
    );
  }
  const storePath = resolveTaskGrantsStorePath();
  const validated = taskScopedGrantSchema.parse(record);
  // Defense-in-depth (agent-identity.ts pattern): the caller-facing gate
  // already required an allowlisted runtime role; re-assert mission_controller
  // around the actual write so the governed-path policy sees it too.
  withExecutionContext('mission_controller', () => {
    const dir = storePath.replace(/[/\\][^/\\]+$/, '');
    if (dir && dir !== storePath && !safeExistsSync(dir)) {
      safeMkdir(dir, { recursive: true });
    }
    safeAppendFileSync(storePath, `${JSON.stringify(validated)}\n`);
  });
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export interface IssueTaskGrantParams {
  /** Canonical NI-01 nhi_id of the worker the grant is for. */
  granteeNhiId: string;
  audience: { missionId: string; taskId?: string };
  /**
   * Minimal declared scope. Empty scope is meaningful: the grant then only
   * proves audience membership ("this NHI was dispatched into this
   * mission/task") without conferring any Authority translation.
   */
  scope?: TaskGrantScope;
  /** Requested expiry (ISO). Clamped to the max TTL; see module doc. */
  expiresAt?: string;
  /** Task deadline (ISO): the effective expiry never exceeds it. */
  taskDeadline?: string;
  issuedBy?: string;
}

function parseIsoMs(label: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new TaskGrantValidationError(`${label} is not a parseable ISO-8601 timestamp: ${value}`);
  }
  return ms;
}

/**
 * Governed. Mint a task-scoped grant. Effective expiry = min(requested-or-
 * default, task deadline, now + {@link TASK_GRANT_MAX_TTL_MS}); an expiry
 * already in the past is rejected ({@link TaskGrantValidationError}), an
 * excessive one is clamped (documented policy: clamp, not reject).
 */
export function issueTaskGrant(params: IssueTaskGrantParams): TaskScopedGrant {
  assertTaskGrantGovernedContext('issueTaskGrant');
  const granteeNhiId = params.granteeNhiId?.trim() || '';
  if (!NHI_ID_PATTERN.test(granteeNhiId)) {
    throw new TaskGrantValidationError(
      `grantee_nhi_id "${params.granteeNhiId}" is not a canonical nhi_id (${NHI_ID_PATTERN})`
    );
  }
  const missionId = params.audience.missionId?.trim() || '';
  if (!missionId) {
    throw new TaskGrantValidationError('audience.mission_id is required');
  }

  const now = Date.now();
  const requested = parseIsoMs('expiresAt', params.expiresAt) ?? now + TASK_GRANT_DEFAULT_TTL_MS;
  const deadline = parseIsoMs('taskDeadline', params.taskDeadline);
  const effective = Math.min(
    requested,
    deadline ?? Number.POSITIVE_INFINITY,
    now + TASK_GRANT_MAX_TTL_MS
  );
  if (effective <= now) {
    throw new TaskGrantValidationError(
      `effective expiry ${new Date(effective).toISOString()} is not in the future`
    );
  }

  const taskId = params.audience.taskId?.trim() || undefined;
  const grant: TaskScopedGrant = {
    grant_id: `tg-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
    grantee_nhi_id: granteeNhiId,
    scope: params.scope ?? {},
    audience: { mission_id: missionId, ...(taskId ? { task_id: taskId } : {}) },
    expires_at: new Date(effective).toISOString(),
    issued_by: params.issuedBy?.trim() || resolveRole() || 'unknown',
    issued_at: new Date(now).toISOString(),
  };
  appendGrantRecord(grant);
  recordGrantAudit({
    action: TASK_GRANT_ISSUED_EVENT,
    grant_id: grant.grant_id,
    grantee_nhi_id: grant.grantee_nhi_id,
    audience: grant.audience,
    context: 'task-scoped-grants.issueTaskGrant',
    result: 'allowed',
  });
  return grant;
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

/**
 * Governed. Revoke a single grant. Idempotent: revoking an already-revoked
 * grant returns it unchanged; an unknown grant_id returns `null`.
 */
export function revokeTaskGrant(grantId: string, reason: string): TaskScopedGrant | null {
  assertTaskGrantGovernedContext('revokeTaskGrant');
  const existing = readGrantRecords().get(grantId);
  if (!existing) return null;
  if (existing.revoked_at) return existing;
  const revoked: TaskScopedGrant = {
    ...existing,
    revoked_at: new Date().toISOString(),
    revoke_reason: reason,
  };
  appendGrantRecord(revoked);
  recordGrantAudit({
    action: TASK_GRANT_REVOKED_EVENT,
    grant_id: revoked.grant_id,
    grantee_nhi_id: revoked.grantee_nhi_id,
    audience: revoked.audience,
    context: 'task-scoped-grants.revokeTaskGrant',
    result: 'allowed',
    reason,
  });
  return revoked;
}

/**
 * Governed. Revoke every unrevoked grant whose audience is exactly this
 * mission/task pair (mission-wide grants — no `task_id` — are NOT touched by
 * a task's completion). Returns the revoked grants. This is the normal-path
 * cleanup at task completion/failure; anything it misses dies via lazy expiry.
 */
export function revokeGrantsForTask(
  missionId: string,
  taskId: string,
  reason: string
): TaskScopedGrant[] {
  assertTaskGrantGovernedContext('revokeGrantsForTask');
  const revoked: TaskScopedGrant[] = [];
  for (const grant of readGrantRecords().values()) {
    if (grant.revoked_at) continue;
    if (grant.audience.mission_id !== missionId) continue;
    if (grant.audience.task_id !== taskId) continue;
    const record: TaskScopedGrant = {
      ...grant,
      revoked_at: new Date().toISOString(),
      revoke_reason: reason,
    };
    appendGrantRecord(record);
    recordGrantAudit({
      action: TASK_GRANT_REVOKED_EVENT,
      grant_id: record.grant_id,
      grantee_nhi_id: record.grantee_nhi_id,
      audience: record.audience,
      context: 'task-scoped-grants.revokeGrantsForTask',
      result: 'allowed',
      reason,
    });
    revoked.push(record);
  }
  return revoked;
}

// ---------------------------------------------------------------------------
// Read / resolve (ungated)
// ---------------------------------------------------------------------------

export interface ListActiveGrantsFilter {
  granteeNhiId?: string;
  missionId?: string;
  taskId?: string;
  /** Clock override for deterministic expiry tests. */
  now?: number;
}

/** Read-only, ungated: unrevoked, unexpired grants, oldest-issued first. */
export function listActiveGrants(filter?: ListActiveGrantsFilter): TaskScopedGrant[] {
  const now = filter?.now ?? Date.now();
  const results: TaskScopedGrant[] = [];
  for (const grant of readGrantRecords().values()) {
    if (grant.revoked_at) continue;
    if (Date.parse(grant.expires_at) <= now) continue;
    if (filter?.granteeNhiId && grant.grantee_nhi_id !== filter.granteeNhiId) continue;
    if (filter?.missionId && grant.audience.mission_id !== filter.missionId) continue;
    if (filter?.taskId && grant.audience.task_id !== filter.taskId) continue;
    results.push(grant);
  }
  return results.sort((a, b) => a.issued_at.localeCompare(b.issued_at));
}

export interface ResolveGrantsForActorOptions {
  /** Clock override for deterministic expiry tests. */
  now?: number;
}

/**
 * Read-only, ungated. Serve the actor's grants for the REQUESTING execution
 * context's audience — the RFC 8707 check (module doc): a grant is served
 * only when
 *   - `grantee_nhi_id` is this actor, AND
 *   - `audience.mission_id` equals the requesting mission, AND
 *   - `audience.task_id`, when the grant names one, equals the requesting
 *     task (a mission-wide grant matches any/no task; a task-bound grant is
 *     NEVER served without the matching task context), AND
 *   - `now < expires_at` (lazy expiry), AND
 *   - the grant is not revoked.
 *
 * A live (unrevoked, unexpired) grant of this actor whose audience does NOT
 * match the requesting context is an attempted out-of-audience use: it is
 * audit-recorded as {@link TASK_GRANT_DENIED_EVENT} and contributes nothing.
 * Expired/revoked grants are silently skipped (they were never usable).
 */
export function resolveGrantsForActor(
  nhiId: string,
  audience: { missionId: string; taskId?: string },
  options?: ResolveGrantsForActorOptions
): TaskScopedGrant[] {
  const now = options?.now ?? Date.now();
  const served: TaskScopedGrant[] = [];
  for (const grant of readGrantRecords().values()) {
    if (grant.grantee_nhi_id !== nhiId) continue;
    if (grant.revoked_at) continue;
    if (Date.parse(grant.expires_at) <= now) continue;
    const missionMatch = grant.audience.mission_id === audience.missionId;
    const taskMatch =
      grant.audience.task_id === undefined || grant.audience.task_id === audience.taskId;
    if (!missionMatch || !taskMatch) {
      recordGrantAudit({
        action: TASK_GRANT_DENIED_EVENT,
        grant_id: grant.grant_id,
        grantee_nhi_id: grant.grantee_nhi_id,
        audience: grant.audience,
        context: 'task-scoped-grants.resolveGrantsForActor',
        result: 'denied',
        reason:
          `audience mismatch: grant is bound to ${JSON.stringify(grant.audience)}, ` +
          `requested {mission_id:${audience.missionId},task_id:${audience.taskId ?? '<none>'}}`,
      });
      continue;
    }
    served.push(grant);
  }
  return served.sort((a, b) => a.issued_at.localeCompare(b.issued_at));
}

// ---------------------------------------------------------------------------
// Best-effort wrappers (dispatch wiring seams — never throw)
// ---------------------------------------------------------------------------

/** Best-effort issue for dispatch wiring: never throws, logs and returns null on failure. */
export function issueTaskGrantBestEffort(params: IssueTaskGrantParams): TaskScopedGrant | null {
  try {
    return issueTaskGrant(params);
  } catch (error) {
    logger.warn(
      `[task-scoped-grants] best-effort issue for ${params.granteeNhiId} ` +
        `(mission ${params.audience.missionId}, task ${params.audience.taskId ?? '<none>'}) ` +
        `did not reach the store: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/** Best-effort task-completion revoke: never throws, returns the number of grants revoked. */
export function revokeGrantsForTaskBestEffort(
  missionId: string,
  taskId: string,
  reason: string
): number {
  try {
    return revokeGrantsForTask(missionId, taskId, reason).length;
  } catch (error) {
    logger.warn(
      `[task-scoped-grants] best-effort revoke for mission ${missionId} task ${taskId} failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return 0;
  }
}
