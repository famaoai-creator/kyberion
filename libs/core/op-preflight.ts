/**
 * DH-01: one serial admission waterfall for operation dispatch.
 *
 * Listeners may observe or repair an input, but a decision of block/ask is
 * terminal. Monotonic guards run after the listener waterfall and can only
 * tighten the decision; no later registration can re-allow a denied call.
 */

import { assertModuleInvariant } from './invariants.js';

export type OpPreflightDecision = 'allow' | 'block' | 'ask';

export interface OpPreflightCall {
  op: string;
  params: Record<string, unknown>;
  context?: Record<string, unknown>;
  source: 'pipeline' | 'actuator' | 'delegate' | 'mcp';
  requiresApproval?: boolean;
  approvalGranted?: boolean;
  /** Trusted caller-side signal; false converts approval ask into a block. */
  hasHuman?: boolean;
}

export interface OpPreflightResult {
  decision: OpPreflightDecision;
  reason?: string;
  repaired_input?: Record<string, unknown>;
  terminate?: boolean;
  listener_ids: string[];
  guard_ids: string[];
}

export interface OpPreflightListenerResult {
  decision?: OpPreflightDecision;
  reason?: string;
  repaired_input?: Record<string, unknown>;
  terminate?: boolean;
}

export interface OpPreflightListener {
  id: string;
  /** Lower order runs first; ties are resolved canonically by id. */
  order?: number;
  run: (
    call: OpPreflightCall,
    input: Record<string, unknown>
  ) => OpPreflightListenerResult | void | Promise<OpPreflightListenerResult | void>;
}

export interface OpPreflightGuard {
  id: string;
  /** Lower order runs first; ties are resolved canonically by id. */
  order?: number;
  check: (
    call: OpPreflightCall,
    input: Record<string, unknown>
  ) =>
    | { decision?: 'block' | 'ask'; reason?: string; terminate?: boolean }
    | void
    | Promise<{ decision?: 'block' | 'ask'; reason?: string; terminate?: boolean } | void>;
}

const listeners = new Map<string, OpPreflightListener>();
const guards = new Map<string, OpPreflightGuard>();

function ordered<T extends { id: string; order?: number }>(entries: Iterable<T>): T[] {
  return [...entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

function assertUniqueId(id: string, collection: Map<string, unknown>, kind: string): string {
  const normalized = id.trim();
  if (!normalized) throw new Error(`[OP_PREFLIGHT_CONFIG] ${kind} id is required`);
  if (collection.has(normalized)) {
    throw new Error(`[OP_PREFLIGHT_CONFIG] duplicate ${kind} id: ${normalized}`);
  }
  return normalized;
}

export function registerOpPreflightListener(listener: OpPreflightListener): () => void {
  const id = assertUniqueId(listener.id, listeners, 'listener');
  listeners.set(id, { ...listener, id });
  return () => listeners.delete(id);
}

export function registerOpGuard(guard: OpPreflightGuard): () => void {
  const id = assertUniqueId(guard.id, guards, 'guard');
  guards.set(id, { ...guard, id });
  return () => guards.delete(id);
}

export function listOpPreflightListeners(): OpPreflightListener[] {
  return ordered(listeners.values());
}

export function listOpGuards(): OpPreflightGuard[] {
  return ordered(guards.values());
}

/** Clear runtime registrations for isolated tests and worker teardown. */
export function resetOpPreflight(): void {
  listeners.clear();
  guards.clear();
}

function approvalGuard(
  call: OpPreflightCall
): { decision: 'block' | 'ask'; reason: string } | undefined {
  if (call.requiresApproval && !call.approvalGranted) {
    if (call.hasHuman === false) {
      return {
        decision: 'block',
        reason: `[HUMAN_REQUIRED] Operation ${call.op} requires human approval, but the execution boundary is non-interactive.`,
      };
    }
    return {
      decision: 'ask',
      reason: `Operation ${call.op} requires a prior human approval decision.`,
    };
  }
  return undefined;
}

/** Run serial repair/observation listeners, then monotonic guards. */
export async function runOpPreflight(
  call: OpPreflightCall
): Promise<OpPreflightResult & { input: Record<string, unknown> }> {
  let input = { ...call.params };
  const originalInput = input;
  const listenerIds: string[] = [];
  const guardIds: string[] = [];
  let terminate: boolean | undefined;

  for (const listener of ordered(listeners.values())) {
    listenerIds.push(listener.id);
    const result = await listener.run(call, input);
    if (!result) continue;
    if (result.repaired_input) input = { ...input, ...result.repaired_input };
    if (result.terminate !== undefined) terminate = result.terminate;
    if (result.decision === 'block' || result.decision === 'ask') {
      return assertPreflightResult({
        decision: result.decision,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(inputChanged(originalInput, input) ? { repaired_input: input } : {}),
        ...(terminate !== undefined ? { terminate } : {}),
        listener_ids: listenerIds,
        guard_ids: guardIds,
        input,
      });
    }
  }

  const builtInApproval = approvalGuard(call);
  if (builtInApproval) {
    return assertPreflightResult({
      ...builtInApproval,
      ...(inputChanged(originalInput, input) ? { repaired_input: input } : {}),
      ...(terminate !== undefined ? { terminate } : {}),
      listener_ids: listenerIds,
      guard_ids: ['builtin:approval'],
      input,
    });
  }

  for (const guard of ordered(guards.values())) {
    guardIds.push(guard.id);
    const result = await guard.check(call, input);
    if (!result) continue;
    if (result?.decision === 'block' || result?.decision === 'ask') {
      return assertPreflightResult({
        decision: result.decision,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
        ...(inputChanged(originalInput, input) ? { repaired_input: input } : {}),
        listener_ids: listenerIds,
        guard_ids: guardIds,
        input,
      });
    }
  }

  return assertPreflightResult({
    decision: 'allow',
    ...(inputChanged(originalInput, input) ? { repaired_input: input } : {}),
    ...(terminate !== undefined ? { terminate } : {}),
    listener_ids: listenerIds,
    guard_ids: guardIds,
    input,
  });
}

/**
 * Synchronous admission for command paths whose caller must begin an
 * operation before yielding to the event loop (for example, cancellation of
 * a running render). It executes the same ordered waterfall and fails closed
 * if an extension contributes an async listener/guard; such a path must use
 * runOpPreflight instead.
 */
export function runOpPreflightSync(
  call: OpPreflightCall
): OpPreflightResult & { input: Record<string, unknown> } {
  let input = { ...call.params };
  const originalInput = input;
  const listenerIds: string[] = [];
  const guardIds: string[] = [];
  let terminate: boolean | undefined;

  for (const listener of ordered(listeners.values())) {
    listenerIds.push(listener.id);
    const result = listener.run(call, input);
    if (isPromiseLike(result)) {
      throw new Error(
        `[OP_PREFLIGHT_SYNC_UNAVAILABLE] Async listener ${listener.id} requires await.`
      );
    }
    if (!result) continue;
    if (result.repaired_input) input = { ...input, ...result.repaired_input };
    if (result.terminate !== undefined) terminate = result.terminate;
    if (result.decision === 'block' || result.decision === 'ask') {
      return assertPreflightResult({
        decision: result.decision,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(inputChanged(originalInput, input) ? { repaired_input: input } : {}),
        ...(terminate !== undefined ? { terminate } : {}),
        listener_ids: listenerIds,
        guard_ids: guardIds,
        input,
      });
    }
  }

  const builtInApproval = approvalGuard(call);
  if (builtInApproval) {
    return assertPreflightResult({
      ...builtInApproval,
      ...(inputChanged(originalInput, input) ? { repaired_input: input } : {}),
      ...(terminate !== undefined ? { terminate } : {}),
      listener_ids: listenerIds,
      guard_ids: ['builtin:approval'],
      input,
    });
  }

  for (const guard of ordered(guards.values())) {
    guardIds.push(guard.id);
    const result = guard.check(call, input);
    if (isPromiseLike(result)) {
      throw new Error(`[OP_PREFLIGHT_SYNC_UNAVAILABLE] Async guard ${guard.id} requires await.`);
    }
    if (!result) continue;
    if (result.decision === 'block' || result.decision === 'ask') {
      return assertPreflightResult({
        decision: result.decision,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
        ...(inputChanged(originalInput, input) ? { repaired_input: input } : {}),
        listener_ids: listenerIds,
        guard_ids: guardIds,
        input,
      });
    }
  }

  return assertPreflightResult({
    decision: 'allow',
    ...(inputChanged(originalInput, input) ? { repaired_input: input } : {}),
    ...(terminate !== undefined ? { terminate } : {}),
    listener_ids: listenerIds,
    guard_ids: guardIds,
    input,
  });
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(value && typeof (value as any).then === 'function');
}

function assertPreflightResult(
  result: OpPreflightResult & { input: Record<string, unknown> }
): OpPreflightResult & { input: Record<string, unknown> } {
  assertModuleInvariant('op-preflight', 'decision-domain', result);
  assertModuleInvariant('op-preflight', 'input-record', result);
  return result;
}

function inputChanged(
  original: Record<string, unknown>,
  repaired: Record<string, unknown>
): boolean {
  const originalKeys = Object.keys(original);
  const repairedKeys = Object.keys(repaired);
  if (originalKeys.length !== repairedKeys.length) return true;
  return repairedKeys.some((key) => !Object.is(original[key], repaired[key]));
}
