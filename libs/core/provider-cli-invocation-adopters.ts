import type { CapabilityRegistryEntry } from './provider-capability-scanner.js';

export interface ProviderInvocationParams {
  capabilityId: string;
  args?: string[];
  payload?: unknown;
}

export interface ProviderInvocationPlan {
  bin: string;
  args: string[];
}

export interface ProviderCliInvocationAdopter {
  readonly adopter_id: string;
  readonly binary?: string;
  buildPlan(
    capability: CapabilityRegistryEntry,
    params: ProviderInvocationParams,
    bin: string,
    payloadText: string
  ): ProviderInvocationPlan;
}

function commandPlan(name: string, args: string[], bin: string): ProviderInvocationPlan {
  return { bin, args: [name, ...args] };
}

function requirePayload(payloadText: string, capabilityId: string, adopterId: string): void {
  if (!payloadText) {
    throw new Error(`[PROVIDER_BRIDGE] ${adopterId} requires payload: ${capabilityId}`);
  }
}

const genericCliAdopter: ProviderCliInvocationAdopter = {
  adopter_id: 'generic-cli',
  buildPlan: (capability, params, bin) =>
    commandPlan(capability.source.name, params.args ?? [], bin),
};

const geminiCliAdopter: ProviderCliInvocationAdopter = {
  adopter_id: 'gemini-cli',
  binary: 'gemini',
  buildPlan(capability, params, bin, payloadText) {
    if (capability.source.name !== 'prompt') {
      return commandPlan(capability.source.name, params.args ?? [], bin);
    }
    requirePayload(payloadText, params.capabilityId, this.adopter_id);
    return { bin, args: ['-p', payloadText, '-o', 'json', '-y', ...(params.args ?? [])] };
  },
};

const codexCliAdopter: ProviderCliInvocationAdopter = {
  adopter_id: 'codex-cli',
  binary: 'codex',
  buildPlan(capability, params, bin, payloadText) {
    if (capability.source.name !== 'exec') {
      return commandPlan(capability.source.name, params.args ?? [], bin);
    }
    requirePayload(payloadText, params.capabilityId, this.adopter_id);
    return { bin, args: ['exec', '--json', payloadText, ...(params.args ?? [])] };
  },
};

const githubCliAdopter: ProviderCliInvocationAdopter = {
  adopter_id: 'github-cli',
  binary: 'gh',
  buildPlan(capability, params, bin) {
    if (capability.source.name === 'run-workflow') {
      return { bin, args: ['workflow', 'run', ...(params.args ?? [])] };
    }
    return commandPlan(capability.source.name, params.args ?? [], bin);
  },
};

const PROVIDER_CLI_ADOPTERS: Readonly<Record<string, ProviderCliInvocationAdopter>> = {
  'gemini-cli': geminiCliAdopter,
  'codex-cli': codexCliAdopter,
  gh: githubCliAdopter,
};

export function resolveProviderCliInvocationAdopter(
  providerId: string
): ProviderCliInvocationAdopter {
  return PROVIDER_CLI_ADOPTERS[providerId] ?? genericCliAdopter;
}

export function resolveProviderCliBinary(providerId: string): string {
  return resolveProviderCliInvocationAdopter(providerId).binary || providerId.replace('-cli', '');
}
