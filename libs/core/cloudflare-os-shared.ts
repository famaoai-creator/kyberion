import { CloudflareOsControlPlane } from './cloudflare-os-control-plane.js';

/**
 * SC-05: process-level shared control plane for the standard preflight /
 * post-op stages. Reads must see cross-process writes, so each access
 * catches the projection up to the journal tail — throttled so a listener
 * firing several times per op does not re-scan the journal every call.
 */
const REFRESH_MIN_INTERVAL_MS = 250;

let shared: CloudflareOsControlPlane | undefined;
let lastRefreshAt = 0;

export function sharedControlPlane(): CloudflareOsControlPlane {
  if (!shared) {
    shared = new CloudflareOsControlPlane();
    lastRefreshAt = Date.now();
    return shared;
  }
  const now = Date.now();
  if (now - lastRefreshAt >= REFRESH_MIN_INTERVAL_MS) {
    lastRefreshAt = now;
    shared.refreshFromJournals();
  }
  return shared;
}

export function resetSharedControlPlaneForTests(): void {
  shared = undefined;
  lastRefreshAt = 0;
}
