import { logger } from '../core.js';
import { getRegisteredEnvText } from '../foundation/env.js';

/**
 * LC-07 (LOOP_CLOSURE_PLAN): stub-taint registry. Every stub op invocation is
 * recorded process-wide so completion gates (intent-reconciliation) can refuse
 * to mark work "done" when its judgments came from fabricated placeholders.
 * Explicit stub mode (KYBERION_REASONING_BACKEND=stub) opts out — that is the
 * deterministic-test configuration where stub output is the point.
 *
 * The registry is a leaf so a completion gate reads it without loading the
 * reasoning backend and its provider chain; a process that never loaded the
 * backend has, by construction, served no stub op.
 */
export interface StubServedRecord {
  op: string;
  at: number;
}

const stubServedOps: StubServedRecord[] = [];
const STUB_SERVED_CAP = 500;

export function stubExplicitlyRequested(): boolean {
  return getRegisteredEnvText('KYBERION_REASONING_BACKEND') === 'stub';
}

export function recordStubServed(op: string, detail?: string): void {
  if (stubServedOps.length < STUB_SERVED_CAP) {
    stubServedOps.push({ op, at: Date.now() });
  }
  logger.warn(
    `[reasoning-backend:stub] ${op} — no real backend registered${detail ? `; ${detail}` : ''}`
  );
}

export function getStubServedOps(): readonly StubServedRecord[] {
  return stubServedOps;
}

/** Clear the stub-taint registry. Used by tests and by resetReasoningBackend. */
export function resetStubServedOps(): void {
  stubServedOps.length = 0;
}

/** Copy of the stub-taint registry, for scoped callers that must reset the backend. */
export function snapshotStubServedOps(): StubServedRecord[] {
  return stubServedOps.map((record) => ({ ...record }));
}

/**
 * Put a snapshot back in front of the registry. Records made since the
 * snapshot are kept, so restoring can never drop taint.
 */
export function restoreStubServedOps(snapshot: readonly StubServedRecord[]): void {
  const since = stubServedOps.splice(0);
  stubServedOps.push(
    ...[...snapshot, ...since].slice(0, STUB_SERVED_CAP).map((record) => ({ ...record }))
  );
}
