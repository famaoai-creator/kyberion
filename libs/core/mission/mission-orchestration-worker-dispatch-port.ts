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

export function registerMissionWorkerCoreDispatcher(
  next: MissionWorkerCoreDispatcher,
  metadata: SeamProviderMetadata = DEFAULT_METADATA
): () => void {
  return missionWorkerCoreDispatcherSeam.register('mission-worker-core', next, metadata);
}

let releaseBuiltinDispatcher: (() => void) | null = null;

/**
 * Module-level installation of the builtin dispatcher
 * (`mission-orchestration-worker-part-core.ts`). A second evaluation of that
 * module against this same port instance supersedes the stale builtin
 * registration instead of throwing SEAM_DUPLICATE_PROVIDER. That happens when
 * a module-registry reset races an import that is still in flight, e.g. a
 * timed-out test whose dynamic import keeps evaluating after the next test
 * called `vi.resetModules()` (operations-hygiene-runbook §5). Only a
 * registration made by this installer is superseded: a provider registered
 * through `registerMissionWorkerCoreDispatcher` (a plugin or test double) still
 * makes the sole seam reject the builtin.
 */
export function installBuiltinMissionWorkerCoreDispatcher(
  next: MissionWorkerCoreDispatcher
): () => void {
  releaseBuiltinDispatcher?.();
  const dispose = registerMissionWorkerCoreDispatcher(next);
  const release = () => {
    dispose();
    if (releaseBuiltinDispatcher === release) releaseBuiltinDispatcher = null;
  };
  releaseBuiltinDispatcher = release;
  return release;
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
