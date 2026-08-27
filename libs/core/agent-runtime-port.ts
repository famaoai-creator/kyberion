import type { AgentHandle } from './agent-lifecycle.js';
import type { EnsureAgentRuntimeOptions } from './agent-runtime-contracts.js';

export type AgentRuntimeEnsurer = (options: EnsureAgentRuntimeOptions) => Promise<AgentHandle>;

let ensurer: AgentRuntimeEnsurer | null = null;

export function registerAgentRuntimeEnsurer(next: AgentRuntimeEnsurer): void {
  ensurer = next;
}

export async function ensureAgentRuntime(options: EnsureAgentRuntimeOptions): Promise<AgentHandle> {
  if (!ensurer) {
    throw new Error(
      'Agent runtime supervisor is not initialized; ensure the governed runtime supervisor is active before spawning a mission team.'
    );
  }
  return ensurer(options);
}
