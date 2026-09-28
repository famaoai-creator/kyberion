import type { SpawnOptions } from './agent-lifecycle.js';

export interface EnsureAgentRuntimeOptions extends SpawnOptions {
  requestedBy: string;
  runtimeMetadata?: Record<string, unknown>;
  runtimeOwnerId?: string;
  runtimeOwnerType?: string;
}
