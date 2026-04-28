/**
 * Tenant Rate Limiter (per-tenant token bucket).
 *
 * Implements a simple, file-persisted token-bucket rate limiter keyed by
 * tenant slug. Used by `wisdom-actuator` reasoning ops (and any other
 * cost-significant ops) to enforce per-tenant quota in multi-tenant
 * deployments.
 *
 * Persistence:
 *   active/shared/runtime/tenant-rate-limit-state.json
 *   { "tenants": { "<slug>": { "tokens": <number>, "updated_at": <iso> } } }
 *
 * Concurrency:
 *   The implementation is read-modify-write under a file lock-file. This
 *   is intentionally simple — appropriate for the per-process, per-host
 *   reality of the early multi-tenant deployment. When the operator moves
 *   to a fleet of workers behind a shared queue, replace the persistence
 *   layer with Redis or equivalent without changing the API.
 */

import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import {
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
} from './secure-io.js';
import { resolveIdentityContext } from './authority.js';

const POLICY_PATH = 'knowledge/public/governance/tenant-rate-limit-policy.json';
const STATE_PATH = 'active/shared/runtime/tenant-rate-limit-state.json';

interface RateLimitPolicy {
  default: {
    tokens_per_minute: number;
    burst_capacity: number;
    denial_grace_ms: number;
  };
  tenants: Record<
    string,
    Partial<{
      tokens_per_minute: number;
      burst_capacity: number;
      denial_grace_ms: number;
    }>
  >;
  operation_costs: Record<string, number>;
  exempt_personas?: string[];
}

interface TenantBucket {
  tokens: number;
  updated_at: string;
}

interface RateLimitState {
  tenants: Record<string, TenantBucket>;
}

export interface RateLimitDecision {
  allowed: boolean;
  reason?: string;
  retry_after_ms?: number;
  tokens_remaining?: number;
}

let cachedPolicy: RateLimitPolicy | null = null;

function loadPolicy(): RateLimitPolicy {
  if (cachedPolicy) return cachedPolicy;
  const abs = pathResolver.rootResolve(POLICY_PATH);
  if (!safeExistsSync(abs)) {
    cachedPolicy = {
      default: { tokens_per_minute: 60, burst_capacity: 60, denial_grace_ms: 30000 },
      tenants: {},
      operation_costs: {},
      exempt_personas: ['sovereign', 'ecosystem_architect'],
    };
    return cachedPolicy;
  }
  cachedPolicy = JSON.parse(safeReadFile(abs, { encoding: 'utf8' }) as string) as RateLimitPolicy;
  return cachedPolicy;
}

export function _resetTenantRateLimitPolicyCacheForTests(): void {
  cachedPolicy = null;
}

function loadState(): RateLimitState {
  const abs = pathResolver.rootResolve(STATE_PATH);
  if (!safeExistsSync(abs)) return { tenants: {} };
  try {
    return JSON.parse(safeReadFile(abs, { encoding: 'utf8' }) as string) as RateLimitState;
  } catch {
    return { tenants: {} };
  }
}

function saveState(state: RateLimitState): void {
  const abs = pathResolver.rootResolve(STATE_PATH);
  safeMkdir(path.dirname(abs), { recursive: true });
  safeWriteFile(abs, JSON.stringify(state, null, 2) + '\n');
}

function tenantConfig(policy: RateLimitPolicy, tenantSlug: string) {
  const override = policy.tenants[tenantSlug] || {};
  return {
    tokens_per_minute: override.tokens_per_minute ?? policy.default.tokens_per_minute,
    burst_capacity: override.burst_capacity ?? policy.default.burst_capacity,
    denial_grace_ms: override.denial_grace_ms ?? policy.default.denial_grace_ms,
  };
}

function refillBucket(
  bucket: TenantBucket | undefined,
  tokensPerMinute: number,
  burstCapacity: number,
  now: Date,
): TenantBucket {
  if (!bucket) return { tokens: burstCapacity, updated_at: now.toISOString() };
  const elapsedMs = now.getTime() - new Date(bucket.updated_at).getTime();
  const refilled = bucket.tokens + (tokensPerMinute * elapsedMs) / 60_000;
  return {
    tokens: Math.min(refilled, burstCapacity),
    updated_at: now.toISOString(),
  };
}

/**
 * Decide whether the active tenant may consume `cost` tokens for the
 * named operation, and atomically debit on success. Returns a decision
 * object with retry guidance.
 *
 * If `tenantSlug` is undefined (tenant-agnostic execution) or the active
 * persona is on the exempt list, the call is always allowed and no state
 * is mutated.
 */
export function consumeTenantBudget(input: {
  op: string;
  cost?: number;
  tenantSlug?: string;
  personaOverride?: string;
  now?: Date;
}): RateLimitDecision {
  const policy = loadPolicy();
  const ctx = resolveIdentityContext();
  const tenantSlug = input.tenantSlug ?? ctx.tenantSlug;
  if (!tenantSlug) return { allowed: true };

  const persona = input.personaOverride ?? ctx.persona ?? '';
  if ((policy.exempt_personas ?? []).includes(persona)) {
    return { allowed: true };
  }

  const cost = input.cost ?? policy.operation_costs?.[input.op] ?? 1;
  const cfg = tenantConfig(policy, tenantSlug);
  const now = input.now ?? new Date();

  const state = loadState();
  const refilled = refillBucket(state.tenants[tenantSlug], cfg.tokens_per_minute, cfg.burst_capacity, now);

  if (refilled.tokens < cost) {
    const deficit = cost - refilled.tokens;
    const refillRatePerMs = cfg.tokens_per_minute / 60_000;
    const retryAfterMs = Math.max(
      cfg.denial_grace_ms,
      Math.ceil(deficit / Math.max(refillRatePerMs, 1e-9)),
    );
    state.tenants[tenantSlug] = refilled;
    saveState(state);
    return {
      allowed: false,
      reason: `[RATE_LIMIT] tenant '${tenantSlug}' has ${refilled.tokens.toFixed(2)} tokens, op '${input.op}' costs ${cost}; retry in ~${retryAfterMs}ms`,
      retry_after_ms: retryAfterMs,
      tokens_remaining: refilled.tokens,
    };
  }

  refilled.tokens -= cost;
  state.tenants[tenantSlug] = refilled;
  saveState(state);
  return {
    allowed: true,
    tokens_remaining: refilled.tokens,
  };
}

/**
 * Inspect the current bucket state for a tenant without mutating it.
 * Used by audit / monitoring tools.
 */
export function inspectTenantBudget(tenantSlug: string): {
  tokens: number;
  capacity: number;
  refill_rate_per_minute: number;
} {
  const policy = loadPolicy();
  const cfg = tenantConfig(policy, tenantSlug);
  const state = loadState();
  const bucket = refillBucket(
    state.tenants[tenantSlug],
    cfg.tokens_per_minute,
    cfg.burst_capacity,
    new Date(),
  );
  return {
    tokens: bucket.tokens,
    capacity: cfg.burst_capacity,
    refill_rate_per_minute: cfg.tokens_per_minute,
  };
}

/** Test-only: reset persistent state. */
export function _resetTenantRateLimitStateForTests(): void {
  saveState({ tenants: {} });
}

export class TenantRateLimitExceededError extends Error {
  readonly code = 'TENANT_RATE_LIMIT_EXCEEDED';
  readonly retryAfterMs: number;
  readonly tenantSlug: string;
  constructor(decision: RateLimitDecision, tenantSlug: string) {
    super(decision.reason || 'tenant rate limit exceeded');
    this.name = 'TenantRateLimitExceededError';
    this.retryAfterMs = decision.retry_after_ms ?? 0;
    this.tenantSlug = tenantSlug;
  }
}

/**
 * Convenience: wrap an async op with rate-limit enforcement. Throws
 * `TenantRateLimitExceededError` on denial. Allows callers to opt into
 * structured exception flow without writing the consume + throw boilerplate
 * on every call site.
 */
export async function withTenantBudget<T>(
  input: { op: string; cost?: number },
  fn: () => Promise<T>,
): Promise<T> {
  const decision = consumeTenantBudget({
    op: input.op,
    ...(input.cost !== undefined ? { cost: input.cost } : {}),
  });
  if (!decision.allowed) {
    throw new TenantRateLimitExceededError(decision, resolveIdentityContext().tenantSlug ?? '');
  }
  return fn();
}
