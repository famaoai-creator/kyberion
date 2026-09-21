/**
 * Agent exec-adapter bridge seam.
 *
 * Pipe/stdio AgentAdapter factories register here. Lifecycle selects by
 * provider id and never imports concrete Claude/Codex/… adapter classes.
 */

import type { AgentAdapter } from './agent-adapter.js';
import { coreSeamCatalog, createSeam } from './seam.js';

export interface AgentExecAdapterRequest {
  provider: string;
  modelId?: string;
  cwd?: string;
  systemPrompt?: string;
  effort?: 'low' | 'medium' | 'high';
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Manifest actuator allow-list; Claude provider maps these to CLI tool flags. */
  allowedActuators?: string[];
  deniedActuators?: string[];
}

export interface AgentExecAdapterBridge {
  readonly bridge_id: string;
  createAdapter(request: AgentExecAdapterRequest): AgentAdapter;
}

const execAdapterSeam = createSeam<AgentExecAdapterBridge>({
  key: 'agent-exec-adapter-bridge',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});

const registeredDisposers = new Map<string, () => void>();

export function registerAgentExecAdapterBridge(bridge: AgentExecAdapterBridge): () => void {
  const id = String(bridge.bridge_id || '').trim();
  if (!id) throw new Error('AgentExecAdapterBridge.bridge_id is required');
  registeredDisposers.get(id)?.();
  const disposer = execAdapterSeam.register(id, bridge, {
    provenance: 'builtin',
    source: 'agent-exec-adapter-bridge',
  });
  registeredDisposers.set(id, disposer);
  return disposer;
}

export function resetAgentExecAdapterBridges(): void {
  for (const dispose of registeredDisposers.values()) {
    try {
      dispose();
    } catch {
      /* noop */
    }
  }
  registeredDisposers.clear();
}

export function listAgentExecAdapterBridges(): AgentExecAdapterBridge[] {
  return execAdapterSeam.list().map((provider) => provider.implementation);
}

async function ensureBuiltinExecAdapters(): Promise<void> {
  // Builtin providers are registered by side-effect import from lifecycle.
}

/** True when a named exec-adapter provider is registered for this provider id. */
export async function hasAgentExecAdapter(provider: string): Promise<boolean> {
  await ensureBuiltinExecAdapters();
  const id = String(provider || '')
    .trim()
    .toLowerCase();
  return listAgentExecAdapterBridges().some((bridge) => bridge.bridge_id === id);
}

export async function createAgentExecAdapter(
  request: AgentExecAdapterRequest
): Promise<AgentAdapter> {
  await ensureBuiltinExecAdapters();
  const id = String(request.provider || '')
    .trim()
    .toLowerCase();
  const bridge = listAgentExecAdapterBridges().find((entry) => entry.bridge_id === id);
  if (!bridge) {
    throw new Error(
      `[agent-exec-adapter] no exec adapter registered for provider '${request.provider}'`
    );
  }
  return bridge.createAdapter({ ...request, provider: id });
}
