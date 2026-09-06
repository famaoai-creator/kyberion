import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { currentScope, type ScopeContext } from './scope-context.js';

export type ReasoningBackendMode =
  | 'claude-cli'
  | 'codex-cli'
  | 'claude-agent'
  | 'anthropic'
  | 'gemini-cli'
  | 'gemini-api'
  | 'agy-cli'
  | 'grok-cli'
  | 'grok-api'
  | 'copilot'
  | 'cursor-cli'
  | 'opencode-cli'
  | 'local'
  | 'ollama'
  | 'vllm'
  | 'lmstudio'
  | 'llamacpp'
  | 'mlx'
  | 'localai'
  | 'nemotron'
  | 'nemotron-api'
  | 'openrouter'
  | 'stub';

export interface ReasoningBackendSelectionRule {
  env_any?: string[];
  env_equals?: Record<string, string>;
  provider?: string;
  mode: ReasoningBackendMode;
}

export interface ReasoningBackendEnvPriorityRule {
  env: string;
  mode: ReasoningBackendMode;
}

export interface ReasoningBackendOpenRouterPolicy {
  default_profile: 'free-router' | 'free-pinned' | 'explicit';
  default_cost_policy: 'free-only' | 'paid-allowed';
  required_parameters: string[];
}

export interface ReasoningBackendPolicy {
  version: string;
  route_policy_ref?: string;
  mode_aliases: Record<string, ReasoningBackendMode>;
  allowed_modes: ReasoningBackendMode[];
  auto_select_env_priority: ReasoningBackendEnvPriorityRule[];
  cli_preference_rules: ReasoningBackendSelectionRule[];
  provider_fallback_order: Array<{
    provider: string;
    mode: ReasoningBackendMode;
  }>;
  default_mode: ReasoningBackendMode;
  openrouter?: ReasoningBackendOpenRouterPolicy;
  tenant_overrides?: Record<
    string,
    Partial<Pick<ReasoningBackendPolicy, 'allowed_modes' | 'default_mode'>>
  >;
  organization_overrides?: Record<
    string,
    Partial<Pick<ReasoningBackendPolicy, 'allowed_modes' | 'default_mode'>>
  >;
  project_overrides?: Record<
    string,
    Partial<Pick<ReasoningBackendPolicy, 'allowed_modes' | 'default_mode'>>
  >;
}

export interface ReasoningBackendProviderSnapshot {
  provider: string;
  installed: boolean;
  healthy: boolean;
}

export interface ReasoningBackendSelection {
  mode: ReasoningBackendMode;
  /** Safe-to-display provenance; never contains environment values or secrets. */
  reason: string;
}

const POLICY_PATH = pathResolver.knowledge('product/governance/reasoning-backend-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/reasoning-backend-policy.schema.json');

const policyCatalog = defineCatalog<ReasoningBackendPolicy>({
  id: 'reasoning-backend-policy',
  path: POLICY_PATH,
  schema: SCHEMA_PATH,
});

export function loadReasoningBackendPolicy(): ReasoningBackendPolicy {
  return policyCatalog.load();
}

function envText(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return getRegisteredEnvText(name, { env });
}

export function normalizeReasoningBackendMode(
  mode: ReasoningBackendMode,
  policy: ReasoningBackendPolicy = loadReasoningBackendPolicy()
): ReasoningBackendMode {
  const normalized = policy.mode_aliases[mode] || mode;
  return normalized;
}

function matchesSelectionRule(
  env: NodeJS.ProcessEnv,
  rule: ReasoningBackendSelectionRule
): boolean {
  if (
    Array.isArray(rule.env_any) &&
    rule.env_any.length > 0 &&
    !rule.env_any.some((name) => Boolean(envText(env, name)))
  ) {
    return false;
  }
  if (rule.env_equals) {
    for (const [name, value] of Object.entries(rule.env_equals)) {
      if (envText(env, name) !== value) return false;
    }
  }
  return true;
}

function isHealthyProvider(
  providers: ReasoningBackendProviderSnapshot[],
  provider: string
): boolean {
  return providers.some((entry) => entry.provider === provider && entry.installed && entry.healthy);
}

export function resolveReasoningBackendModeFromContext(input: {
  requestedMode?: ReasoningBackendMode | null;
  env?: NodeJS.ProcessEnv;
  providers?: ReasoningBackendProviderSnapshot[];
  policy?: ReasoningBackendPolicy;
  scope?: ScopeContext;
}): ReasoningBackendMode {
  return resolveReasoningBackendSelectionFromContext(input).mode;
}

/**
 * Resolve a backend and retain the deterministic decision path used to select
 * it. This is intentionally separate from the mode-only API so callers such
 * as the seam catalog can expose binding provenance without reimplementing
 * policy selection or printing credential values.
 */
export function resolveReasoningBackendSelectionFromContext(input: {
  requestedMode?: ReasoningBackendMode | null;
  env?: NodeJS.ProcessEnv;
  providers?: ReasoningBackendProviderSnapshot[];
  policy?: ReasoningBackendPolicy;
  scope?: ScopeContext;
}): ReasoningBackendSelection {
  const basePolicy = input.policy ?? loadReasoningBackendPolicy();
  const policy = resolveScopedBackendPolicy(basePolicy, input.scope ?? currentScope());
  const env = input.env ?? process.env;
  const providers = input.providers ?? [];
  const scope = input.scope ?? currentScope();
  const scopeLayers = [
    scope?.tenant_slug && basePolicy.tenant_overrides?.[scope.tenant_slug] ? 'tenant' : undefined,
    scope?.organization_id && basePolicy.organization_overrides?.[scope.organization_id]
      ? 'organization'
      : undefined,
    scope?.project_id && basePolicy.project_overrides?.[scope.project_id] ? 'project' : undefined,
  ].filter((layer): layer is string => Boolean(layer));
  const scopeSuffix = scopeLayers.length ? `; scope overlays=${scopeLayers.join(',')}` : '';

  if (input.requestedMode) {
    const requested = normalizeReasoningBackendMode(input.requestedMode, policy);
    if (!policy.allowed_modes.includes(requested)) {
      throw new Error(`[REASONING_MODE_DENIED] mode '${requested}' is not allowed in this scope`);
    }
    return { mode: requested, reason: `requested mode=${requested}${scopeSuffix}` };
  }

  const envMode = envText(env, 'KYBERION_REASONING_BACKEND') as ReasoningBackendMode | undefined;
  if (envMode) {
    const normalizedEnvMode = normalizeReasoningBackendMode(envMode, policy);
    if (policy.allowed_modes.includes(normalizedEnvMode)) {
      return {
        mode: normalizedEnvMode,
        reason: `env KYBERION_REASONING_BACKEND${scopeSuffix}`,
      };
    }
  }

  for (const [index, rule] of policy.auto_select_env_priority.entries()) {
    if (!envText(env, rule.env)) continue;
    const normalizedRuleMode = normalizeReasoningBackendMode(rule.mode, policy);
    if (policy.allowed_modes.includes(normalizedRuleMode)) {
      return {
        mode: normalizedRuleMode,
        reason: `policy auto_select_env_priority[${index}] env=${rule.env}${scopeSuffix}`,
      };
    }
  }

  for (const [index, rule] of policy.cli_preference_rules.entries()) {
    if (!matchesSelectionRule(env, rule)) continue;
    const normalizedRuleMode = normalizeReasoningBackendMode(rule.mode, policy);
    if (
      rule.provider &&
      policy.allowed_modes.includes(normalizedRuleMode) &&
      isHealthyProvider(providers, rule.provider)
    ) {
      return {
        mode: normalizedRuleMode,
        reason: `policy cli_preference_rules[${index}] provider=${rule.provider} probe=healthy${scopeSuffix}`,
      };
    }
  }

  for (const [index, rule] of policy.provider_fallback_order.entries()) {
    const normalizedRuleMode = normalizeReasoningBackendMode(rule.mode, policy);
    if (
      rule.provider &&
      policy.allowed_modes.includes(normalizedRuleMode) &&
      isHealthyProvider(providers, rule.provider)
    ) {
      return {
        mode: normalizedRuleMode,
        reason: `policy provider_fallback_order[${index}] provider=${rule.provider} probe=healthy${scopeSuffix}`,
      };
    }
  }

  const defaultMode = normalizeReasoningBackendMode(policy.default_mode, policy);
  if (!policy.allowed_modes.includes(defaultMode)) {
    throw new Error(
      `[REASONING_MODE_DENIED] default mode '${defaultMode}' is not allowed in this scope`
    );
  }
  return { mode: defaultMode, reason: `policy default_mode=${defaultMode}${scopeSuffix}` };
}

/** Resolve global policy plus tenant -> organization -> project overlays. */
export function resolveScopedBackendPolicy(
  policy: ReasoningBackendPolicy,
  scope?: ScopeContext
): ReasoningBackendPolicy {
  const layers = [
    scope?.tenant_slug ? policy.tenant_overrides?.[scope.tenant_slug] : undefined,
    scope?.organization_id ? policy.organization_overrides?.[scope.organization_id] : undefined,
    scope?.project_id ? policy.project_overrides?.[scope.project_id] : undefined,
  ].filter(Boolean);
  return layers.reduce<ReasoningBackendPolicy>(
    (resolved, layer) => ({ ...resolved, ...layer }),
    policy
  );
}
