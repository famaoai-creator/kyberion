/**
 * Live (post-demotion) reasoning capability probes, split out of
 * `reasoning-backend.ts` and re-exported from there.
 */

import type { ReasoningBackend } from './reasoning-backend-contracts.js';

/** What a backend can serve right now, after provider-health demotion. */
export interface ReasoningLiveCapabilities {
  tools: boolean;
  candidates: string[];
}

export interface LiveCapabilityReporter {
  liveCapabilities?: (role?: string) => ReasoningLiveCapabilities;
}

/**
 * True when `backend` (for `role`) has at least one non-demoted candidate that
 * supports `generateWithTools`. Backends without `liveCapabilities` (single
 * providers, test doubles) answer from `generateWithTools` presence.
 */
export function backendHasLiveToolCandidate(
  backend: Pick<ReasoningBackend, 'generateWithTools'> & LiveCapabilityReporter,
  role?: string
): boolean {
  if (typeof backend.liveCapabilities === 'function') {
    try {
      return backend.liveCapabilities(role).tools;
    } catch {
      return false;
    }
  }
  return Boolean(backend.generateWithTools);
}
