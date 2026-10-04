/**
 * Dot wake backend resolution — decides, once per wake, whether the dot runs a
 * tool loop, a fenced delegated turn, or not at all.
 *
 * Failure modes this exists for (live wake ledger, 2026-10-03):
 *   - a long-lived process that never installed a backend holds the
 *     deterministic stub; a delegated stub turn "succeeds" with `[STUB]` text
 *     and was recorded as delivered — fake success. An unconfigured stub is
 *     now `unavailable` (a real failed wake), never a delivery.
 *   - a failover chain advertises `generateWithTools` from construction even
 *     when no tool-capable candidate can serve now; the loop then dies with
 *     "failed across 0 candidate(s)". `tool` is chosen only when a live tool
 *     candidate exists ({@link backendHasLiveToolCandidate}).
 */

import {
  backendHasLiveToolCandidate,
  getReasoningBackend,
  stubExplicitlyRequested,
  stubReasoningBackend,
} from '../reasoning/reasoning-backend.js';
import type { ReasoningBackend } from '../reasoning/reasoning-backend-contracts.js';
import type { DotCharter } from './dot-charter.js';

export type DotWakeBackend = Pick<
  ReasoningBackend,
  'generateWithTools' | 'delegateTask' | 'delegateTaskHandle'
> & { name?: string };

export type DotWakeBackendResolution =
  | { mode: 'tool'; backend: DotWakeBackend }
  | { mode: 'fence'; backend: DotWakeBackend }
  | { mode: 'unavailable'; reason: string };

export const DOT_WAKE_BACKEND_UNAVAILABLE =
  'no real reasoning backend in this process — next: run `pnpm reasoning:setup` (the supervisor re-selects backends every 30 min)';

/**
 * True for the process-default deterministic stub, unless the stub was asked
 * for (`KYBERION_REASONING_BACKEND=stub`) or the caller injected the backend
 * (tests, explicit hosts).
 */
export function dotBackendIsUnconfiguredStub(
  backend: DotWakeBackend,
  options: { injected?: boolean } = {}
): boolean {
  if (options.injected) return false;
  if (stubExplicitlyRequested()) return false;
  return backend === stubReasoningBackend || backend.name === 'stub';
}

export interface ResolveDotWakeBackendOptions {
  /** The backend was injected by the caller (tests / explicit host) — the stub guard does not apply. */
  injected?: boolean;
  /** Role whose chain answers the live-tool question; defaults to the charter authority role. */
  role?: string;
  /**
   * Looks up a backend by name for `charter.runtime.reasoning_backend`. When it
   * returns one, that backend is preferred over `backend`; absent or
   * unresolvable, the process backend is used.
   */
  backendFor?: (name: string) => DotWakeBackend | undefined;
}

export function resolveDotWakeBackend(
  charter: DotCharter,
  backend?: DotWakeBackend,
  options: ResolveDotWakeBackendOptions = {}
): DotWakeBackendResolution {
  const preferredName = charter.runtime.reasoning_backend;
  const preferred = preferredName ? options.backendFor?.(preferredName) : undefined;
  const chosen: DotWakeBackend = preferred ?? backend ?? getReasoningBackend();
  if (dotBackendIsUnconfiguredStub(chosen, { injected: options.injected })) {
    return { mode: 'unavailable', reason: DOT_WAKE_BACKEND_UNAVAILABLE };
  }
  const role = options.role ?? charter.authority.authority_role;
  if (chosen.generateWithTools && backendHasLiveToolCandidate(chosen, role)) {
    return { mode: 'tool', backend: chosen };
  }
  return { mode: 'fence', backend: chosen };
}

/**
 * Errors from a tool loop that never got a tool-capable provider: the wake can
 * still be served by a fenced delegated turn inside the same wake.
 */
export function isDotToolBackendUnavailableError(message: string): boolean {
  return /lacks generateWithTools|failed across 0 candidate|has no tool-capable backend/.test(
    message
  );
}
