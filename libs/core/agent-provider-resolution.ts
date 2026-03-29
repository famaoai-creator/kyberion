import { discoverProviders, type ProviderInfo } from './provider-discovery.js';

export interface ResolveAgentProviderOptions {
  preferredProvider: string;
  preferredModelId?: string;
  providerStrategy?: 'strict' | 'preferred' | 'adaptive';
  fallbackProviders?: string[];
}

export interface ResolvedAgentProviderTarget {
  provider: string;
  modelId: string;
  strategy: 'preferred' | 'fallback' | 'unresolved';
  availableProviders: string[];
}

const DEFAULT_PROVIDER_PRIORITY = ['gemini', 'claude', 'codex', 'copilot'];

const DEFAULT_MODELS: Record<string, string> = {
  gemini: 'gemini-2.5-flash',
  claude: 'sonnet',
  codex: 'codex',
  copilot: 'gpt-5.4',
};

function defaultModelFor(provider: string, providerInfo?: ProviderInfo): string {
  if (providerInfo?.models?.length) return providerInfo.models[0]!;
  return DEFAULT_MODELS[provider] || provider;
}

function resolvePriority(preferredProvider: string): string[] {
  const envPriority = (process.env.KYBERION_PROVIDER_PRIORITY || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set([preferredProvider, ...envPriority, ...DEFAULT_PROVIDER_PRIORITY]));
}

export function resolveAgentProviderTarget(
  options: ResolveAgentProviderOptions,
  discoveredProviders = discoverProviders(),
): ResolvedAgentProviderTarget {
  const installedProviders = discoveredProviders.filter((entry) => entry.installed && entry.healthy);
  const availableProviders = installedProviders.map((entry) => entry.provider);
  const preferredProvider = options.preferredProvider;
  const preferredInstalled = installedProviders.find((entry) => entry.provider === preferredProvider);

  if (preferredInstalled) {
    return {
      provider: preferredProvider,
      modelId: options.preferredModelId || defaultModelFor(preferredProvider, preferredInstalled),
      strategy: 'preferred',
      availableProviders,
    };
  }

  if ((options.providerStrategy || 'adaptive') === 'strict') {
    return {
      provider: preferredProvider,
      modelId: options.preferredModelId || defaultModelFor(preferredProvider),
      strategy: 'unresolved',
      availableProviders,
    };
  }

  if (installedProviders.length === 0) {
    return {
      provider: preferredProvider,
      modelId: options.preferredModelId || defaultModelFor(preferredProvider),
      strategy: 'unresolved',
      availableProviders,
    };
  }

  const fallbackAllowlist = (options.fallbackProviders || [])
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const fallbackCandidates = fallbackAllowlist.length > 0
    ? installedProviders.filter((entry) => fallbackAllowlist.includes(entry.provider))
    : installedProviders;

  if (fallbackCandidates.length === 0) {
    return {
      provider: preferredProvider,
      modelId: options.preferredModelId || defaultModelFor(preferredProvider),
      strategy: 'unresolved',
      availableProviders,
    };
  }

  const priority = resolvePriority(preferredProvider);
  const fallback = [...fallbackCandidates].sort((left, right) => {
    const leftRank = priority.indexOf(left.provider);
    const rightRank = priority.indexOf(right.provider);
    return (leftRank >= 0 ? leftRank : Number.MAX_SAFE_INTEGER) - (rightRank >= 0 ? rightRank : Number.MAX_SAFE_INTEGER);
  })[0]!;

  return {
    provider: fallback.provider,
    modelId: defaultModelFor(fallback.provider, fallback),
    strategy: 'fallback',
    availableProviders,
  };
}
