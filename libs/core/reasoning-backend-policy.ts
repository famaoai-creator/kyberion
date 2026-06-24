import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export type ReasoningBackendMode =
  | 'claude-cli'
  | 'codex-cli'
  | 'claude-agent'
  | 'anthropic'
  | 'gemini-cli'
  | 'gemini-api'
  | 'agy-cli'
  | 'local'
  | 'nemotron'
  | 'nemotron-api'
  | 'openrouter'
  | 'stub';

export interface ReasoningBackendSelectionRule {
  env_any?: string[];
  env_equals?: Record<string, string>;
  provider?: string;
  mode: Exclude<ReasoningBackendMode, 'gemini-api'>;
}

export interface ReasoningBackendEnvPriorityRule {
  env: string;
  mode: Exclude<ReasoningBackendMode, 'gemini-api'>;
}

export interface ReasoningBackendPolicy {
  version: string;
  mode_aliases: Record<string, Exclude<ReasoningBackendMode, 'gemini-api'>>;
  allowed_modes: Array<Exclude<ReasoningBackendMode, 'gemini-api'>>;
  auto_select_env_priority: ReasoningBackendEnvPriorityRule[];
  cli_preference_rules: ReasoningBackendSelectionRule[];
  provider_fallback_order: Array<{
    provider: string;
    mode: Exclude<ReasoningBackendMode, 'gemini-api'>;
  }>;
  default_mode: Exclude<ReasoningBackendMode, 'gemini-api'>;
}

export interface ReasoningBackendProviderSnapshot {
  provider: string;
  installed: boolean;
  healthy: boolean;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const POLICY_PATH = pathResolver.knowledge('product/governance/reasoning-backend-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/reasoning-backend-policy.schema.json');

const FALLBACK_POLICY: ReasoningBackendPolicy = {
  version: '1.0.0',
  mode_aliases: {
    'gemini-api': 'gemini-cli',
    nemotron: 'nemotron-api',
  },
  allowed_modes: [
    'claude-cli',
    'codex-cli',
    'claude-agent',
    'anthropic',
    'gemini-cli',
    'agy-cli',
    'local',
    'nemotron-api',
    'openrouter',
    'stub',
  ],
  auto_select_env_priority: [
    { env: 'ANTHROPIC_API_KEY', mode: 'anthropic' },
    { env: 'GEMINI_API_KEY', mode: 'gemini-cli' },
    { env: 'KYBERION_NEMOTRON_URL', mode: 'nemotron-api' },
    { env: 'KYBERION_LOCAL_LLM_URL', mode: 'local' },
    { env: 'OPENROUTER_API_KEY', mode: 'openrouter' },
  ],
  cli_preference_rules: [
    { env_any: ['CODEX_CLI', 'CODEX_VERSION'], env_equals: { TERM_PROGRAM: 'codex' }, provider: 'codex', mode: 'codex-cli' },
    { env_any: ['GEMINI_CLI'], provider: 'gemini', mode: 'gemini-cli' },
    { env_any: ['AGY_CLI', 'ANTIGRAVITY_CLI'], provider: 'agy', mode: 'agy-cli' },
  ],
  provider_fallback_order: [
    { provider: 'codex', mode: 'codex-cli' },
    { provider: 'gemini', mode: 'gemini-cli' },
    { provider: 'agy', mode: 'agy-cli' },
  ],
  default_mode: 'codex-cli',
};

let validateFn: ValidateFunction | null = null;
let cachedPolicy: ReasoningBackendPolicy | null = null;
let cachedPolicyPath: string | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
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
    throw new Error(`Invalid reasoning backend policy at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as ReasoningBackendPolicy;
}

function loadPolicyFile(): ReasoningBackendPolicy | null {
  if (!safeExistsSync(POLICY_PATH)) return null;
  return validatePolicy(JSON.parse(safeReadFile(POLICY_PATH, { encoding: 'utf8' }) as string), POLICY_PATH);
}

export function loadReasoningBackendPolicy(): ReasoningBackendPolicy {
  if (cachedPolicy && cachedPolicyPath === POLICY_PATH) return cachedPolicy;
  cachedPolicy = loadPolicyFile() ?? FALLBACK_POLICY;
  cachedPolicyPath = POLICY_PATH;
  return cachedPolicy;
}

export function normalizeReasoningBackendMode(
  mode: ReasoningBackendMode,
  policy: ReasoningBackendPolicy = loadReasoningBackendPolicy(),
): Exclude<ReasoningBackendMode, 'gemini-api'> {
  const normalized = policy.mode_aliases[mode] || mode;
  return normalized as Exclude<ReasoningBackendMode, 'gemini-api'>;
}

function matchesSelectionRule(env: NodeJS.ProcessEnv, rule: ReasoningBackendSelectionRule): boolean {
  if (Array.isArray(rule.env_any) && rule.env_any.length > 0 && !rule.env_any.some((name) => Boolean(env[name]))) {
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
  provider: string,
): boolean {
  return providers.some((entry) => entry.provider === provider && entry.installed && entry.healthy);
}

export function resolveReasoningBackendModeFromContext(input: {
  requestedMode?: ReasoningBackendMode | null;
  env?: NodeJS.ProcessEnv;
  providers?: ReasoningBackendProviderSnapshot[];
  policy?: ReasoningBackendPolicy;
}): Exclude<ReasoningBackendMode, 'gemini-api'> {
  const policy = input.policy ?? loadReasoningBackendPolicy();
  const env = input.env ?? process.env;
  const providers = input.providers ?? [];

  if (input.requestedMode) {
    return normalizeReasoningBackendMode(input.requestedMode, policy);
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
    if (rule.provider && isHealthyProvider(providers, rule.provider)) {
      return rule.mode;
    }
  }

  for (const rule of policy.provider_fallback_order) {
    if (rule.provider && isHealthyProvider(providers, rule.provider)) {
      return rule.mode;
    }
  }

  return policy.default_mode;
}

export function resetReasoningBackendPolicyCache(): void {
  cachedPolicy = null;
  cachedPolicyPath = null;
}
