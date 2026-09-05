import type { AgentHandle } from './agent-lifecycle.js';
import type { EnsureAgentRuntimeOptions } from './agent-runtime-contracts.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from './seam.js';

export type AgentRuntimeEnsurer = (options: EnsureAgentRuntimeOptions) => Promise<AgentHandle>;

const agentRuntimeEnsurerSeam = createSeam<AgentRuntimeEnsurer>({
  key: 'agent-runtime-ensurer',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
});

const DEFAULT_METADATA: SeamProviderMetadata = {
  provenance: 'builtin',
  source: 'libs/core/agent-runtime-port.ts',
  reason: 'runtime supervisor registration',
};

export function registerAgentRuntimeEnsurer(
  next: AgentRuntimeEnsurer,
  metadata: SeamProviderMetadata = DEFAULT_METADATA
): () => void {
  return agentRuntimeEnsurerSeam.register('runtime-supervisor', next, metadata);
}

export async function ensureAgentRuntime(options: EnsureAgentRuntimeOptions): Promise<AgentHandle> {
  const ensurer = agentRuntimeEnsurerSeam.getOptional();
  if (!ensurer) {
    throw new Error(
      'Agent runtime supervisor is not initialized; ensure the governed runtime supervisor is active before spawning a mission team.'
    );
  }
  return ensurer(options);
}
