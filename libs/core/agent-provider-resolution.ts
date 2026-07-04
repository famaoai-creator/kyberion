import { discoverProviders, type ProviderInfo } from './provider-discovery.js';
import { loadProviderConfig } from './provider-config.js';
import { resolveRuntimeModelId } from './runtime-model-defaults.js';

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
  const capabilities = new Set(
    (providerInfo.capabilities || []).map((entry) => entry.trim().toLowerCase()).filter(Boolean)
  );
  for (const modelCapabilities of Object.values(providerInfo.modelCapabilities || {})) {
    for (const capability of modelCapabilities || []) {
      capabilities.add(capability.trim().toLowerCase());
    }
  }
  return Array.from(capabilities);
}

function modelCapabilities(
  providerInfo: ProviderInfo | undefined,
  modelId: string | undefined
): string[] {
  if (!providerInfo || !modelId) return [];
  return providerInfo.modelCapabilities?.[modelId] || [];
}

function defaultModelFor(provider: string, providerInfo?: ProviderInfo): string {
  if (providerInfo?.models?.length) return providerInfo.models[0]!;
  return loadProviderConfig().default_models[provider] || provider;
}

function scoreModelCandidate(
  providerInfo: ProviderInfo | undefined,
  modelId: string,
  requiredCapabilities: string[] | undefined,
  preferredModelId?: string
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
  preferredModelId?: string
): string {
  const models = providerInfo?.models || [];
  if (preferredModelId && (models.length === 0 || models.includes(preferredModelId))) {
    if (
      capabilityCoverage(modelCapabilities(providerInfo, preferredModelId), requiredCapabilities)
    ) {
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
  return Array.from(
    new Set([preferredProvider, ...envPriority, ...loadProviderConfig().default_priority])
  );
}

export function resolveAgentProviderTarget(
  options: ResolveAgentProviderOptions,
  discoveredProviders = discoverProviders()
): ResolvedAgentProviderTarget {
  const installedProviders = discoveredProviders.filter(
    (entry) => entry.installed && entry.healthy
  );
  const availableProviders = installedProviders.map((entry) => entry.provider);
  const preferredProvider = options.preferredProvider;
  const requiredCapabilities = (options.requiredCapabilities || [])
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const fallbackAllowlist = (options.fallbackProviders || [])
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const fallbackCandidates =
    fallbackAllowlist.length > 0
      ? installedProviders.filter((entry) => fallbackAllowlist.includes(entry.provider))
      : installedProviders;
  const nonPreferredFallbackCandidates = fallbackCandidates.filter(
    (entry) => entry.provider !== preferredProvider
  );
  const effectiveFallbackCandidates =
    nonPreferredFallbackCandidates.length > 0 ? nonPreferredFallbackCandidates : fallbackCandidates;
  const preferredInstalled = installedProviders.find(
    (entry) => entry.provider === preferredProvider
  );

  if (preferredInstalled) {
    const preferredCapabilities = providerCapabilities(preferredInstalled);
    const preferredScore = capabilityScore(preferredCapabilities, requiredCapabilities);
    const bestFallbackScore =
      effectiveFallbackCandidates.length > 0
        ? Math.max(
            ...effectiveFallbackCandidates.map((entry) =>
              capabilityScore(providerCapabilities(entry), requiredCapabilities)
            )
          )
        : Number.NEGATIVE_INFINITY;
    if (
      (options.providerStrategy || 'adaptive') === 'strict' ||
      requiredCapabilities.length === 0 ||
      preferredScore >= bestFallbackScore
    ) {
      return {
        provider: preferredProvider,
        modelId: pickBestModel(preferredInstalled, requiredCapabilities, options.preferredModelId),
        strategy:
          preferredScore > 0 || requiredCapabilities.length === 0 ? 'preferred' : 'unresolved',
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

  const effectiveCandidates =
    effectiveFallbackCandidates.length > 0 ? nonPreferredFallbackCandidates : fallbackCandidates;

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
      rightScore - leftScore ||
      (leftRank >= 0 ? leftRank : Number.MAX_SAFE_INTEGER) -
        (rightRank >= 0 ? rightRank : Number.MAX_SAFE_INTEGER)
    );
  })[0]!;

  return {
    provider: fallback.provider,
    modelId: pickBestModel(fallback, requiredCapabilities, options.preferredModelId),
    strategy: 'fallback',
    availableProviders,
  };
}

/**
 * Requirement-first resolution.
 *
 * Unlike resolveAgentProviderTarget (which is provider-first: "use claude, fall back if needed"),
 * this is intent-first: the caller declares the capabilities it needs and stays agnostic about
 * which model satisfies them. The result adapts to whatever is installed in the current
 * environment — one provider at work, a different set at home — without changing call sites.
 *
 * Graceful degrade:
 *   - 0 installed providers  -> unresolved (preferred/default echoed back so callers still have a target)
 *   - exactly 1 installed    -> use it, even if it doesn't cover the requirements (you can't pick what
 *                               you don't have); unmetCapabilities reports the gap
 *   - many installed         -> score by capability coverage, preferring `preferredProvider` as a hint
 *
 * `excludeProviders` lets a health layer (rate-limit failover) demote providers; if demotion would
 * leave nothing, the demotion is ignored and the result is flagged `degraded` rather than failing.
 */
/**
 * Orchestration tier requested by a task.
 *
 * - `leaf`: a single prompt-in / result-out call. Use this when Kyberion has ALREADY decomposed
 *   the work into worker tasks — running each leaf on a provider that would fan out again causes
 *   double orchestration (and loses Kyberion's audit of the inner fan-out).
 * - `managed_workflow`: the task is a coarse goal the provider may decompose itself, fanning out
 *   sub-agents under a recorded execution journal. Only providers advertising `managed_workflow`
 *   (e.g. claude) qualify — gemini YOLO-style delegation, which leaves no journal, does not.
 */
export type OrchestrationTier = 'leaf' | 'managed_workflow';

export interface CapabilityResolveOptions {
  requiredCapabilities?: string[];
  preferredProvider?: string;
  preferredModelId?: string;
  fallbackProviders?: string[];
  excludeProviders?: string[];
  orchestration?: OrchestrationTier;
}

export interface CapabilityResolution {
  provider: string;
  modelId: string;
  strategy: 'sole' | 'preferred' | 'best-match' | 'degraded' | 'unresolved';
  availableProviders: string[];
  requiredCapabilities: string[];
  unmetCapabilities: string[];
  orchestration: OrchestrationTier;
  rationale: string;
}

function combinedCapabilities(info: ProviderInfo | undefined, modelId: string): string[] {
  const have = new Set(providerCapabilities(info));
  for (const capability of modelCapabilities(info, modelId))
    have.add(capability.trim().toLowerCase());
  return Array.from(have);
}

function computeUnmet(
  info: ProviderInfo | undefined,
  modelId: string,
  required: string[]
): string[] {
  if (required.length === 0) return [];
  const have = normalizeSet(combinedCapabilities(info, modelId));
  return required.filter((capability) => !have.has(capability.trim().toLowerCase()));
}

export function resolveCapabilityTarget(
  options: CapabilityResolveOptions,
  discoveredProviders = discoverProviders()
): CapabilityResolution {
  const orchestration: OrchestrationTier = options.orchestration || 'leaf';
  // A managed-workflow task must land on a provider that can run a recorded fan-out.
  const baseRequired = (options.requiredCapabilities || [])
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const requiredCapabilities =
    orchestration === 'managed_workflow'
      ? Array.from(new Set([...baseRequired, 'managed_workflow']))
      : baseRequired;
  const installed = discoveredProviders.filter((entry) => entry.installed && entry.healthy);
  const availableProviders = installed.map((entry) => entry.provider);

  const unresolved = (rationale: string): CapabilityResolution => ({
    provider: options.preferredProvider || loadProviderConfig().default_priority[0]!,
    modelId:
      options.preferredModelId ||
      defaultModelFor(options.preferredProvider || loadProviderConfig().default_priority[0]!),
    strategy: 'unresolved',
    availableProviders,
    requiredCapabilities,
    unmetCapabilities: requiredCapabilities,
    orchestration,
    rationale,
  });

  if (installed.length === 0) {
    return unresolved('no providers installed; echoing preferred/default target');
  }

  // Apply optional allowlist (always keep the preferred provider as a candidate).
  const allowlist = normalizeSet(options.fallbackProviders);
  let candidates =
    allowlist.size > 0
      ? installed.filter(
          (entry) => allowlist.has(entry.provider) || entry.provider === options.preferredProvider
        )
      : installed;
  if (candidates.length === 0) candidates = installed;

  // Apply health-based exclusions, but never strand the caller: if exclusion empties the pool,
  // fall back to the full pool and let the result read as `degraded`.
  const excluded = normalizeSet(options.excludeProviders);
  let demotionIgnored = false;
  if (excluded.size > 0) {
    const surviving = candidates.filter((entry) => !excluded.has(entry.provider));
    if (surviving.length > 0) {
      candidates = surviving;
    } else {
      demotionIgnored = true;
    }
  }

  const priority = resolvePriority(
    options.preferredProvider || loadProviderConfig().default_priority[0]!
  );
  const scoreOf = (entry: ProviderInfo): number => {
    const covers = capabilityCoverage(providerCapabilities(entry), requiredCapabilities) ? 1000 : 0;
    const matched = capabilityScore(providerCapabilities(entry), requiredCapabilities);
    const preferredBonus = entry.provider === options.preferredProvider ? 50 : 0;
    return covers + matched + preferredBonus;
  };

  const ranked = [...candidates].sort((left, right) => {
    const byScore = scoreOf(right) - scoreOf(left);
    if (byScore !== 0) return byScore;
    const leftRank = priority.indexOf(left.provider);
    const rightRank = priority.indexOf(right.provider);
    return (
      (leftRank >= 0 ? leftRank : Number.MAX_SAFE_INTEGER) -
      (rightRank >= 0 ? rightRank : Number.MAX_SAFE_INTEGER)
    );
  });

  const chosen = ranked[0]!;
  const modelId = pickBestModel(chosen, requiredCapabilities, options.preferredModelId);
  const unmetCapabilities = computeUnmet(chosen, modelId, requiredCapabilities);
  const covers = unmetCapabilities.length === 0;

  let strategy: CapabilityResolution['strategy'];
  let rationale: string;
  if (installed.length === 1) {
    strategy = 'sole';
    rationale = covers
      ? `only ${chosen.provider} installed; it covers the required capabilities`
      : `only ${chosen.provider} installed; using it despite unmet [${unmetCapabilities.join(', ')}]`;
  } else if (demotionIgnored) {
    strategy = 'degraded';
    rationale = `all candidates were demoted (rate-limited); using best available ${chosen.provider}/${modelId}`;
  } else if (!covers) {
    strategy = 'degraded';
    rationale = `no installed provider covers [${requiredCapabilities.join(', ')}]; best match ${chosen.provider}/${modelId} leaves [${unmetCapabilities.join(', ')}] unmet`;
  } else if (options.preferredProvider && chosen.provider === options.preferredProvider) {
    strategy = 'preferred';
    rationale = `preferred ${chosen.provider} installed and covers the required capabilities`;
  } else {
    strategy = 'best-match';
    rationale = options.preferredProvider
      ? `preferred ${options.preferredProvider} not selected; ${chosen.provider}/${modelId} best covers the required capabilities`
      : `${chosen.provider}/${modelId} best covers the required capabilities`;
  }

  return {
    provider: chosen.provider,
    modelId,
    strategy,
    availableProviders,
    requiredCapabilities,
    unmetCapabilities,
    orchestration,
    rationale,
  };
}
