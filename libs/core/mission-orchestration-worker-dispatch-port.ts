import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from './seam.js';

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
  source: 'libs/core/mission-orchestration-worker-dispatch-port.ts',
  reason: 'mission worker core dispatch registration',
};

export function registerMissionWorkerCoreDispatcher(
  next: MissionWorkerCoreDispatcher,
  metadata: SeamProviderMetadata = DEFAULT_METADATA
): () => void {
  return missionWorkerCoreDispatcherSeam.register('mission-worker-core', next, metadata);
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
