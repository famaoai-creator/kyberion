import type { ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { compileSchema } from './foundation/ajv.js';
import { loadJson, safeExistsSync, safeReadFile } from './secure-io.js';
import { recordConfigFallback } from './config-fallback-registry.js';

export type ProviderConfigRuntimeRole =
  | 'anthropic-default'
  | 'anthropic-fast'
  | 'gemini-default'
  | 'gemini-fast'
  | 'openai-vision'
  | 'codex-default'
  | 'copilot-default';

export interface ProviderLifecycleEntry {
  boot_command: string;
  boot_args: string[];
  default_model: string;
}

export interface ProviderConfigFile {
  default_priority: string[];
  obsolete_agent_runtime_providers: string[];
  default_models: Record<string, string>;
  runtime_defaults: Partial<Record<ProviderConfigRuntimeRole, string>>;
  lifecycle: Record<string, ProviderLifecycleEntry>;
}

const PROVIDER_CONFIG_PATH = pathResolver.knowledge('product/governance/provider-config.json');
const PROVIDER_CONFIG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/provider-config.schema.json'
);

const FALLBACK: ProviderConfigFile = {
  default_priority: ['agy', 'claude', 'codex', 'grok', 'copilot'],
  obsolete_agent_runtime_providers: ['gemini'],
  default_models: {
    gemini: 'gemini-3.6-flash',
    claude: 'claude-opus-5',
    agy: 'Gemini 3.7 Flash (Medium)',
    codex: 'gpt-5.6-sol',
    grok: 'grok-4.6',
    copilot: 'auto',
  },
  runtime_defaults: {
    'anthropic-default': 'claude-opus-5',
    'anthropic-fast': 'claude-haiku-4-5-20251001',
    'gemini-default': 'gemini-3.6-flash',
    'gemini-fast': 'gemini-3.1-flash-lite',
    'openai-vision': 'gpt-5.5',
    'codex-default': 'gpt-5.6-sol',
    'copilot-default': 'auto',
  },
  lifecycle: {
    gemini: {
      boot_command: 'gemini',
      boot_args: ['--acp', '-y'],
      default_model: 'gemini-3.6-flash',
    },
    copilot: {
      boot_command: 'gh',
      boot_args: ['copilot', '--', '--acp', '--allow-all'],
      default_model: 'auto',
    },
  },
};

let cachedProviderConfig: ProviderConfigFile | null = null;
let validateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchema(PROVIDER_CONFIG_SCHEMA_PATH);
  return validateFn;
}

function validateProviderConfig(value: unknown, label = PROVIDER_CONFIG_PATH): ProviderConfigFile {
  const validate = ensureValidator();
  if (!validate(value)) {
    const errors = (validate.errors || []).map(
      (error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`
    );
    throw new Error(`Invalid provider config at ${label}: ${errors.join('; ')}`);
  }
  return value as ProviderConfigFile;
}

export function loadProviderConfig(): ProviderConfigFile {
  if (cachedProviderConfig) return cachedProviderConfig;
  try {
    if (!safeExistsSync(PROVIDER_CONFIG_PATH)) {
      cachedProviderConfig = FALLBACK;
      return cachedProviderConfig;
    }
    const parsed = loadJson<unknown>(PROVIDER_CONFIG_PATH);
    const validated = validateProviderConfig(parsed, PROVIDER_CONFIG_PATH);
    cachedProviderConfig = {
      default_priority: validated.default_priority,
      obsolete_agent_runtime_providers: validated.obsolete_agent_runtime_providers || [],
      default_models: validated.default_models,
      runtime_defaults: validated.runtime_defaults,
      lifecycle: validated.lifecycle,
    };
  } catch (error) {
    recordConfigFallback({
      knowledgePath: 'product/governance/provider-config.json',
      error,
      defaults: FALLBACK,
    });
    cachedProviderConfig = FALLBACK;
  }
  return cachedProviderConfig;
}

export function isObsoleteAgentRuntimeProvider(provider: string | undefined): boolean {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) return false;
  return loadProviderConfig().obsolete_agent_runtime_providers.some(
    (entry) => entry.trim().toLowerCase() === normalized
  );
}

const RUNTIME_ROLE_PROVIDER_FALLBACK: Record<ProviderConfigRuntimeRole, string> = {
  'anthropic-default': 'claude',
  'anthropic-fast': 'claude',
  'gemini-default': 'gemini',
  'gemini-fast': 'gemini',
  'openai-vision': 'codex',
  'codex-default': 'codex',
  'copilot-default': 'copilot',
};

export function resolveRuntimeDefaultModelId(role: ProviderConfigRuntimeRole): string {
  const config = loadProviderConfig();
  return (
    config.runtime_defaults[role] ||
    config.default_models[RUNTIME_ROLE_PROVIDER_FALLBACK[role]] ||
    FALLBACK.runtime_defaults[role] ||
    role
  );
}
