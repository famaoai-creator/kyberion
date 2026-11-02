/**
 * mission-lease.ts — bounded PoC porting Mastra's agent-controller thread-lease
 * semantics into Kyberion's claim-holding model.
 *
 * Mastra's `LeaseProvider` (`@mastra/core` `events/pubsub.ts`) coordinates a
 * single owner per resource across processes: `acquireLease(key, owner, ttl)`
 * is atomic and idempotent for the same owner, `renewLease` is owner-guarded,
 * `releaseLease` is a no-op for non-owners, and a contender that loses is
 * told the current `owner` so it can park as a *follower* — follower sessions
 * mirror state but cannot drive the thread until the lease lapses
 * (`thread-lease-lost`, `session-run-engine.ts`). This module keeps the same
 * shape in-process:
 *
 *   Mastra                          → here
 *   key (thread key)                → resource
 *   owner                           → holder
 *   acquireLease / renew / release  → acquireLease / renewLease / releaseLease
 *   follower parked while held      → registered contender, derived 'suspended'
 *   durable thread record           → per-resource tombstone + monotonic fence
 *
 * Vocabulary deliberately matches the existing claim model (`WorkLease`
 * holder/status/expires_at, `FencedWriterLease` resource_id/fence/expires_at_ms,
 * `CoSessionPathLease` active|released|expired).
 *
 * PoC bounds: in-memory only. No timers (time is an injected `now` in ms), no
 * I/O, no mission-state mutation, no inter-process fencing — durability stays
 * with `writer-lease.ts` and work-coordination. Expiry is lazy: it is evaluated
 * from `expires_at_ms <= now` at each call, so a lapsed lease frees the
 * resource (and unsuspends its followers) on the next op.
 *
 * Validation is collect-all: every op returns a result carrying `issues`
 * with stable `LEASE_*` codes rather than throwing on the first violation,
 * so callers (and tests) can enumerate everything wrong with one call.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Stable machine-readable rejection codes. */
export type MissionLeaseErrorCode =
  /** Malformed input (blank resource/holder/leaseId, non-positive ttlMs/extendMs, non-finite now). */
  | 'LEASE_INVALID_ARGUMENT'
  /** Acquire by a non-holder while the resource is under a live lease — the contender is suspended. */
  | 'LEASE_SUSPENDED'
  /** Unknown lease id, or `suspendFollowers` on a resource with no live lease. */
  | 'LEASE_NOT_FOUND'
  /** The supplied holder does not own the lease (renew/release). */
  | 'LEASE_NOT_HOLDER'
  /** The lease is past `expires_at_ms` at the supplied `now` (renew only — release of a lapsed lease is an allowed no-op finalize). */
  | 'LEASE_EXPIRED'
  /** The lease was explicitly released already. */
  | 'LEASE_RELEASED'
  /** The lease is no longer the resource's current generation — a newer holder took over. */
  | 'LEASE_SUPERSEDED';

export interface MissionLeaseIssue {
  code: MissionLeaseErrorCode;
  message: string;
}

export type MissionLeaseStatus = 'active' | 'released' | 'expired';
/** 'suspended' while a live lease is held by another holder; 'unsuspended' once the resource frees. */
export type MissionFollowerStatus = 'suspended' | 'unsuspended';

/**
 * Public lease record. `status` is the lazily-evaluated effective status at
 * the `now` the record was read with — a stored 'active' lease past its
 * `expires_at_ms` reads back 'expired' (thread persistence: the tombstone is
 * kept, never deleted, so `getLease` still answers for dead lease ids).
 */
export interface MissionLease {
  lease_id: string;
  resource_id: string;
  holder: string;
  /** Monotonic per-resource generation; survives release/expiry (takeover ordering). */
  fence: number;
  status: MissionLeaseStatus;
  acquired_at_ms: number;
  expires_at_ms: number;
  renewed_at_ms: number;
  renew_count: number;
  released_at_ms?: number;
}

export interface MissionLeaseFollower {
  holder: string;
  status: MissionFollowerStatus;
  /** `now` of the first acquire attempt that was suspended (or explicit suspend). */
  contended_at_ms: number;
}

export interface AcquireMissionLeaseInput {
  resource: string;
  holder: string;
  ttlMs: number;
  now: number;
}

export interface RenewMissionLeaseInput {
  leaseId: string;
  /** Renewal is holder-guarded — supply the caller's holder id. */
  holder: string;
  /** Fresh TTL: on success `expires_at_ms = now + extendMs` (never extends a lapsed lease). */
  extendMs: number;
  now: number;
}

export interface ReleaseMissionLeaseInput {
  leaseId: string;
  holder: string;
  now: number;
}

export interface SuspendFollowersInput {
  resource: string;
  now: number;
  /**
   * Explicit followers to park as contenders. Omit to re-assert suspension on
   * the resource's already-registered contenders (what acquire applies
   * implicitly when a holder takes the lease).
   */
  followers?: string[];
}

export interface AcquireMissionLeaseResult {
  ok: boolean;
  /** The acquired lease, the idempotently-held lease, or (on LEASE_SUSPENDED) the blocking lease — for routing to the owner. */
  lease?: MissionLease;
  /** Contenders left suspended under the new holder (acquire success only). */
  suspended_followers?: string[];
  issues: MissionLeaseIssue[];
}

export interface RenewMissionLeaseResult {
  ok: boolean;
  lease?: MissionLease;
  issues: MissionLeaseIssue[];
}

export interface ReleaseMissionLeaseResult {
  ok: boolean;
  lease?: MissionLease;
  issues: MissionLeaseIssue[];
}

export interface SuspendFollowersResult {
  ok: boolean;
  suspended: string[];
  issues: MissionLeaseIssue[];
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface StoredLease {
  lease_id: string;
  resource_id: string;
  holder: string;
  fence: number;
  /** Stored status; 'expired' is derived, never stored. */
  status: 'active' | 'released';
  acquired_at_ms: number;
  expires_at_ms: number;
  renewed_at_ms: number;
  renew_count: number;
  released_at_ms?: number;
}

/** Per-resource durable slot — the "thread" whose record outlives any lease. */
interface ResourceLeaseSlot {
  /** Monotonic generation, incremented on every successful takeover. */
  fence: number;
  /** Latest lease id for the resource (tombstone). */
  lease_id?: string;
  /** Registered contenders: holder -> `now` of first suspended contention. */
  contenders: Map<string, number>;
}

function issue(code: MissionLeaseErrorCode, message: string): MissionLeaseIssue {
  return { code, message };
}

/** A lease is live only while stored 'active' and not yet at its deadline. */
function isLive(lease: StoredLease | undefined, now: number): lease is StoredLease {
  return Boolean(lease && lease.status === 'active' && lease.expires_at_ms > now);
}

function toPublic(lease: StoredLease, now: number): MissionLease {
  const status: MissionLeaseStatus =
    lease.status === 'active' && lease.expires_at_ms <= now ? 'expired' : lease.status;
  return { ...lease, status };
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * Pure in-memory lease manager. One instance = one lease namespace; tests
 * create a fresh manager per case, so state is hermetic by construction.
 */
export class MissionLeaseManager {
  private readonly leases = new Map<string, StoredLease>();
  private readonly resources = new Map<string, ResourceLeaseSlot>();

  private slot(resourceId: string, create = false): ResourceLeaseSlot | undefined {
    let state = this.resources.get(resourceId);
    if (!state && create) {
      state = { fence: 0, contenders: new Map() };
      this.resources.set(resourceId, state);
    }
    return state;
  }

  private liveLeaseOf(state: ResourceLeaseSlot | undefined, now: number): StoredLease | undefined {
    const lease = state?.lease_id ? this.leases.get(state.lease_id) : undefined;
    return isLive(lease, now) ? lease : undefined;
  }

  /** Suspended contenders under `live` — every registered contender but the holder. */
  private suspendedUnder(state: ResourceLeaseSlot, live: StoredLease): string[] {
    return [...state.contenders.keys()].filter((holder) => holder !== live.holder);
  }

  /**
   * Acquire a TTL-bound lease on `resource` for `holder`.
   *
   * - Free resource (none / expired / released): creates the next-fence lease
   *   and leaves every other registered contender suspended under the new
   *   holder (the `suspendFollowers` transition).
   * - Live lease held by another holder: registers `holder` as a suspended
   *   contender and rejects with `LEASE_SUSPENDED`, echoing the blocking lease
   *   so the caller can route to the owner.
   * - Live lease held by the same holder: idempotent success (Mastra parity).
   */
  acquireLease(input: AcquireMissionLeaseInput): AcquireMissionLeaseResult {
    const issues: MissionLeaseIssue[] = [];
    const resource = typeof input.resource === 'string' ? input.resource.trim() : '';
    const holder = typeof input.holder === 'string' ? input.holder.trim() : '';
    if (!resource) issues.push(issue('LEASE_INVALID_ARGUMENT', 'resource is required'));
    if (!holder) issues.push(issue('LEASE_INVALID_ARGUMENT', 'holder is required'));
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      issues.push(issue('LEASE_INVALID_ARGUMENT', 'ttlMs must be a positive finite number'));
    }
    if (!Number.isFinite(input.now)) {
      issues.push(issue('LEASE_INVALID_ARGUMENT', 'now must be a finite millisecond timestamp'));
    }
    if (Number.isFinite(input.now) && Number.isFinite(input.ttlMs)) {
      const deadline = input.now + input.ttlMs;
      if (!Number.isFinite(deadline) || deadline <= input.now) {
        issues.push(
          issue('LEASE_INVALID_ARGUMENT', 'computed expiry must be a finite instant after now')
        );
      }
    }
    if (issues.length) return { ok: false, issues };

    const state = this.slot(resource, true)!;
    const live = this.liveLeaseOf(state, input.now);
    if (live && live.holder !== holder) {
      // Follower suspension: losing contenders park until expiry/release.
      if (!state.contenders.has(holder)) state.contenders.set(holder, input.now);
      return {
        ok: false,
        lease: toPublic(live, input.now),
        issues: [
          issue(
            'LEASE_SUSPENDED',
            `resource '${resource}' is leased by '${live.holder}' until ${live.expires_at_ms}ms; contender '${holder}' suspended`
          ),
        ],
      };
    }
    if (live) {
      // Same-owner re-acquire is idempotent — the lease is not extended here.
      return { ok: true, lease: toPublic(live, input.now), issues: [] };
    }

    // Takeover: the fence survives tombstones, so ordering is observable.
    state.fence += 1;
    const stored: StoredLease = {
      lease_id: `lease-${resource}-${state.fence}`,
      resource_id: resource,
      holder,
      fence: state.fence,
      status: 'active',
      acquired_at_ms: input.now,
      expires_at_ms: input.now + input.ttlMs,
      renewed_at_ms: input.now,
      renew_count: 0,
    };
    this.leases.set(stored.lease_id, stored);
    state.lease_id = stored.lease_id;
    // The winner is the holder, no longer a contender; all other contenders
    // stay registered and are now suspended under this holder.
    state.contenders.delete(holder);
    return {
      ok: true,
      lease: toPublic(stored, input.now),
      suspended_followers: this.suspendedUnder(state, stored),
      issues: [],
    };
  }

  /**
   * Refresh a live lease's TTL (`expires_at_ms = now + extendMs`). Holder-only:
   * a non-holder renewal is `LEASE_NOT_HOLDER`; renewing a lapsed or released
   * lease is `LEASE_EXPIRED` / `LEASE_RELEASED`. All violations are collected.
   */
  renewLease(input: RenewMissionLeaseInput): RenewMissionLeaseResult {
    const issues: MissionLeaseIssue[] = [];
    const leaseId = typeof input.leaseId === 'string' ? input.leaseId.trim() : '';
    const holder = typeof input.holder === 'string' ? input.holder.trim() : '';
    if (!leaseId) issues.push(issue('LEASE_INVALID_ARGUMENT', 'leaseId is required'));
    if (!holder) issues.push(issue('LEASE_INVALID_ARGUMENT', 'holder is required'));
    if (!Number.isFinite(input.extendMs) || input.extendMs <= 0) {
      issues.push(issue('LEASE_INVALID_ARGUMENT', 'extendMs must be a positive finite number'));
    }
    if (!Number.isFinite(input.now)) {
      issues.push(issue('LEASE_INVALID_ARGUMENT', 'now must be a finite millisecond timestamp'));
    }
    if (Number.isFinite(input.now) && Number.isFinite(input.extendMs)) {
      const deadline = input.now + input.extendMs;
      if (!Number.isFinite(deadline) || deadline <= input.now) {
        issues.push(
          issue('LEASE_INVALID_ARGUMENT', 'computed expiry must be a finite instant after now')
        );
      }
    }
    if (issues.length) return { ok: false, issues };

    const stored = this.leases.get(leaseId);
    if (!stored) {
      return {
        ok: false,
        issues: [issue('LEASE_NOT_FOUND', `unknown lease_id '${leaseId}'`)],
      };
    }
    if (this.slot(stored.resource_id)?.lease_id !== leaseId) {
      issues.push(
        issue(
          'LEASE_SUPERSEDED',
          `lease '${leaseId}' is no longer the current generation for '${stored.resource_id}'`
        )
      );
    }
    if (stored.status === 'released') {
      issues.push(issue('LEASE_RELEASED', `lease '${leaseId}' was released`));
    } else if (stored.expires_at_ms <= input.now) {
      issues.push(
        issue(
          'LEASE_EXPIRED',
          `lease '${leaseId}' expired at ${stored.expires_at_ms}ms (now=${input.now}ms)`
        )
      );
    }
    if (stored.holder !== holder) {
      issues.push(
        issue(
          'LEASE_NOT_HOLDER',
          `lease '${leaseId}' is held by '${stored.holder}', not '${holder}'`
        )
      );
    }
    if (issues.length) return { ok: false, lease: toPublic(stored, input.now), issues };

    stored.expires_at_ms = input.now + input.extendMs;
    stored.renewed_at_ms = input.now;
    stored.renew_count += 1;
    return { ok: true, lease: toPublic(stored, input.now), issues: [] };
  }

  /**
   * Release a lease. Holder-guarded (`LEASE_NOT_HOLDER`), idempotent-ish:
   * an already-released lease reports `LEASE_RELEASED`; releasing a lease that
   * already lapsed is allowed and finalizes the tombstone (`released_at_ms`).
   */
  releaseLease(input: ReleaseMissionLeaseInput): ReleaseMissionLeaseResult {
    const issues: MissionLeaseIssue[] = [];
    const leaseId = typeof input.leaseId === 'string' ? input.leaseId.trim() : '';
    const holder = typeof input.holder === 'string' ? input.holder.trim() : '';
    if (!leaseId) issues.push(issue('LEASE_INVALID_ARGUMENT', 'leaseId is required'));
    if (!holder) issues.push(issue('LEASE_INVALID_ARGUMENT', 'holder is required'));
    if (!Number.isFinite(input.now)) {
      issues.push(issue('LEASE_INVALID_ARGUMENT', 'now must be a finite millisecond timestamp'));
    }
    if (issues.length) return { ok: false, issues };

    const stored = this.leases.get(leaseId);
    if (!stored) {
      return {
        ok: false,
        issues: [issue('LEASE_NOT_FOUND', `unknown lease_id '${leaseId}'`)],
      };
    }
    if (stored.status === 'released') {
      issues.push(issue('LEASE_RELEASED', `lease '${leaseId}' was already released`));
    }
    if (stored.holder !== holder) {
      issues.push(
        issue(
          'LEASE_NOT_HOLDER',
          `lease '${leaseId}' is held by '${stored.holder}', not '${holder}'`
        )
      );
    }
    if (issues.length) return { ok: false, lease: toPublic(stored, input.now), issues };

    if (stored.status === 'active') {
      stored.status = 'released';
      stored.released_at_ms = input.now;
    }
    return { ok: true, lease: toPublic(stored, input.now), issues: [] };
  }

  /**
   * The follower-suspension transition: park contenders on `resource` under
   * its live holder. Acquire applies this implicitly on every takeover; this
   * explicit op additionally registers `followers` as contenders and requires
   * a live lease (nothing holds the resource → `LEASE_NOT_FOUND`, since
   * followers cannot be suspended under nobody).
   */
  suspendFollowers(input: SuspendFollowersInput): SuspendFollowersResult {
    const issues: MissionLeaseIssue[] = [];
    const resource = typeof input.resource === 'string' ? input.resource.trim() : '';
    if (!resource) issues.push(issue('LEASE_INVALID_ARGUMENT', 'resource is required'));
    if (!Number.isFinite(input.now)) {
      issues.push(issue('LEASE_INVALID_ARGUMENT', 'now must be a finite millisecond timestamp'));
    }
    const followers = input.followers ?? [];
    for (const follower of followers) {
      if (typeof follower !== 'string' || !follower.trim()) {
        issues.push(issue('LEASE_INVALID_ARGUMENT', 'followers must be non-empty holder ids'));
        break;
      }
    }
    if (issues.length) return { ok: false, suspended: [], issues };

    const state = this.slot(resource);
    const live = this.liveLeaseOf(state, input.now);
    if (!state || !live) {
      return {
        ok: false,
        suspended: [],
        issues: [
          issue(
            'LEASE_NOT_FOUND',
            `no live lease on resource '${resource}'; no holder to suspend followers under`
          ),
        ],
      };
    }
    for (const follower of followers) {
      const id = follower.trim();
      // The holder is never its own follower; skip without an issue.
      if (id !== live.holder && !state.contenders.has(id)) {
        state.contenders.set(id, input.now);
      }
    }
    return { ok: true, suspended: this.suspendedUnder(state, live), issues: [] };
  }

  // --- introspection (pure reads; `now` only derives lazy status) -----------

  /** Read a lease by id with lazily-evaluated status; tombstones included. */
  getLease(leaseId: string, now: number): MissionLease | undefined {
    const stored = this.leases.get(leaseId);
    return stored ? toPublic(stored, now) : undefined;
  }

  /** Latest lease for a resource (the surviving tombstone), lazily evaluated. */
  getResourceLease(resource: string, now: number): MissionLease | undefined {
    const state = this.slot(resource);
    const stored = state?.lease_id ? this.leases.get(state.lease_id) : undefined;
    return stored ? toPublic(stored, now) : undefined;
  }

  /** Mastra `getLeaseOwner` parity: live holder, or undefined when free. */
  getHolder(resource: string, now: number): string | undefined {
    return this.liveLeaseOf(this.slot(resource), now)?.holder;
  }

  /**
   * Registered contenders in contention order. Status is derived: 'suspended'
   * while a live lease is held by another holder, 'unsuspended' once the
   * resource frees (expiry/release unsuspends — the registry itself persists,
   * so a later takeover re-suspends them under the new holder).
   */
  listFollowers(resource: string, now: number): MissionLeaseFollower[] {
    const state = this.slot(resource);
    if (!state) return [];
    const live = this.liveLeaseOf(state, now);
    return [...state.contenders.entries()]
      .filter(([holder]) => holder !== live?.holder)
      .map(([holder, contended_at_ms]) => ({
        holder,
        status: live ? 'suspended' : 'unsuspended',
        contended_at_ms,
      }));
  }

  /** Whether `holder` is a suspended follower on `resource` at `now`. */
  isSuspended(resource: string, holder: string, now: number): boolean {
    return this.listFollowers(resource, now).some(
      (follower) => follower.holder === holder && follower.status === 'suspended'
    );
  }
}

/** Fresh, isolated manager — the test/determinism seam (no globals, no clocks). */
export function createMissionLeaseManager(): MissionLeaseManager {
  return new MissionLeaseManager();
}
