import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from './seam.js';

export type SuperNerveExecutor = (
  steps: unknown,
  initialContext?: Record<string, unknown>,
  options?: Record<string, unknown>
) => Promise<unknown>;

const superNerveExecutorSeam = createSeam<SuperNerveExecutor>({
  key: 'super-nerve-executor',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
});

const DEFAULT_METADATA: SeamProviderMetadata = {
  provenance: 'builtin',
  source: 'libs/core/super-nerve-execution-port.ts',
  reason: 'Super-Nerve executor registration',
};

export function registerSuperNerveExecutor(
  next: SuperNerveExecutor,
  metadata: SeamProviderMetadata = DEFAULT_METADATA
): () => void {
  return superNerveExecutorSeam.register('super-nerve', next, metadata);
}

export async function executeRegisteredSuperPipeline(
  steps: unknown,
  initialContext: Record<string, unknown> = {},
  options: Record<string, unknown> = {}
): Promise<unknown> {
  const executor = superNerveExecutorSeam.getOptional();
  if (!executor) throw new Error('Super-Nerve executor is not initialized');
  return executor(steps, initialContext, options);
}
