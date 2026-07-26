/**
 * NI-02: shared NHI actor-verification seam.
 *
 * Before this module, `owner_actor` (orchestrator-session) and
 * `actorPeerId`/`holder_peer_id` (work-coordination) were unverified free
 * strings — the lease exclusivity worked, but nothing checked *who or what*
 * holds the lease. This seam connects those actor strings to the NI-01
 * durable AgentIdentity registry (`agent-identity.ts`) with the same staged
 * warn → enforce rollout AA-03 used for A2A signatures:
 *
 *   - `KYBERION_NHI_ACTOR=off`     — no-op (no registry read, no audit).
 *     Needed by hermetic tests that neither repoint the identity journal nor
 *     care about actor identity.
 *   - `KYBERION_NHI_ACTOR=warn`    — DEFAULT. Violations (unregistered /
 *     retired / suspended / malformed actors) are recorded to the audit
 *     chain and allowed through. Behavior of every existing call site is
 *     unchanged.
 *   - `KYBERION_NHI_ACTOR=enforce` — violations throw
 *     {@link NhiActorPolicyError}. Switching to enforce is an observed,
 *     standalone-commit decision (plan §3.6), never a side effect.
 *
 * Verdict semantics:
 *   - Actor strings that look like an nhi_id (`kyberion://agent/...`) are
 *     parsed and looked up in the registry: `registered` (provisioned or
 *     active), `suspended`, `retired`, or `unregistered` (valid grammar, no
 *     ledger record). Grammar-invalid `kyberion://agent/...` strings and
 *     blank actors are `malformed`.
 *   - Legacy non-nhi actor strings (peer ids like 'orchestrator', surface
 *     actors, 'user:<id>') are `unregistered` — surfaced in warn mode so the
 *     migration to nhi actors is observable, not silently grandfathered.
 *
 * Hot-path cost: registry reads re-project the whole identity journal per
 * call (NI-01's deliberate no-cross-process-stale-cache rule for governance
 * decisions). That freshness rule protects WRITE-path decisions; this seam
 * is an advisory READ on hot paths (every claim / session create), so it
 * memoizes per-actor verdicts with a short explicit TTL
 * ({@link NHI_ACTOR_VERDICT_TTL_MS}, ~2s). Worst case a retire is honored
 * ~2s late here — the governed write paths in agent-identity.ts themselves
 * never use this cache.
 */

import { logger } from './core.js';
import { auditChain } from './audit-chain.js';
import { getAgentIdentity, NHI_ID_PREFIX, parseNhiId } from './agent-identity.js';

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

export type NhiActorMode = 'off' | 'warn' | 'enforce';

/** Staged rollout switch. Default `warn`; unknown values degrade to `warn`. */
export function resolveNhiActorMode(): NhiActorMode {
  const raw = process.env.KYBERION_NHI_ACTOR?.trim();
  if (raw === 'off' || raw === 'enforce') return raw;
  return 'warn';
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type NhiActorVerdict = 'registered' | 'unregistered' | 'retired' | 'suspended' | 'malformed';

export interface VerifyNhiActorResult {
  verdict: NhiActorVerdict;
  /** Present when the actor string parses as a canonical nhi_id. */
  nhi_id?: string;
}

/**
 * Per-actor verdict memoization TTL. Explicit and short: this bounds how
 * long a just-retired/suspended identity can still read as its previous
 * status on advisory hot paths (see module doc for why this is safe).
 */
export const NHI_ACTOR_VERDICT_TTL_MS = 2_000;

const verdictCache = new Map<string, { result: VerifyNhiActorResult; expiresAt: number }>();

/** Test hook: drop all memoized verdicts (e.g. after retiring an identity mid-test). */
export function clearNhiActorVerificationCache(): void {
  verdictCache.clear();
}

/**
 * Classify an actor string against the NI-01 identity registry.
 * Read-only and never throws; registry lookups are memoized for
 * {@link NHI_ACTOR_VERDICT_TTL_MS}.
 */
export function verifyNhiActor(actor: string): VerifyNhiActorResult {
  const trimmed = typeof actor === 'string' ? actor.trim() : '';
  if (!trimmed) return { verdict: 'malformed' };

  const cached = verdictCache.get(trimmed);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const result = computeVerdict(trimmed);
  verdictCache.set(trimmed, { result, expiresAt: Date.now() + NHI_ACTOR_VERDICT_TTL_MS });
  return result;
}

function computeVerdict(actor: string): VerifyNhiActorResult {
  if (!actor.startsWith(NHI_ID_PREFIX)) {
    // Legacy peer id / surface actor / 'user:<id>' — not an NHI claim.
    return { verdict: 'unregistered' };
  }
  const parsed = parseNhiId(actor);
  if (!parsed) return { verdict: 'malformed' };
  try {
    const record = getAgentIdentity(actor);
    if (!record) return { verdict: 'unregistered', nhi_id: actor };
    if (record.lifecycle_status === 'retired') return { verdict: 'retired', nhi_id: actor };
    if (record.lifecycle_status === 'suspended') return { verdict: 'suspended', nhi_id: actor };
    return { verdict: 'registered', nhi_id: actor };
  } catch (error) {
    // A registry read failure must never take down a claim path — treat as
    // unregistered (surfaced in warn mode) rather than failing the caller.
    logger.warn(
      `[nhi-actor] registry lookup for ${actor} failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { verdict: 'unregistered', nhi_id: actor };
  }
}

// ---------------------------------------------------------------------------
// Policy enforcement
// ---------------------------------------------------------------------------

/** Audit-chain action for unregistered/malformed actors (warn: allowed; enforce: denied). */
export const NHI_ACTOR_UNREGISTERED_EVENT = 'nhi_actor_unregistered';
/** Audit-chain action for retired/suspended identities acting (warn: allowed; enforce: denied). */
export const NHI_ACTOR_INACTIVE_EVENT = 'nhi_actor_inactive';

export class NhiActorPolicyError extends Error {
  constructor(
    public readonly actor: string,
    public readonly verdict: NhiActorVerdict,
    public readonly context: string
  ) {
    super(
      `[nhi-actor] actor "${actor}" rejected at ${context}: verdict=${verdict} ` +
        `(KYBERION_NHI_ACTOR=enforce). Register the identity in the NI-01 agent-identity ` +
        `ledger (issueAgentIdentity) or use a registered nhi_id.`
    );
    this.name = 'NhiActorPolicyError';
  }
}

export interface NhiActorPolicyOutcome {
  mode: NhiActorMode;
  /** Unset in `off` mode (no verification performed). */
  result?: VerifyNhiActorResult;
  violation: boolean;
}

export interface NhiActorAuditEvent {
  action: typeof NHI_ACTOR_UNREGISTERED_EVENT | typeof NHI_ACTOR_INACTIVE_EVENT;
  actor: string;
  verdict: NhiActorVerdict;
  context: string;
  result: 'allowed' | 'denied';
}

type NhiActorAuditSink = (event: NhiActorAuditEvent) => void;

/**
 * Injectable audit sink (hermetic-test seam). `null` restores the default.
 *
 * Default sink discipline: real runs append to the shared audit chain; under
 * vitest WITHOUT an injected sink the default sink is a no-op, because the
 * audit chain writes to the real `active/shared/logs/audit/` tree and has no
 * repoint hook — the same "tests never write the real active/ tree" contract
 * as agent-identity.ts's journal guard. Tests that want to observe audit
 * events inject a sink here.
 */
let auditSinkOverride: NhiActorAuditSink | null = null;

export function setNhiActorAuditSinkForTests(sink: NhiActorAuditSink | null): void {
  auditSinkOverride = sink;
}

function recordViolationAudit(event: NhiActorAuditEvent): void {
  // Best-effort by contract: an audit failure must never take down the
  // claim/session path it is observing (warn mode must be behaviorally
  // identical to pre-NI-02).
  try {
    if (auditSinkOverride) {
      auditSinkOverride(event);
      return;
    }
    if (process.env.VITEST) return; // hermetic guard — see setNhiActorAuditSinkForTests
    auditChain.record({
      agentId: event.actor,
      action: event.action,
      operation: event.context,
      result: event.result,
      reason: `NHI actor verdict '${event.verdict}' for "${event.actor}" at ${event.context}`,
      metadata: {
        verdict: event.verdict,
        ...(event.verdict !== 'malformed' && event.actor.startsWith(NHI_ID_PREFIX)
          ? { nhi_id: event.actor }
          : {}),
      },
    });
  } catch (error) {
    logger.warn(
      `[nhi-actor] audit append failed (best-effort): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Verify `actor` and apply the staged KYBERION_NHI_ACTOR policy.
 *
 * - `off`: returns immediately — no registry read, no audit.
 * - `warn` (default): violations are audit-recorded
 *   ({@link NHI_ACTOR_UNREGISTERED_EVENT} / {@link NHI_ACTOR_INACTIVE_EVENT})
 *   and allowed through unchanged.
 * - `enforce`: violations are audit-recorded as denied and throw
 *   {@link NhiActorPolicyError}.
 *
 * `context` names the guarded call site (e.g.
 * 'work-coordination.claimWorkItem') and lands in the audit operation field.
 */
export function enforceNhiActorPolicy(actor: string, context: string): NhiActorPolicyOutcome {
  const mode = resolveNhiActorMode();
  if (mode === 'off') return { mode, violation: false };

  const result = verifyNhiActor(actor);
  if (result.verdict === 'registered') return { mode, result, violation: false };

  const action =
    result.verdict === 'retired' || result.verdict === 'suspended'
      ? NHI_ACTOR_INACTIVE_EVENT
      : NHI_ACTOR_UNREGISTERED_EVENT;

  recordViolationAudit({
    action,
    actor,
    verdict: result.verdict,
    context,
    result: mode === 'enforce' ? 'denied' : 'allowed',
  });

  if (mode === 'enforce') {
    throw new NhiActorPolicyError(actor, result.verdict, context);
  }
  return { mode, result, violation: true };
}
