/**
 * KD-07: resource-claim declaring tool-call scheduler.
 *
 * Different layer from `core:parallel_foreach` (see adf-engine.ts /
 * scripts/run_pipeline.ts): `parallel_foreach` is DATA parallelism — it runs
 * one FIXED pipeline body concurrently over N items. This module is CALL
 * parallelism — given a batch of (possibly heterogeneous) tool/op calls that
 * occur within a single step (several ops requested in one model turn,
 * several calls issued by one script, several sub-steps under one
 * `core:parallel_calls` step), it parallelizes only the calls whose declared
 * resource claims never conflict with each other, and serializes the rest —
 * while always draining results in the original request order, regardless
 * of how much parallelism actually happened.
 *
 * An op that declares no claims is conservatively treated as `{kind:'all'}`
 * (global exclusive) by the caller — see `resolveOpAccessClaims` in
 * op-input-contracts.ts. If ANY call in a batch carries an `all` claim, the
 * ENTIRE batch degrades to strict serial (request-order) execution: this is
 * the "safe default" the KD-07 plan requires — not just pairwise gating
 * around that one call — so a single undeclared/unaudited op in a batch
 * cannot silently change today's fully-serial behavior for its neighbors.
 */

/** A claim on a single filesystem path. */
export interface FileResourceClaim {
  kind: 'file';
  operation: 'read' | 'write';
  path: string;
  /** Claim covers the whole subtree under `path`, not just the exact entry. */
  recursive?: boolean;
}

/**
 * Global-exclusive claim: conflicts with every other claim, including
 * another `all`. This is the conservative default for any op that has not
 * declared its resource footprint.
 */
export interface AllResourceClaim {
  kind: 'all';
}

export type ResourceClaim = FileResourceClaim | AllResourceClaim;

export interface ScheduledCall<T = unknown> {
  /**
   * Declared resource claims for this call. An empty array means "touches no
   * shared resource" (always safe to parallelize). Callers must normalize an
   * undeclared/unknown op to `[{ kind: 'all' }]` before building this list —
   * this module does not guess at missing declarations.
   */
  claims: ResourceClaim[];
  run: () => Promise<T>;
}

export type ScheduledCallResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

function normalizeClaimPath(rawPath: string): string {
  const posix = rawPath.replace(/\\/gu, '/');
  const trimmed = posix.length > 1 ? posix.replace(/\/+$/u, '') : posix;
  return trimmed || '/';
}

/** Does claim `a`'s path range overlap claim `b`'s path range? */
function pathsOverlap(a: FileResourceClaim, b: FileResourceClaim): boolean {
  const pathA = normalizeClaimPath(a.path);
  const pathB = normalizeClaimPath(b.path);
  if (pathA === pathB) return true;
  if (a.recursive && pathB.startsWith(`${pathA}/`)) return true;
  if (b.recursive && pathA.startsWith(`${pathB}/`)) return true;
  return false;
}

function claimsConflict(a: ResourceClaim, b: ResourceClaim): boolean {
  if (a.kind === 'all' || b.kind === 'all') return true;
  // Two reads never conflict, even on the same/overlapping path.
  if (a.operation === 'read' && b.operation === 'read') return false;
  return pathsOverlap(a, b);
}

function callsConflict(a: ResourceClaim[], b: ResourceClaim[]): boolean {
  for (const claimA of a) {
    for (const claimB of b) {
      if (claimsConflict(claimA, claimB)) return true;
    }
  }
  return false;
}

function hasAllClaim(claims: ResourceClaim[]): boolean {
  return claims.some((claim) => claim.kind === 'all');
}

/**
 * Run a batch of tool/op calls, parallelizing only the ones whose declared
 * resource claims never conflict, and returning `Promise.allSettled`-style
 * results in the SAME order the calls were passed in — regardless of
 * execution order or how much parallelism happened.
 */
export async function runToolCallBatch<T>(
  calls: ReadonlyArray<ScheduledCall<T>>
): Promise<ScheduledCallResult<T>[]> {
  const results: ScheduledCallResult<T>[] = new Array(calls.length);

  const settle = async (call: ScheduledCall<T>): Promise<ScheduledCallResult<T>> => {
    try {
      return { status: 'fulfilled', value: await call.run() };
    } catch (reason) {
      return { status: 'rejected', reason };
    }
  };

  // Safe default: any undeclared/unaudited op anywhere in the batch drops
  // the whole batch to strict request-order serial execution.
  if (calls.some((call) => hasAllClaim(call.claims))) {
    for (let i = 0; i < calls.length; i += 1) {
      results[i] = await settle(calls[i]);
    }
    return results;
  }

  // Every call starts as soon as every OTHER call it conflicts with (by
  // declared claim; request order only matters for tie-breaking dependency
  // direction — earlier calls never wait on later ones) has completed.
  // Non-conflicting calls run fully concurrently.
  const gates: Promise<void>[] = [];
  for (let i = 0; i < calls.length; i += 1) {
    const deps: Promise<void>[] = [];
    for (let j = 0; j < i; j += 1) {
      if (callsConflict(calls[i].claims, calls[j].claims)) deps.push(gates[j]);
    }
    gates[i] = (async () => {
      if (deps.length > 0) await Promise.all(deps);
      results[i] = await settle(calls[i]);
    })();
  }
  await Promise.all(gates);
  return results;
}
