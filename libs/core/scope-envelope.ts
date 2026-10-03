import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { TierLevel } from './types.js';
import {
  normalizeScopeContext,
  validateScopeContext,
  type ScopeContext,
  type ScopeContextInput,
} from './scope-context-validation.js';
import { resolveScopeContext, resolveScopeResolution } from './scope-context.js';
import { tryResolveOwnerScope, SHARED_TENANT, type OwnerRef } from './owner-scope.js';
import type { ContextSecurityScope } from './context-security-scope.js';

/**
 * SC-01: the two-layer scope envelope the runtime mints at dispatch
 * boundaries.
 *
 * - `identity` is a ScopeContext snapshot of the canonical context chain
 *   (tenant → organization → project → mission → task → session). It is
 *   derived from authenticated runtime sources (scope env / mission record /
 *   work-item claim via owner-scope resolution), never assembled from caller
 *   input. Governance records store it as an immutable snapshot and verify it
 *   against the owner-scope resolver at read time.
 * - `policy` is the attenuable capability layer. Children may only narrow it
 *   (fewer read tiers, a write tier still inside read_tiers, tighter egress),
 *   never widen it — `narrowScopeEnvelope` is the only way a delegation gets
 *   a child envelope.
 *
 * Caller-supplied scope values are treated as narrow requests or consistency
 * checks; they can never enlarge an envelope. There is no self-asserted
 * `stamped_by` field — the mint ledger (`mint_ref`) is the trust anchor.
 */

export interface ScopePolicy {
  readonly read_tiers: readonly TierLevel[];
  write_tier: TierLevel;
  purpose: string;
  external_egress?: 'deny' | 'allow';
  readonly allowed_reasoning_backends?: readonly string[];
}

export interface ScopeEnvelope {
  identity: ScopeContext;
  policy: ScopePolicy;
  minted_at: string;
  /** Handle into the runtime mint ledger — the trust anchor for the envelope. */
  mint_ref: string;
}

export interface ScopePolicyInput {
  read_tiers?: readonly TierLevel[];
  write_tier?: TierLevel;
  purpose: string;
  external_egress?: 'deny' | 'allow';
  allowed_reasoning_backends?: readonly string[];
}

export interface ScopeMintInput {
  /**
   * Identity fields the dispatch boundary already knows (work-item claim,
   * task issue, delegated session). These merge with — and may never
   * contradict — the runtime-resolved process scope.
   */
  identity?: ScopeContextInput;
  policy: ScopePolicyInput;
  env?: NodeJS.ProcessEnv;
}

export interface ScopeNarrowRequest {
  identity?: ScopeContextInput;
  policy?: Partial<ScopePolicy>;
}

const TIER_RANK: Record<TierLevel, number> = { public: 0, confidential: 1, personal: 2 };
const TIERS_BY_RANK: TierLevel[] = ['public', 'confidential', 'personal'];

/** Mint ledger: mint_ref → the envelope as issued. Module-local, runtime-owned. */
const mintLedger = new Map<string, ScopeEnvelope>();

const ENVELOPE_STORAGE_KEY = '__kyberion_scope_envelope_storage__';
const envelopeStorage: AsyncLocalStorage<ScopeEnvelope> =
  ((globalThis as Record<string, unknown>)[
    ENVELOPE_STORAGE_KEY
  ] as AsyncLocalStorage<ScopeEnvelope>) ??
  (((globalThis as Record<string, unknown>)[ENVELOPE_STORAGE_KEY] =
    new AsyncLocalStorage<ScopeEnvelope>()) as AsyncLocalStorage<ScopeEnvelope>);

let missingEnvelopeCount = 0;
const missingEnvelopeOps = new Set<string>();

function freezeEnvelope(identity: ScopeContext, policy: ScopePolicy): ScopeEnvelope {
  const envelope: ScopeEnvelope = {
    identity: Object.freeze({ ...identity }),
    policy: Object.freeze({
      ...policy,
      read_tiers: Object.freeze([...policy.read_tiers]),
      ...(policy.allowed_reasoning_backends
        ? { allowed_reasoning_backends: Object.freeze([...policy.allowed_reasoning_backends]) }
        : {}),
    }),
    minted_at: new Date().toISOString(),
    mint_ref: randomUUID(),
  };
  mintLedger.set(envelope.mint_ref, envelope);
  return envelope;
}

function validatePolicy(policy: ScopePolicy): string[] {
  const errors: string[] = [];
  if (!Array.isArray(policy.read_tiers) || policy.read_tiers.length === 0) {
    errors.push('policy.read_tiers must contain at least one tier');
  } else if (policy.read_tiers.some((tier) => !(tier in TIER_RANK))) {
    errors.push('policy.read_tiers contains an unknown tier');
  }
  if (!(policy.write_tier in TIER_RANK)) errors.push('policy.write_tier must be a known tier');
  else if (!policy.read_tiers?.includes(policy.write_tier)) {
    errors.push('policy.write_tier must be included in policy.read_tiers');
  }
  if (!policy.purpose?.trim()) errors.push('policy.purpose is required');
  if (
    policy.external_egress !== undefined &&
    policy.external_egress !== 'deny' &&
    policy.external_egress !== 'allow'
  ) {
    errors.push("policy.external_egress must be 'deny' or 'allow'");
  }
  return errors;
}

const IDENTITY_FIELDS = [
  'tenant_slug',
  'organization_id',
  'project_id',
  'mission_id',
  'task_id',
  'session_id',
  'work_shape',
  'customer_stance',
] as const;

type IdentityField = (typeof IDENTITY_FIELDS)[number];

function identityValue(context: ScopeContext, field: IdentityField): string | undefined {
  return context[field] as string | undefined;
}

/**
 * Whether `child` only deepens `parent`'s identity: every field present in
 * both must be equal; fields absent in the parent may be added (deeper chain
 * is narrower, never wider).
 */
export function identityNarrowErrors(parent: ScopeContext, child: ScopeContext): string[] {
  const errors: string[] = [];
  for (const field of IDENTITY_FIELDS) {
    const parentValue = identityValue(parent, field);
    const childValue = identityValue(child, field);
    if (parentValue && childValue && parentValue !== childValue) {
      errors.push(`identity.${field} '${childValue}' contradicts minted '${parentValue}'`);
    }
  }
  if (TIER_RANK[child.tier] > TIER_RANK[parent.tier]) {
    errors.push(`identity.tier '${child.tier}' is above minted '${parent.tier}'`);
  }
  return errors;
}

const ANCHORED_FIELDS = ['tenant_slug', 'organization_id', 'project_id', 'mission_id'] as const;

/**
 * The top of the chain is never caller-declared. A child may deepen an
 * envelope (add task/session), but a tenant/org/project/mission the parent
 * lacks must be anchored by a mission record: otherwise a mission-less or
 * tenant-unbound parent could be narrowed into any tenant's identity.
 */
export function identityAnchorErrors(parent: ScopeContext, child: ScopeContext): string[] {
  const added = ANCHORED_FIELDS.filter(
    (field) => !identityValue(parent, field) && identityValue(child, field)
  );
  if (added.length === 0) return [];
  if (!child.mission_id) {
    return [`identity.${added[0]} cannot be added without a mission record anchor`];
  }
  const owner = tryResolveOwnerScope({ kind: 'mission', id: child.mission_id } as OwnerRef);
  if (!owner) {
    return [`identity.mission_id '${child.mission_id}' is not anchored to a mission record`];
  }
  const derived: Partial<Record<(typeof ANCHORED_FIELDS)[number], string | undefined>> = {
    tenant_slug: owner.tenant === SHARED_TENANT ? undefined : owner.tenant,
    organization_id: owner.organization_id,
    project_id: owner.project_id,
    mission_id: child.mission_id,
  };
  const errors: string[] = [];
  for (const field of added) {
    if (identityValue(child, field) !== derived[field]) {
      errors.push(
        `identity.${field} '${identityValue(child, field)}' contradicts the mission record`
      );
    }
  }
  return errors;
}

/**
 * Clamp a dispatch request's policy to what the process itself is authorized
 * for: tiers above the runtime tier are dropped and external egress is never
 * granted from a request. Returns null when nothing of the request survives.
 */
export function clampPolicyToRuntimeTier(
  policy: ScopePolicyInput,
  runtimeTier: TierLevel
): ScopePolicyInput | null {
  const ceiling = TIER_RANK[runtimeTier];
  const requested = policy.read_tiers ?? TIERS_BY_RANK.filter((tier) => TIER_RANK[tier] <= ceiling);
  const readTiers = requested.filter((tier) => TIER_RANK[tier] <= ceiling);
  if (readTiers.length === 0) return null;
  const requestedWrite = policy.write_tier ?? readTiers[readTiers.length - 1];
  const writeTier = readTiers.includes(requestedWrite)
    ? requestedWrite
    : readTiers[readTiers.length - 1];
  return {
    purpose: policy.purpose,
    read_tiers: readTiers,
    write_tier: writeTier,
    ...(policy.allowed_reasoning_backends
      ? { allowed_reasoning_backends: [...policy.allowed_reasoning_backends] }
      : {}),
  };
}

/**
 * Whether `request` narrows `parent`'s policy. Pure validation — mints
 * nothing, so preflight can check a caller-provided envelope without issuing
 * a child envelope.
 */
export function policyNarrowErrors(parent: ScopePolicy, request: Partial<ScopePolicy>): string[] {
  const errors: string[] = [];
  if (
    request.read_tiers !== undefined &&
    request.read_tiers.some((tier) => !parent.read_tiers.includes(tier))
  ) {
    errors.push('policy.read_tiers may not widen beyond the minted envelope');
  }
  const childReadTiers =
    request.read_tiers !== undefined
      ? request.read_tiers.filter((tier) => parent.read_tiers.includes(tier))
      : [...parent.read_tiers];
  if (request.read_tiers !== undefined && childReadTiers.length === 0) {
    errors.push('policy.read_tiers narrowed to empty');
  }
  const writeTier = request.write_tier ?? parent.write_tier;
  if (request.write_tier !== undefined && !parent.read_tiers.includes(writeTier)) {
    errors.push('policy.write_tier widened beyond the minted envelope');
  } else if (childReadTiers.length > 0 && !childReadTiers.includes(writeTier)) {
    errors.push('policy.write_tier must stay inside narrowed read_tiers');
  }
  const parentEgress = parent.external_egress ?? 'deny';
  if (request.external_egress === 'allow' && parentEgress !== 'allow') {
    errors.push('policy.external_egress may not be widened to allow');
  }
  if (
    request.allowed_reasoning_backends !== undefined &&
    parent.allowed_reasoning_backends !== undefined &&
    request.allowed_reasoning_backends.some(
      (backend) => !parent.allowed_reasoning_backends!.includes(backend)
    )
  ) {
    errors.push('policy.allowed_reasoning_backends may not widen');
  }
  return errors;
}

/** Build the child policy from a narrow request (caller checks errors first). */
function narrowedPolicy(parent: ScopePolicy, request: Partial<ScopePolicy>): ScopePolicy {
  const childReadTiers =
    request.read_tiers !== undefined
      ? request.read_tiers.filter((tier) => parent.read_tiers.includes(tier))
      : [...parent.read_tiers];
  return {
    read_tiers: childReadTiers,
    write_tier: request.write_tier ?? parent.write_tier,
    purpose: request.purpose?.trim() || parent.purpose,
    ...(request.external_egress !== undefined || parent.external_egress !== undefined
      ? { external_egress: request.external_egress ?? parent.external_egress }
      : {}),
    ...(parent.allowed_reasoning_backends || request.allowed_reasoning_backends
      ? {
          allowed_reasoning_backends: [
            ...(request.allowed_reasoning_backends ?? parent.allowed_reasoning_backends ?? []),
          ],
        }
      : {}),
  };
}

/**
 * Mint a scope envelope from authenticated runtime sources. Callable only at
 * dispatch boundaries (mission task issue, worker spawn, pipeline runner,
 * delegation) — the mint ledger, not a field on the envelope, is the trust
 * anchor.
 */
export function mintScopeEnvelope(input: ScopeMintInput): ScopeEnvelope {
  const env = input.env ?? process.env;
  const runtimeScope = resolveScopeContext({}, env);
  const declared = normalizeScopeContext(input.identity ?? {});

  // Mission-derived scope beats the process scope for tenant/org/project —
  // a mission record is the authoritative owner of those fields.
  let ownerDerived: Partial<ScopeContext> = {};
  const missionId = declared.mission_id ?? runtimeScope.mission_id;
  if (missionId) {
    const owner = tryResolveOwnerScope({ kind: 'mission', id: missionId } as OwnerRef);
    if (owner) {
      ownerDerived = {
        tenant_slug: owner.tenant === SHARED_TENANT ? undefined : owner.tenant,
        organization_id: owner.organization_id,
        project_id: owner.project_id,
      };
    }
  }

  const identity = normalizeScopeContext({
    ...runtimeScope,
    ...ownerDerived,
    ...declared,
    tier: declared.tier ?? runtimeScope.tier ?? 'public',
  });

  // Contradictions between declared and derived identity are mint failures.
  const contradictions: string[] = [];
  for (const field of ['tenant_slug', 'organization_id', 'project_id', 'mission_id'] as const) {
    const declaredValue = declared[field];
    const derivedValue = ownerDerived[field];
    if (declaredValue && derivedValue && declaredValue !== derivedValue) {
      contradictions.push(
        `declared ${field} '${declaredValue}' contradicts mission record '${derivedValue}'`
      );
    }
    const runtimeValue = runtimeScope[field];
    if (declaredValue && runtimeValue && field === 'mission_id' && declaredValue !== runtimeValue) {
      contradictions.push(
        `declared mission_id '${declaredValue}' contradicts process scope '${runtimeValue}'`
      );
    }
  }
  if (contradictions.length > 0) {
    throw new Error(`[SCOPE_ENVELOPE_INVALID] ${contradictions.join('; ')}`);
  }

  // Mission-less work: session-bound envelope (G11). Unbound sessions get a
  // public-only, system-floor policy.
  const missionless = !identity.mission_id;
  if (missionless && !identity.session_id) {
    throw new Error('[SCOPE_ENVELOPE_INVALID] mission-less envelopes require session_id');
  }

  const scopeErrors = validateScopeContext(identity, {
    requireTenant: identity.tier !== 'public',
    requireMission: false,
    allowShared: true,
    allowSessionRoot: missionless,
  });
  if (scopeErrors.length > 0) {
    throw new Error(`[SCOPE_ENVELOPE_INVALID] ${scopeErrors.join('; ')}`);
  }

  const tenantBound = Boolean(identity.tenant_slug);
  const policy: ScopePolicy = {
    read_tiers:
      input.policy.read_tiers ??
      (missionless && !tenantBound
        ? ['public']
        : TIERS_BY_RANK.filter((tier) => TIER_RANK[tier] <= TIER_RANK[identity.tier])),
    write_tier: input.policy.write_tier ?? identity.tier,
    purpose: input.policy.purpose,
    ...(input.policy.external_egress !== undefined
      ? { external_egress: input.policy.external_egress }
      : {}),
    ...(input.policy.allowed_reasoning_backends
      ? { allowed_reasoning_backends: [...input.policy.allowed_reasoning_backends] }
      : {}),
  };
  const policyErrors = validatePolicy(policy);
  if (policyErrors.length > 0) {
    throw new Error(`[SCOPE_ENVELOPE_INVALID] ${policyErrors.join('; ')}`);
  }

  return freezeEnvelope(identity, policy);
}

/**
 * The process-bound identity for ops that run without a minted envelope:
 * the registered scope env only (no persisted file, git or cwd inference, so
 * it is cheap enough for per-op stages), with tenant/org/project derived from
 * the mission record by the owner-scope resolver. Caller input never feeds it.
 */
export function runtimeScopeIdentity(env: NodeJS.ProcessEnv = process.env): ScopeContext {
  const { scope } = resolveScopeResolution({}, env, {
    includePersisted: false,
    inferFromMission: false,
    inferFromCwd: false,
  });
  if (!scope.mission_id) return scope;
  const owner = tryResolveOwnerScope({ kind: 'mission', id: scope.mission_id } as OwnerRef);
  if (!owner) return scope;
  return normalizeScopeContext({
    ...scope,
    tenant_slug: owner.tenant === SHARED_TENANT ? undefined : owner.tenant,
    organization_id: owner.organization_id,
    project_id: owner.project_id,
  });
}

/** The envelope active in the current async context, set by withScopeEnvelope. */
export function currentScopeEnvelope(): ScopeEnvelope | undefined {
  return envelopeStorage.getStore();
}

/** Run `fn` with `envelope` as the active scope for every governed op inside. */
export function withScopeEnvelope<T>(envelope: ScopeEnvelope, fn: () => T): T {
  return envelopeStorage.run(envelope, fn);
}

/** Look up a previously minted envelope by its mint_ref. */
export function getMintedEnvelope(mintRef: string): ScopeEnvelope | undefined {
  return mintLedger.get(mintRef);
}

/** Test seam: drop all minted envelopes and the missing-envelope counters. */
export function resetScopeEnvelopeState(): void {
  mintLedger.clear();
  missingEnvelopeCount = 0;
  missingEnvelopeOps.clear();
}

/** Whether a mint_ref refers to an envelope this runtime issued. */
export function isMintedEnvelopeRef(mintRef: unknown): boolean {
  return typeof mintRef === 'string' && mintLedger.has(mintRef);
}

/**
 * Narrowing only — the sole way to obtain a child envelope for a delegation.
 * Identity may only deepen; policy may only shrink. Any enlargement throws.
 */
export function narrowScopeEnvelope(
  parent: ScopeEnvelope,
  request: ScopeNarrowRequest = {}
): ScopeEnvelope {
  const requestedIdentity = normalizeScopeContext({
    ...parent.identity,
    ...(request.identity ?? {}),
    tier: parent.identity.tier,
  });
  const errors = [
    ...identityNarrowErrors(parent.identity, requestedIdentity),
    ...identityAnchorErrors(parent.identity, requestedIdentity),
    ...policyNarrowErrors(parent.policy, request.policy ?? {}),
  ];
  if (errors.length > 0) {
    throw new Error(`[OP_SCOPE_DENIED] ${errors.join('; ')}`);
  }
  const childPolicy = narrowedPolicy(parent.policy, request.policy ?? {});
  const policyErrors = validatePolicy(childPolicy);
  if (policyErrors.length > 0) {
    throw new Error(`[OP_SCOPE_DENIED] ${policyErrors.join('; ')}`);
  }
  return freezeEnvelope(requestedIdentity, childPolicy);
}

/** Structural check on an input claiming to be a scope envelope. */
export function isScopeEnvelopeShape(value: unknown): value is ScopeEnvelope {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.mint_ref === 'string' &&
    typeof record.minted_at === 'string' &&
    !!record.identity &&
    typeof record.identity === 'object' &&
    !!record.policy &&
    typeof record.policy === 'object'
  );
}

/**
 * Validate an input-provided `scope_envelope` against the minted/active
 * envelope: it must reference the mint ledger (or be the active envelope) and
 * only narrow it. Returns a list of violations; empty means the request is a
 * legitimate narrow request.
 */
export function envelopeNarrowRequestErrors(
  input: unknown,
  active: ScopeEnvelope | undefined
): string[] {
  if (!isScopeEnvelopeShape(input)) {
    return ['scope_envelope has an invalid shape'];
  }
  const errors: string[] = [];
  const minted = getMintedEnvelope(input.mint_ref);
  if (!minted) {
    errors.push('scope_envelope.mint_ref is not a runtime-issued envelope');
  }
  const reference = active ?? minted;
  if (!reference) {
    errors.push('no active scope envelope to narrow against');
    return errors;
  }
  errors.push(...identityNarrowErrors(reference.identity, input.identity));
  errors.push(...identityAnchorErrors(reference.identity, input.identity));
  errors.push(...policyNarrowErrors(reference.policy, input.policy));
  return errors;
}

/**
 * Project the legacy `security_scope` (ContextSecurityScope) as a narrow
 * request against the active envelope. Returns violations; empty means the
 * caller-provided scope is inside the minted envelope.
 */
export function securityScopeNarrowErrors(
  scope: ContextSecurityScope,
  active: ScopeEnvelope
): string[] {
  const requestIdentity: ScopeContextInput = {
    tenant_slug: scope.tenant_slug ?? scope.tenant_id,
    organization_id: scope.organization_id,
    project_id: scope.project_id,
    mission_id: scope.mission_id,
    task_id: scope.task_id,
    session_id: scope.session_id,
    tier: active.identity.tier,
  };
  const identity = normalizeScopeContext({ ...requestIdentity, tier: active.identity.tier });
  const errors = [
    ...identityNarrowErrors(active.identity, identity),
    ...identityAnchorErrors(active.identity, identity),
  ];
  const requestedReadTiers = scope.read_tiers;
  if (
    Array.isArray(requestedReadTiers) &&
    requestedReadTiers.some((tier) => !active.policy.read_tiers.includes(tier))
  ) {
    errors.push('security_scope.read_tiers widens beyond the minted envelope');
  }
  if (scope.write_tier && !active.policy.read_tiers.includes(scope.write_tier)) {
    errors.push('security_scope.write_tier widens beyond the minted envelope');
  }
  if (scope.external_egress === 'allow' && (active.policy.external_egress ?? 'deny') !== 'allow') {
    errors.push('security_scope.external_egress widens beyond the minted envelope');
  }
  return errors;
}

/** Compat projection: envelope → legacy ContextSecurityScope (read-only). */
export function contextSecurityScopeFromEnvelope(
  envelope: ScopeEnvelope
): ContextSecurityScope | null {
  if (!envelope.identity.mission_id) return null;
  return {
    tenant_slug: envelope.identity.tenant_slug,
    organization_id: envelope.identity.organization_id,
    project_id: envelope.identity.project_id,
    task_id: envelope.identity.task_id,
    session_id: envelope.identity.session_id,
    mission_id: envelope.identity.mission_id,
    read_tiers: [...envelope.policy.read_tiers],
    write_tier: envelope.policy.write_tier,
    purpose: envelope.policy.purpose,
    ...(envelope.policy.external_egress !== undefined
      ? { external_egress: envelope.policy.external_egress }
      : {}),
    ...(envelope.policy.allowed_reasoning_backends
      ? { allowed_reasoning_backends: [...envelope.policy.allowed_reasoning_backends] }
      : {}),
  };
}

/**
 * Count governed ops that ran without any scope envelope. SC-01 rollout:
 * missing envelopes are allowed but measured so the enforce rollout has data.
 */
export function noteMissingScopeEnvelope(op?: string): void {
  missingEnvelopeCount += 1;
  if (op && missingEnvelopeOps.size < 100) missingEnvelopeOps.add(op);
}

export function scopeEnvelopeMetrics(): { missing: number; ops: string[] } {
  return { missing: missingEnvelopeCount, ops: [...missingEnvelopeOps] };
}
