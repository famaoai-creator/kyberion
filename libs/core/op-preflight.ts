/**
 * DH-01: one serial admission waterfall for operation dispatch.
 *
 * Listeners may observe or repair an input, but a decision of block/ask is
 * terminal. Monotonic guards run after the listener waterfall and can only
 * tighten the decision; no later registration can re-allow a denied call.
 */

import { assertModuleInvariant } from './invariants.js';
import { findPluginGrantDenial } from './sandbox-policy.js';

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

/**
 * Fires exactly once per call, after the decision is final (every listener
 * and guard has run, or an earlier stage was terminal). Observers cannot
 * change the decision — the callback returns nothing — and a throwing
 * observer never affects the call or other observers.
 */
export type OpPreflightOutcomeObserver = (
  call: OpPreflightCall,
  result: OpPreflightResult & { input: Record<string, unknown> }
) => void;

const listeners = new Map<string, OpPreflightListener>();
const guards = new Map<string, OpPreflightGuard>();
const outcomeObservers = new Set<OpPreflightOutcomeObserver>();
const callKeys = new WeakMap<object, object>();

/**
 * Stable opaque key shared by a call and the detached snapshot observers
 * receive for it, so a listener and an observer can correlate one call
 * without the observer holding the mutable original.
 */
export function opPreflightCallKey(call: OpPreflightCall): object {
  let key = callKeys.get(call);
  if (!key) {
    key = Object.freeze({});
    callKeys.set(call, key);
  }
  return key;
}

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

/**
 * Register a hook that observes the final decision for every call, after all
 * guards (including built-ins) have run. Returns a disposer.
 */
export function registerOpPreflightOutcomeObserver(
  observer: OpPreflightOutcomeObserver
): () => void {
  outcomeObservers.add(observer);
  return () => outcomeObservers.delete(observer);
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
  outcomeObservers.clear();
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

export const PLUGIN_GRANT_OPS_GUARD_ID = 'plugin-grant-ops';

/**
 * EP-03: while a plugin contribution is executing, only ops in its grant's
 * `ops_invoke` (every enclosing plugin frame) may be dispatched. Built in
 * (not a registered guard) so resetOpPreflight() cannot remove it, and
 * evaluated first so no listener runs for a denied call.
 */
function pluginGrantOpsGuard(call: OpPreflightCall): OpPreflightResult | undefined {
  const denied = findPluginGrantDenial('ops_invoke', call.op);
  if (!denied) return undefined;
  return {
    decision: 'block',
    reason: `[PLUGIN_GRANT_DENIED] plugin '${denied.pluginId}' is not granted ops_invoke '${call.op}'`,
    terminate: true,
    listener_ids: [],
    guard_ids: [PLUGIN_GRANT_OPS_GUARD_ID],
  };
}

/** Run serial repair/observation listeners, then monotonic guards. */
export async function runOpPreflight(
  call: OpPreflightCall
): Promise<OpPreflightResult & { input: Record<string, unknown> }> {
  const pluginDenied = pluginGrantOpsGuard(call);
  if (pluginDenied) {
    return finalizePreflightResult(call, { ...pluginDenied, input: { ...call.params } });
  }
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
      return finalizePreflightResult(call, {
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
    return finalizePreflightResult(call, {
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
      return finalizePreflightResult(call, {
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

  return finalizePreflightResult(call, {
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
  const pluginDenied = pluginGrantOpsGuard(call);
  if (pluginDenied) {
    return finalizePreflightResult(call, { ...pluginDenied, input: { ...call.params } });
  }
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
      return finalizePreflightResult(call, {
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
    return finalizePreflightResult(call, {
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
      return finalizePreflightResult(call, {
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

  return finalizePreflightResult(call, {
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

/**
 * Every return path funnels through here: validate the result, then notify
 * outcome observers exactly once with the now-final decision. Observers run
 * after the fact and cannot influence what is returned.
 */
function finalizePreflightResult(
  call: OpPreflightCall,
  result: OpPreflightResult & { input: Record<string, unknown> }
): OpPreflightResult & { input: Record<string, unknown> } {
  const asserted = assertPreflightResult(result);
  if (outcomeObservers.size > 0) {
    // Observers see a deep-frozen detached snapshot of the result and the
    // call, never the objects the caller or the dispatcher keep, so a
    // mutation attempt can never change what executes or what is returned.
    const snapshot = Object.freeze({
      ...asserted,
      listener_ids: Object.freeze([...asserted.listener_ids]),
      guard_ids: Object.freeze([...asserted.guard_ids]),
      input: detachedSnapshot(asserted.input),
      ...(asserted.repaired_input
        ? { repaired_input: detachedSnapshot(asserted.repaired_input) }
        : {}),
    }) as OpPreflightResult & { input: Record<string, unknown> };
    const callSnapshot = Object.freeze({
      ...call,
      params: detachedSnapshot(call.params),
      ...(call.context ? { context: detachedSnapshot(call.context) } : {}),
    }) as OpPreflightCall;
    callKeys.set(callSnapshot, opPreflightCallKey(call));
    for (const observer of outcomeObservers) {
      try {
        const returned: unknown = observer(callSnapshot, snapshot);
        if (isPromiseLike(returned)) {
          Promise.resolve(returned).then(undefined, (error: unknown) => {
            console.error('[OP_PREFLIGHT_OUTCOME_OBSERVER_ERROR]', error);
          });
        }
      } catch (error) {
        console.error('[OP_PREFLIGHT_OUTCOME_OBSERVER_ERROR]', error);
      }
    }
  }
  return asserted;
}

/**
 * Deep-frozen copy detached from `value`. structuredClone first; values it
 * cannot clone (functions, class instances with private state) fall back to
 * a plain-data copy in which uncloneable members become a type marker.
 */
function detachedSnapshot<T extends Record<string, unknown>>(value: T): T {
  let copy: unknown;
  try {
    copy = structuredClone(value);
  } catch {
    copy = plainDataCopy(value, new Map());
  }
  return deepFreeze(copy) as T;
}

function plainDataCopy(value: unknown, seen: Map<object, unknown>): unknown {
  if (typeof value === 'function') return `[uncloneable:function]`;
  if (value === null || typeof value !== 'object') return value;
  const known = seen.get(value);
  if (known !== undefined) return known;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(plainDataCopy(item, seen));
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    try {
      const cloned = structuredClone(value);
      seen.set(value, cloned);
      return cloned;
    } catch {
      return `[uncloneable:${proto?.constructor?.name ?? 'object'}]`;
    }
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) out[key] = plainDataCopy(item, seen);
  return out;
}

function deepFreeze(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, item] of value) {
      deepFreeze(key, seen);
      deepFreeze(item, seen);
    }
  } else if (value instanceof Set) {
    for (const item of value) deepFreeze(item, seen);
  } else if (!ArrayBuffer.isView(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
    }
  }
  // Typed arrays with elements cannot be frozen; they are detached copies anyway.
  if (!ArrayBuffer.isView(value)) Object.freeze(value);
  return value;
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
