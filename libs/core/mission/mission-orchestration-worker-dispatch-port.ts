import { logger } from '../core.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '../seam.js';

export type MissionWorkerCoreDispatcher = (
  input: unknown,
  traceContext: unknown,
  delegationChain?: unknown,
  gapRecorder?: unknown
) => Promise<unknown>;

const missionWorkerCoreDispatcherSeam = createSeam<MissionWorkerCoreDispatcher>({
  key: 'mission-worker-core-dispatcher',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
});

const DEFAULT_METADATA: SeamProviderMetadata = {
  provenance: 'builtin',
  source: 'libs/core/mission/mission-orchestration-worker-dispatch-port.ts',
  reason: 'mission worker core dispatch registration',
};

export interface MissionWorkerCoreDispatcherRegistrationOptions {
  /**
   * Marks the registration as re-installable by its owner. A later
   * registration that presents the same key supersedes it (with a warning)
   * instead of failing with SEAM_DUPLICATE_PROVIDER. Without the key, or with
   * a different one, the sole seam still rejects a second provider.
   */
  replaceKey?: symbol;
}

let replaceableRegistration: { key: symbol; release: () => void } | null = null;

/**
 * Register the mission worker core dispatcher. The builtin owner
 * (`mission-orchestration-worker-part-core.ts`) passes its own unexported
 * `replaceKey`: a second evaluation of that module against this port instance
 * (a module-registry reset racing an import still in flight, as when a
 * timed-out test keeps evaluating after the next test called
 * `vi.resetModules()`, operations-hygiene-runbook §5) supersedes the stale
 * builtin registration instead of throwing. Any other caller cannot evict it.
 */
export function registerMissionWorkerCoreDispatcher(
  next: MissionWorkerCoreDispatcher,
  metadata: SeamProviderMetadata = DEFAULT_METADATA,
  options: MissionWorkerCoreDispatcherRegistrationOptions = {}
): () => void {
  const { replaceKey } = options;
  if (replaceKey !== undefined && replaceableRegistration?.key === replaceKey) {
    logger.warn(
      `[MISSION_WORKER_CORE] superseding the registered mission-worker-core dispatcher — ` +
        `its owner registered it again with the same replace key (module re-evaluated) | ` +
        `next: none if this follows a module-registry reset; otherwise find the second evaluation of ${metadata.source} | ` +
        `evidence: seam=mission-worker-core-dispatcher source=${metadata.source}`
    );
    replaceableRegistration.release();
  }
  const dispose = missionWorkerCoreDispatcherSeam.register('mission-worker-core', next, metadata);
  if (replaceKey === undefined) return dispose;
  const registration = {
    key: replaceKey,
    release: () => {
      dispose();
      if (replaceableRegistration === registration) replaceableRegistration = null;
    },
  };
  replaceableRegistration = registration;
  return registration.release;
}

export async function dispatchThroughMissionWorkerCore(
  input: unknown,
  traceContext: unknown,
  delegationChain?: unknown,
  gapRecorder?: unknown
): Promise<unknown> {
  const dispatcher = missionWorkerCoreDispatcherSeam.getOptional();
  if (!dispatcher) throw new Error('Mission worker core dispatcher is not initialized');
  return dispatcher(input, traceContext, delegationChain, gapRecorder);
}
