import {
  loadReasoningBackendPolicy,
  type ReasoningBackendPolicy,
} from './reasoning-backend-policy.js';

export const OPENROUTER_FREE_ROUTER_MODEL = 'openrouter/free';

export type OpenRouterModelProfile = 'free-router' | 'free-pinned' | 'explicit';
export type OpenRouterCostPolicy = 'free-only' | 'paid-allowed';

export interface OpenRouterModelPolicy {
  profile: OpenRouterModelProfile;
  model: string;
  costPolicy: OpenRouterCostPolicy;
  requiredParameters: string[];
}

export interface OpenRouterModelRecord {
  id?: string;
  canonical_slug?: string;
  pricing?: Record<string, string | number | null | undefined>;
  supported_parameters?: string[];
}

function readPolicyConfig(policy: ReasoningBackendPolicy): {
  defaultProfile: OpenRouterModelProfile;
  defaultCostPolicy: OpenRouterCostPolicy;
  requiredParameters: string[];
} {
  const config = policy.openrouter;
  return {
    defaultProfile: config?.default_profile ?? 'free-router',
    defaultCostPolicy: config?.default_cost_policy ?? 'free-only',
    requiredParameters: config?.required_parameters ?? ['tools', 'tool_choice'],
  };
}

function normalizeProfile(
  value: string | undefined,
  fallback: OpenRouterModelProfile
): OpenRouterModelProfile {
  if (!value) return fallback;
  if (value === 'free-router' || value === 'free-pinned' || value === 'explicit') return value;
  throw new Error(
    `[openrouter] unsupported model profile "${value}"; use free-router, free-pinned, or explicit`
  );
}

function normalizeCostPolicy(
  value: string | undefined,
  fallback: OpenRouterCostPolicy
): OpenRouterCostPolicy {
  if (!value) return fallback;
  if (value === 'free-only' || value === 'paid-allowed') return value;
  throw new Error(`[openrouter] unsupported cost policy "${value}"; use free-only or paid-allowed`);
}

function parseRequiredParameters(value: string | undefined, fallback: string[]): string[] {
  if (!value) return [...fallback];
  const parameters = value
    .split(',')
    .map((parameter) => parameter.trim())
    .filter(Boolean);
  if (parameters.length === 0) {
    throw new Error('[openrouter] required parameters must contain at least one value');
  }
  return [...new Set(parameters)];
}

export function isOpenRouterFreeModelId(model: string): boolean {
  return model === OPENROUTER_FREE_ROUTER_MODEL || model.endsWith(':free');
}

export function isOpenRouterFreePricing(pricing: OpenRouterModelRecord['pricing']): boolean {
  if (!pricing || pricing.prompt === undefined || pricing.completion === undefined) return false;
  return Object.values(pricing).every(
    (value) => value === undefined || value === null || Number(value) === 0
  );
}

export function resolveOpenRouterModelPolicy(
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string,
  policy: ReasoningBackendPolicy = loadReasoningBackendPolicy()
): OpenRouterModelPolicy {
  const config = readPolicyConfig(policy);
  const configuredModel = modelOverride?.trim() || env.KYBERION_OPENROUTER_MODEL?.trim();
  const inferredProfile: OpenRouterModelProfile = configuredModel
    ? isOpenRouterFreeModelId(configuredModel)
      ? 'free-pinned'
      : 'explicit'
    : config.defaultProfile;
  const profile = normalizeProfile(env.KYBERION_OPENROUTER_PROFILE?.trim(), inferredProfile);
  const costPolicy = normalizeCostPolicy(
    env.KYBERION_OPENROUTER_COST_POLICY?.trim(),
    config.defaultCostPolicy
  );
  const model = configuredModel || OPENROUTER_FREE_ROUTER_MODEL;

  if (profile === 'free-router' && model !== OPENROUTER_FREE_ROUTER_MODEL) {
    throw new Error('[openrouter] free-router profile only supports model openrouter/free');
  }
  if (profile === 'free-pinned' && (!configuredModel || !isOpenRouterFreeModelId(model))) {
    throw new Error('[openrouter] free-pinned profile requires an explicit :free model id');
  }
  if (profile === 'explicit' && !configuredModel) {
    throw new Error('[openrouter] explicit profile requires KYBERION_OPENROUTER_MODEL');
  }
  if (costPolicy === 'free-only' && !isOpenRouterFreeModelId(model)) {
    throw new Error(
      `[openrouter] model "${model}" is not a recognized free model; set KYBERION_OPENROUTER_COST_POLICY=paid-allowed to opt into paid inference`
    );
  }

  return {
    profile,
    model,
    costPolicy,
    requiredParameters: parseRequiredParameters(
      env.KYBERION_OPENROUTER_REQUIRED_PARAMETERS?.trim(),
      config.requiredParameters
    ),
  };
}

export function validateOpenRouterModelRecord(
  record: OpenRouterModelRecord,
  modelPolicy: OpenRouterModelPolicy
): string[] {
  const failures: string[] = [];
  const modelId = record.id || record.canonical_slug;
  if (!modelId) failures.push('model record has no id');
  // The router performs capability-aware filtering for each request. Its
  // catalog entry is therefore not a pinned model contract to validate.
  if (modelPolicy.profile === 'free-router') return failures;
  if (modelPolicy.costPolicy === 'free-only' && !isOpenRouterFreePricing(record.pricing)) {
    failures.push(`model "${modelPolicy.model}" is not currently zero-priced`);
  }
  const supported = new Set(record.supported_parameters ?? []);
  for (const parameter of modelPolicy.requiredParameters) {
    if (!supported.has(parameter))
      failures.push(`model does not support required parameter "${parameter}"`);
  }
  return failures;
}
