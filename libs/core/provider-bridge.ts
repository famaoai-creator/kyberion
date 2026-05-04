import { buildSafeExecEnv, safeExec } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import {
  loadCapabilityRegistry,
  type CapabilityRegistryEntry,
  type DiscoveredCapability,
  scanProviderCapabilities,
} from './provider-capability-scanner.js';
import { logger } from './core.js';

export interface ProviderInvokeParams {
  capabilityId: string;
  args?: string[];
  payload?: unknown;
  context?: Record<string, unknown>;
}

type InvocationPlan = {
  bin: string;
  args: string[];
};

let cachedCapabilities: DiscoveredCapability[] | null = null;

function getAvailableCapabilities(): DiscoveredCapability[] {
  if (!cachedCapabilities) {
    const registry = loadCapabilityRegistry();
    cachedCapabilities = scanProviderCapabilities(registry, undefined, { includeUnavailable: false });
  }
  return cachedCapabilities;
}

export function resetProviderCapabilityCache(): void {
  cachedCapabilities = null;
}

function normalizePayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload);
}

function resolveProviderBinary(provider: string): string {
  if (provider === 'gh') return 'gh';
  if (provider === 'gemini-cli') return 'gemini';
  if (provider === 'codex-cli') return 'codex';
  return provider.replace('-cli', '');
}

export function buildProviderInvocationPlan(
  capability: CapabilityRegistryEntry,
  params: ProviderInvokeParams,
): InvocationPlan {
  if (capability.source.type !== 'cli_native') {
    throw new Error(`[PROVIDER_BRIDGE] Capability is not CLI-native: ${capability.capability_id}`);
  }

  const bin = resolveProviderBinary(capability.source.provider);
  const name = capability.source.name;
  const extraArgs = params.args ?? [];
  const payloadText = params.payload === undefined || params.payload === null ? '' : normalizePayload(params.payload);

  if (capability.source.provider === 'gemini-cli') {
    if (name === 'prompt') {
      if (!payloadText) {
        throw new Error(`[PROVIDER_BRIDGE] Gemini prompt requires payload: ${capability.capability_id}`);
      }
      return {
        bin,
        args: [
          '-p',
          payloadText,
          '-o',
          'json',
          '-y',
          ...extraArgs,
        ],
      };
    }

    return {
      bin,
      args: [name, ...extraArgs],
    };
  }

  if (capability.source.provider === 'codex-cli') {
    if (name === 'exec') {
      if (!payloadText) {
        throw new Error(`[PROVIDER_BRIDGE] Codex exec requires payload: ${capability.capability_id}`);
      }
      return {
        bin,
        args: ['exec', '--json', payloadText, ...extraArgs],
      };
    }

    return {
      bin,
      args: [name, ...extraArgs],
    };
  }

  if (capability.source.provider === 'gh') {
    if (name === 'run-workflow') {
      return {
        bin,
        args: ['workflow', 'run', ...extraArgs],
      };
    }
    return {
      bin,
      args: [name, ...extraArgs],
    };
  }

  return {
    bin,
    args: [name, ...extraArgs],
  };
}

/**
 * Universal Provider Bridge — invokes host-native or provider-native CLI tools
 * based on the registered capability metadata.
 */
export async function invokeProviderCapability(params: ProviderInvokeParams): Promise<string> {
  const capability = getAvailableCapabilities().find((c) => c.capability_id === params.capabilityId);
  if (!capability) {
    throw new Error(`[PROVIDER_BRIDGE] Capability not found or not available: ${params.capabilityId}`);
  }

  const { provider, name } = capability.source;
  logger.info(`[PROVIDER_BRIDGE] Invoking ${provider}::${name} (${params.capabilityId})`);

  const plan = buildProviderInvocationPlan(capability, params);

  try {
    const stdout = safeExec(plan.bin, plan.args, {
      cwd: pathResolver.rootDir(),
      env: buildSafeExecEnv(),
    });
    return stdout.trim();
  } catch (err: any) {
    throw new Error(`[PROVIDER_BRIDGE] Execution failed for ${params.capabilityId}: ${err.message}`);
  }
}

/**
 * Maps a domain:action string from ADF to a capability_id in the registry.
 */
export function resolveProviderCapabilityId(domain: string, action: string): string | null {
  const registry = loadCapabilityRegistry();
  const entry = registry.capabilities.find((c) => {
    if (c.source.type !== 'cli_native') return false;
    const p = c.source.provider.replace('-cli', '');
    return (p === domain || c.source.provider === domain) && c.source.name === action;
  });
  return entry ? entry.capability_id : null;
}
