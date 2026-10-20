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
import * as pathResolver from '../path-resolver.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { readJson } from '../foundation/json.js';
import { nowIso } from '../foundation/time.js';
import { isRecord } from '../foundation/text.js';
import {
  assertSafeRepositoryPath,
  safeWriteFile,
  safeMkdir,
  safeCreateExclusiveFileSync,
  safeLstat,
  safeUnlinkSync,
  safeExistsSync,
} from '../secure-io.js';
import { resolveIdentityContext } from '../authority.js';
import {
  currentResourceAccessScope,
  runInResourceAccessScope,
} from '../foundation/resource-access-scope.js';
import { getActiveSandboxPolicy, withSandboxPolicy } from '../shell/sandbox-policy.js';

const POLICY_PATH = 'knowledge/product/governance/tenant-rate-limit-policy.json';
const STATE_PATH = 'active/shared/runtime/tenant-rate-limit-state.json';
const LOCK_PATH = `${STATE_PATH}.lock`;
const LOCK_TIMEOUT_MS = 5000;
const POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/tenant-rate-limit-policy.schema.json'
);
const STATE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/tenant-rate-limit-state.schema.json'
);

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

interface TenantRateLimitLockRecord {
  pid: number;
  created_at?: string;
}

export function normalizeTenantRateLimitLockRecord(
  value: unknown
): TenantRateLimitLockRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.pid !== 'number' ||
    !Number.isInteger(value.pid) ||
    !Number.isFinite(value.pid) ||
    value.pid <= 0
  ) {
    return null;
  }
  const createdAt = value.created_at;
  if (createdAt !== undefined && typeof createdAt !== 'string') return null;
  return {
    pid: value.pid,
    ...(typeof createdAt === 'string' ? { created_at: createdAt } : {}),
  };
}

export interface RateLimitDecision {
  allowed: boolean;
  reason?: string;
  retry_after_ms?: number;
  tokens_remaining?: number;
}

let cachedPolicy: RateLimitPolicy | null = null;

const policyCatalog = defineCatalog<RateLimitPolicy>({
  id: 'tenant-rate-limit-policy',
  path: () => pathResolver.rootResolve(POLICY_PATH),
  schema: POLICY_SCHEMA_PATH,
});

const stateCatalog = defineCatalog<RateLimitState>({
  id: 'tenant-rate-limit-state',
  path: () => pathResolver.rootResolve(STATE_PATH),
  schema: STATE_SCHEMA_PATH,
});

function loadPolicy(): RateLimitPolicy {
  if (cachedPolicy) return cachedPolicy;
  cachedPolicy = policyCatalog.load();
  return cachedPolicy;
}

export function _resetTenantRateLimitPolicyCacheForTests(): void {
  cachedPolicy = null;
  policyCatalog.reset();
}

function loadState(): RateLimitState {
  const statePath = pathResolver.rootResolve(STATE_PATH);
  return safeExistsSync(statePath) ? stateCatalog.load() : { tenants: {} };
}

function saveState(state: RateLimitState): void {
  const abs = pathResolver.rootResolve(STATE_PATH);
  const validated = stateCatalog.validate(state, abs);
  const serialized = JSON.stringify(validated, null, 2) + '\n';
  writeRateLimitLeaf('save', serialized);
}

/** Only host quota bookkeeping may use this synchronous sandbox exception. */
function writeRateLimitLeaf(
  operation: 'save' | 'create-lock' | 'unlink-lock',
  serialized = ''
): void {
  const target = pathResolver.rootResolve(operation === 'save' ? STATE_PATH : LOCK_PATH);
  const directory = path.dirname(target);
  const missing: string[] = [];
  if (operation !== 'unlink-lock') {
    for (let current = directory; !safeExistsSync(current); current = path.dirname(current))
      missing.push(current);
  }
  const leaf = () => {
    if (missing.length) safeMkdir(directory, { recursive: true });
    if (operation === 'save') safeWriteFile(target, serialized, { mkdir: false });
    else if (operation === 'create-lock') safeCreateExclusiveFileSync(target, serialized);
    else safeUnlinkSync(target);
  };
  const policy = getActiveSandboxPolicy();
  const tenantSlug = resolveIdentityContext().tenantSlug;
  if (policy?.mode !== 'read-only' || !tenantSlug) return leaf();
  const parent = currentResourceAccessScope();
  const relative = (value: string) =>
    path.relative(pathResolver.rootDir(), value).split(path.sep).join('/');
  runInResourceAccessScope(
    {
      tenantSlug,
      ...(parent?.organizationId ? { organizationId: parent.organizationId } : {}),
      ...(parent?.projectId ? { projectId: parent.projectId } : {}),
      readExact: [],
      writeExact: [relative(target)],
      mkdirExact: missing.map(relative),
      allowProductKnowledgeRead: true,
    },
    () =>
      withSandboxPolicy(
        { ...policy, mode: 'workspace-write', writableRoots: [directory, ...missing] },
        leaf
      )
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isStaleLock(lockPath: string): boolean {
  try {
    const safeLockPath = assertSafeRepositoryPath(lockPath, { allowMissingLeaf: true });
    if (!safeExistsSync(safeLockPath) || !safeLstat(safeLockPath).isFile()) return true;
    const parsed = normalizeTenantRateLimitLockRecord(readJson<unknown>(safeLockPath));
    if (!parsed) return true;
    process.kill(parsed.pid, 0);
    return false;
  } catch (err: any) {
    if (err?.code === 'ESRCH') return true;
    if (err?.code === 'EPERM') return false;
    // Corrupt, unreadable, or legacy lock files should not permanently
    // disable quota enforcement.
    return true;
  }
}

function withTenantRateLimitLock<T>(fn: () => T): T {
  const lockAbs = pathResolver.rootResolve(LOCK_PATH);
  const startedAt = Date.now();
  let ownsLock = false;

  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    try {
      const serialized = JSON.stringify({
        pid: process.pid,
        created_at: nowIso(),
        resource: 'tenant-rate-limit-state',
      });
      writeRateLimitLeaf('create-lock', serialized);
      ownsLock = true;
      break;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      if (isStaleLock(lockAbs)) {
        writeRateLimitLeaf('unlink-lock');
        continue;
      }
      sleepSync(50 + Math.floor(Math.random() * 50));
    }
  }

  if (!ownsLock) {
    throw new Error(
      `[LOCK_TIMEOUT] Failed to acquire tenant rate-limit lock within ${LOCK_TIMEOUT_MS}ms`
    );
  }

  try {
    return fn();
  } finally {
    writeRateLimitLeaf('unlink-lock');
  }
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
  now: Date
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
  if (getActiveSandboxPolicy()?.mode === 'read-only' && tenantSlug !== ctx.tenantSlug) {
    throw new Error('[RESOURCE_SCOPE_DENIED] Advisory quota accounting requires the active tenant');
  }

  const persona = input.personaOverride ?? ctx.persona ?? '';
  if ((policy.exempt_personas ?? []).includes(persona)) {
    return { allowed: true };
  }

  const cost = input.cost ?? policy.operation_costs?.[input.op] ?? 1;
  const cfg = tenantConfig(policy, tenantSlug);
  const now = input.now ?? new Date();

  return withTenantRateLimitLock(() => {
    const state = loadState();
    const refilled = refillBucket(
      state.tenants[tenantSlug],
      cfg.tokens_per_minute,
      cfg.burst_capacity,
      now
    );

    if (refilled.tokens < cost) {
      const deficit = cost - refilled.tokens;
      const refillRatePerMs = cfg.tokens_per_minute / 60_000;
      const retryAfterMs = Math.max(
        cfg.denial_grace_ms,
        Math.ceil(deficit / Math.max(refillRatePerMs, 1e-9))
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
  });
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
    new Date()
  );
  return {
    tokens: bucket.tokens,
    capacity: cfg.burst_capacity,
    refill_rate_per_minute: cfg.tokens_per_minute,
  };
}

/** Test-only: reset persistent state. */
export function _resetTenantRateLimitStateForTests(): void {
  stateCatalog.reset();
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
  fn: () => Promise<T>
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
