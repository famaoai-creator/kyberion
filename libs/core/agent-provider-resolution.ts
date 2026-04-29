import { discoverProviders, type ProviderInfo } from './provider-discovery.js';

export interface ResolveAgentProviderOptions {
  preferredProvider: string;
  preferredModelId?: string;
  providerStrategy?: 'strict' | 'preferred' | 'adaptive';
  fallbackProviders?: string[];
  requiredCapabilities?: string[];
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

function normalizeSet(values?: string[]): Set<string> {
  return new Set((values || []).map((entry) => entry.trim().toLowerCase()).filter(Boolean));
}

function capabilityScore(have: string[] | undefined, required: string[] | undefined): number {
  if (!required || required.length === 0) return 0;
  const haveSet = normalizeSet(have);
  let score = 0;
  for (const capability of required) {
    if (haveSet.has(capability.trim().toLowerCase())) score += 1;
  }
  return score;
}

function capabilityCoverage(have: string[] | undefined, required: string[] | undefined): boolean {
  if (!required || required.length === 0) return true;
  const haveSet = normalizeSet(have);
  return required.every((capability) => haveSet.has(capability.trim().toLowerCase()));
}

function providerCapabilities(providerInfo?: ProviderInfo): string[] {
  if (!providerInfo) return [];
  const capabilities = new Set((providerInfo.capabilities || []).map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  for (const modelCapabilities of Object.values(providerInfo.modelCapabilities || {})) {
    for (const capability of modelCapabilities || []) {
      capabilities.add(capability.trim().toLowerCase());
    }
  }
  return Array.from(capabilities);
}

function modelCapabilities(providerInfo: ProviderInfo | undefined, modelId: string | undefined): string[] {
  if (!providerInfo || !modelId) return [];
  return providerInfo.modelCapabilities?.[modelId] || [];
}

function defaultModelFor(provider: string, providerInfo?: ProviderInfo): string {
  if (providerInfo?.models?.length) return providerInfo.models[0]!;
  return DEFAULT_MODELS[provider] || provider;
}

function scoreModelCandidate(
  providerInfo: ProviderInfo | undefined,
  modelId: string,
  requiredCapabilities: string[] | undefined,
  preferredModelId?: string,
): number {
  const caps = modelCapabilities(providerInfo, modelId);
  const matched = capabilityScore(caps, requiredCapabilities);
  const coverageBonus = capabilityCoverage(caps, requiredCapabilities) ? 100 : 0;
  const preferredBonus = preferredModelId && preferredModelId === modelId ? 10 : 0;
  return coverageBonus + matched + preferredBonus;
}

function pickBestModel(
  providerInfo: ProviderInfo | undefined,
  requiredCapabilities: string[] | undefined,
  preferredModelId?: string,
): string {
  const models = providerInfo?.models || [];
  if (preferredModelId && (models.length === 0 || models.includes(preferredModelId))) {
    if (capabilityCoverage(modelCapabilities(providerInfo, preferredModelId), requiredCapabilities)) {
      return preferredModelId;
    }
  }
  if (models.length === 0) return preferredModelId || defaultModelFor(providerInfo?.provider || '');
  const scored = models
    .map((modelId) => ({
      modelId,
      score: scoreModelCandidate(providerInfo, modelId, requiredCapabilities, preferredModelId),
    }))
    .sort((left, right) => right.score - left.score || left.modelId.localeCompare(right.modelId));
  return scored[0]?.modelId || preferredModelId || defaultModelFor(providerInfo?.provider || '');
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
  const requiredCapabilities = (options.requiredCapabilities || []).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const fallbackAllowlist = (options.fallbackProviders || [])
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const fallbackCandidates = fallbackAllowlist.length > 0
    ? installedProviders.filter((entry) => fallbackAllowlist.includes(entry.provider))
    : installedProviders;
  const nonPreferredFallbackCandidates = fallbackCandidates.filter((entry) => entry.provider !== preferredProvider);
  const effectiveFallbackCandidates = nonPreferredFallbackCandidates.length > 0
    ? nonPreferredFallbackCandidates
    : fallbackCandidates;
  const preferredInstalled = installedProviders.find((entry) => entry.provider === preferredProvider);

  if (preferredInstalled) {
    const preferredCapabilities = providerCapabilities(preferredInstalled);
    const preferredScore = capabilityScore(preferredCapabilities, requiredCapabilities);
    const bestFallbackScore = effectiveFallbackCandidates.length > 0
      ? Math.max(...effectiveFallbackCandidates.map((entry) => capabilityScore(providerCapabilities(entry), requiredCapabilities)))
      : Number.NEGATIVE_INFINITY;
    if (
      (options.providerStrategy || 'adaptive') === 'strict' ||
      requiredCapabilities.length === 0 ||
      preferredScore >= bestFallbackScore
    ) {
      return {
        provider: preferredProvider,
        modelId: pickBestModel(preferredInstalled, requiredCapabilities, options.preferredModelId),
        strategy: preferredScore > 0 || requiredCapabilities.length === 0 ? 'preferred' : 'unresolved',
        availableProviders,
      };
    }
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

  const effectiveCandidates = effectiveFallbackCandidates.length > 0
    ? nonPreferredFallbackCandidates
    : fallbackCandidates;

  if (effectiveCandidates.length === 0) {
    return {
      provider: preferredProvider,
      modelId: options.preferredModelId || defaultModelFor(preferredProvider),
      strategy: 'unresolved',
      availableProviders,
    };
  }

  const priority = resolvePriority(preferredProvider);
  const fallback = [...effectiveCandidates].sort((left, right) => {
    const leftRank = priority.indexOf(left.provider);
    const rightRank = priority.indexOf(right.provider);
    const leftScore = capabilityScore(providerCapabilities(left), requiredCapabilities);
    const rightScore = capabilityScore(providerCapabilities(right), requiredCapabilities);
    return (
      (rightScore - leftScore) ||
      ((leftRank >= 0 ? leftRank : Number.MAX_SAFE_INTEGER) - (rightRank >= 0 ? rightRank : Number.MAX_SAFE_INTEGER))
    );
  })[0]!;

  return {
    provider: fallback.provider,
    modelId: pickBestModel(fallback, requiredCapabilities, options.preferredModelId),
    strategy: 'fallback',
    availableProviders,
  };
}
