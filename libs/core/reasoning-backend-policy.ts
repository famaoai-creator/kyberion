import type { ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { createAjv } from './foundation/ajv.js';
import { loadJson, safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchema } from './foundation/ajv.js';
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

const ajv = createAjv();

const POLICY_PATH = pathResolver.knowledge('product/governance/reasoning-backend-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/reasoning-backend-policy.schema.json');

const FALLBACK_POLICY: ReasoningBackendPolicy = {
  version: '1.0.0',
  mode_aliases: {
    nemotron: 'nemotron-api',
    grok: 'grok-cli',
    'grok-build': 'grok-cli',
    xai: 'grok-api',
  },
  allowed_modes: [
    'claude-cli',
    'codex-cli',
    'claude-agent',
    'anthropic',
    'gemini-cli',
    'gemini-api',
    'agy-cli',
    'grok-cli',
    'grok-api',
    'copilot',
    'local',
    'ollama',
    'vllm',
    'lmstudio',
    'llamacpp',
    'mlx',
    'localai',
    'nemotron-api',
    'openrouter',
    'stub',
  ],
  auto_select_env_priority: [
    { env: 'ANTHROPIC_API_KEY', mode: 'anthropic' },
    { env: 'GEMINI_API_KEY', mode: 'gemini-api' },
    { env: 'GOOGLE_API_KEY', mode: 'gemini-api' },
    { env: 'XAI_API_KEY', mode: 'grok-api' },
    { env: 'KYBERION_GROK_API_KEY', mode: 'grok-api' },
    { env: 'KYBERION_NEMOTRON_URL', mode: 'nemotron-api' },
    { env: 'KYBERION_OLLAMA_URL', mode: 'ollama' },
    { env: 'KYBERION_VLLM_URL', mode: 'vllm' },
    { env: 'KYBERION_LMSTUDIO_URL', mode: 'lmstudio' },
    { env: 'KYBERION_LM_STUDIO_URL', mode: 'lmstudio' },
    { env: 'KYBERION_LLAMACPP_URL', mode: 'llamacpp' },
    { env: 'KYBERION_MLX_URL', mode: 'mlx' },
    { env: 'KYBERION_LOCALAI_URL', mode: 'localai' },
    { env: 'KYBERION_LOCAL_LLM_URL', mode: 'local' },
    { env: 'KYBERION_OPENROUTER_KEY', mode: 'openrouter' },
    { env: 'OPENROUTER_API_KEY', mode: 'openrouter' },
    // Running inside a Claude Code harness: prefer the in-session claude-agent
    // sub-agent (inherits the host session's auth, no new CLI spawn) over the
    // CLI-spawn fallback. Explicit API-key signals above still win.
    { env: 'CLAUDECODE', mode: 'claude-agent' },
  ],
  cli_preference_rules: [
    {
      env_any: ['CODEX_CLI', 'CODEX_VERSION'],
      env_equals: { TERM_PROGRAM: 'codex' },
      provider: 'codex',
      mode: 'codex-cli',
    },
    { env_any: ['AGY_CLI', 'ANTIGRAVITY_CLI'], provider: 'agy', mode: 'agy-cli' },
    { env_any: ['GROK_CLI', 'GROK_VERSION'], provider: 'grok', mode: 'grok-cli' },
  ],
  provider_fallback_order: [
    { provider: 'codex', mode: 'codex-cli' },
    { provider: 'agy', mode: 'agy-cli' },
    { provider: 'grok', mode: 'grok-cli' },
    { provider: 'copilot', mode: 'copilot' },
  ],
  default_mode: 'codex-cli',
  openrouter: {
    default_profile: 'free-router',
    default_cost_policy: 'free-only',
    required_parameters: ['tools', 'tool_choice'],
  },
};

let validateFn: ValidateFunction | null = null;
let cachedPolicy: ReasoningBackendPolicy | null = null;
let cachedPolicyPath: string | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchema(SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function validatePolicy(value: unknown, label: string): ReasoningBackendPolicy {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(
      `Invalid reasoning backend policy at ${label}: ${errorsFrom(validate).join('; ')}`
    );
  }
  return value as ReasoningBackendPolicy;
}

function loadPolicyFile(): ReasoningBackendPolicy | null {
  if (!safeExistsSync(POLICY_PATH)) return null;
  return validatePolicy(loadJson(POLICY_PATH), POLICY_PATH);
}

export function loadReasoningBackendPolicy(): ReasoningBackendPolicy {
  if (cachedPolicy && cachedPolicyPath === POLICY_PATH) return cachedPolicy;
  cachedPolicy = loadPolicyFile() ?? FALLBACK_POLICY;
  cachedPolicyPath = POLICY_PATH;
  return cachedPolicy;
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
    !rule.env_any.some((name) => Boolean(env[name]))
  ) {
    return false;
  }
  if (rule.env_equals) {
    for (const [name, value] of Object.entries(rule.env_equals)) {
      if (env[name] !== value) return false;
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
  const policy = resolveScopedBackendPolicy(
    input.policy ?? loadReasoningBackendPolicy(),
    input.scope ?? currentScope()
  );
  const env = input.env ?? process.env;
  const providers = input.providers ?? [];

  if (input.requestedMode) {
    const requested = normalizeReasoningBackendMode(input.requestedMode, policy);
    if (!policy.allowed_modes.includes(requested)) {
      throw new Error(`[REASONING_MODE_DENIED] mode '${requested}' is not allowed in this scope`);
    }
    return requested;
  }

  const envMode = env.KYBERION_REASONING_BACKEND as ReasoningBackendMode | undefined;
  if (envMode) {
    const normalizedEnvMode = normalizeReasoningBackendMode(envMode, policy);
    if (policy.allowed_modes.includes(normalizedEnvMode)) {
      return normalizedEnvMode;
    }
  }

  for (const rule of policy.auto_select_env_priority) {
    if (!env[rule.env]) continue;
    const normalizedRuleMode = normalizeReasoningBackendMode(rule.mode, policy);
    if (policy.allowed_modes.includes(normalizedRuleMode)) {
      return normalizedRuleMode;
    }
  }

  for (const rule of policy.cli_preference_rules) {
    if (!matchesSelectionRule(env, rule)) continue;
    const normalizedRuleMode = normalizeReasoningBackendMode(rule.mode, policy);
    if (
      rule.provider &&
      policy.allowed_modes.includes(normalizedRuleMode) &&
      isHealthyProvider(providers, rule.provider)
    ) {
      return normalizedRuleMode;
    }
  }

  for (const rule of policy.provider_fallback_order) {
    const normalizedRuleMode = normalizeReasoningBackendMode(rule.mode, policy);
    if (
      rule.provider &&
      policy.allowed_modes.includes(normalizedRuleMode) &&
      isHealthyProvider(providers, rule.provider)
    ) {
      return normalizedRuleMode;
    }
  }

  const defaultMode = normalizeReasoningBackendMode(policy.default_mode, policy);
  if (!policy.allowed_modes.includes(defaultMode)) {
    throw new Error(
      `[REASONING_MODE_DENIED] default mode '${defaultMode}' is not allowed in this scope`
    );
  }
  return defaultMode;
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

export function resetReasoningBackendPolicyCache(): void {
  cachedPolicy = null;
  cachedPolicyPath = null;
}
