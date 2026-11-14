/** Internal registration window; never grants a role, filesystem or runtime authority. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { GwsSessionStageIdentity } from '../secret/gws-session-registration-contract.js';

type Window = { stage: GwsSessionStageIdentity };
const storage = new AsyncLocalStorage<Window>();
const live = new WeakSet<Window>();

/** Sole production issuer: the approved account-introduction facade. */
export async function withGwsSessionRegistrationAdmission<T>(
  stage: GwsSessionStageIdentity,
  run: () => Promise<T> | T
): Promise<T> {
  const window = { stage };
  live.add(window);
  try {
    return await storage.run(window, run);
  } finally {
    live.delete(window);
  }
}

export function assertGwsSessionRegistrationAdmission(stage: GwsSessionStageIdentity): void {
  const window = storage.getStore();
  if (!window || !live.has(window) || window.stage !== stage)
    throw new Error('[GWS_SESSION_STORE] registration_admission_required');
}
