/**
 * Agent pane-runtime bridge seam.
 *
 * Launch modes:
 * - `pipe` — default ACP/exec stdio children (no pane bridge)
 * - `pane` — interactive provider CLIs inside a terminal-multiplexer pane
 *
 * Concrete multiplexer vendors register as named providers on this seam.
 * Callers (lifecycle, A2A) only speak `pipe` | `pane` and never name a vendor.
 */

import type { AgentAdapter } from './agent-adapter.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { coreSeamCatalog, createSeam } from './seam.js';

export const AGENT_RUNTIME_LAUNCH_MODES = ['pipe', 'pane'] as const;
export type AgentRuntimeLaunchMode = (typeof AGENT_RUNTIME_LAUNCH_MODES)[number];

export interface AgentPaneRuntimeSpawnRequest {
  agentId: string;
  provider: string;
  modelId?: string;
  cwd?: string;
  systemPrompt?: string;
  workspaceLabel?: string;
  bootTimeoutMs?: number;
  turnTimeoutMs?: number;
}

export interface AgentPaneRuntimeProbe {
  available: boolean;
  reason?: string;
}

export interface AgentPaneRuntimeBridge {
  readonly bridge_id: string;
  probe(): Promise<AgentPaneRuntimeProbe>;
  createAdapter(request: AgentPaneRuntimeSpawnRequest): AgentAdapter;
}

const paneRuntimeSeam = createSeam<AgentPaneRuntimeBridge>({
  key: 'agent-pane-runtime-bridge',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});

const registeredDisposers = new Map<string, () => void>();

export function registerAgentPaneRuntimeBridge(bridge: AgentPaneRuntimeBridge): () => void {
  const id = String(bridge.bridge_id || '').trim();
  if (!id) throw new Error('AgentPaneRuntimeBridge.bridge_id is required');
  registeredDisposers.get(id)?.();
  const disposer = paneRuntimeSeam.register(id, bridge, {
    provenance: 'builtin',
    source: 'agent-pane-runtime-bridge',
  });
  registeredDisposers.set(id, disposer);
  return disposer;
}

export function resetAgentPaneRuntimeBridges(): void {
  for (const dispose of registeredDisposers.values()) {
    try {
      dispose();
    } catch {
      /* noop */
    }
  }
  registeredDisposers.clear();
}

export function listAgentPaneRuntimeBridges(): AgentPaneRuntimeBridge[] {
  return paneRuntimeSeam.list().map((provider) => provider.implementation);
}

export function parseAgentRuntimeLaunchMode(value: unknown): AgentRuntimeLaunchMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return AGENT_RUNTIME_LAUNCH_MODES.includes(normalized as AgentRuntimeLaunchMode)
    ? (normalized as AgentRuntimeLaunchMode)
    : undefined;
}

/**
 * Resolve launch mode for one spawn/ensure.
 * Explicit per-request values beat the process env default.
 */
export function resolveAgentRuntimeLaunchMode(
  input: {
    runtimeBackend?: unknown;
    runtimeMetadata?: Record<string, unknown>;
    env?: Record<string, string | undefined>;
  } = {}
): AgentRuntimeLaunchMode {
  const fromOption = parseAgentRuntimeLaunchMode(input.runtimeBackend);
  if (fromOption) return fromOption;
  const fromMeta = parseAgentRuntimeLaunchMode(input.runtimeMetadata?.runtime_backend);
  if (fromMeta) return fromMeta;
  const env = input.env ?? process.env;
  const fromEnv = parseAgentRuntimeLaunchMode(
    getRegisteredEnvText('KYBERION_AGENT_RUNTIME_BACKEND', { env }) ||
      env.KYBERION_AGENT_RUNTIME_BACKEND
  );
  return fromEnv ?? 'pipe';
}

export function isPaneRuntimeLaunchEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return resolveAgentRuntimeLaunchMode({ env }) === 'pane';
}

function preferredPaneProviderId(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const raw =
    getRegisteredEnvText('KYBERION_AGENT_PANE_RUNTIME_PROVIDER', { env }) ||
    env.KYBERION_AGENT_PANE_RUNTIME_PROVIDER ||
    '';
  const trimmed = String(raw).trim();
  return trimmed || undefined;
}

async function ensureBuiltinPaneProviders(): Promise<void> {
  // Builtin providers are registered by side-effect import from lifecycle/A2A.
}

/**
 * Resolve a pane-runtime vendor bridge. Preference comes from
 * KYBERION_AGENT_PANE_RUNTIME_PROVIDER, else the first probed-available provider.
 */
export async function resolveAgentPaneRuntimeBridge(
  preference?: string
): Promise<AgentPaneRuntimeBridge> {
  await ensureBuiltinPaneProviders();
  const bridges = listAgentPaneRuntimeBridges();
  if (bridges.length === 0) {
    throw new Error(
      '[agent-pane-runtime] no pane runtime providers registered; install a terminal multiplexer adapter'
    );
  }
  const wanted =
    String(preference || preferredPaneProviderId() || 'auto')
      .trim()
      .toLowerCase() || 'auto';

  if (wanted !== 'auto') {
    const exact = bridges.find((bridge) => bridge.bridge_id.toLowerCase() === wanted);
    if (!exact) {
      throw new Error(
        `[agent-pane-runtime] provider '${wanted}' is not registered (have: ${bridges
          .map((b) => b.bridge_id)
          .join(', ')})`
      );
    }
    const probe = await exact.probe();
    if (!probe.available) {
      throw new Error(
        `[agent-pane-runtime] provider '${wanted}' is unavailable: ${probe.reason || 'unknown'}`
      );
    }
    return exact;
  }

  const reasons: string[] = [];
  for (const bridge of bridges) {
    const probe = await bridge.probe();
    if (probe.available) return bridge;
    reasons.push(`${bridge.bridge_id}: ${probe.reason || 'unavailable'}`);
  }
  throw new Error(
    `[agent-pane-runtime] no pane runtime provider is available (${reasons.join('; ')})`
  );
}

export async function createAgentPaneRuntimeAdapter(
  request: AgentPaneRuntimeSpawnRequest,
  preference?: string
): Promise<AgentAdapter> {
  const bridge = await resolveAgentPaneRuntimeBridge(preference);
  return bridge.createAdapter(request);
}
