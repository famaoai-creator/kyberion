import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
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
  default_models: Record<string, string>;
  runtime_defaults: Partial<Record<ProviderConfigRuntimeRole, string>>;
  lifecycle: Record<string, ProviderLifecycleEntry>;
}

const PROVIDER_CONFIG_PATH = pathResolver.knowledge('product/governance/provider-config.json');
const PROVIDER_CONFIG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/provider-config.schema.json'
);

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const FALLBACK: ProviderConfigFile = {
  default_priority: ['gemini', 'claude', 'codex', 'copilot'],
  default_models: {
    gemini: 'gemini-3.5-flash',
    claude: 'claude-opus-4-8',
    codex: 'gpt-5.5',
    copilot: 'claude-sonnet-4-6',
  },
  runtime_defaults: {
    'anthropic-default': 'claude-opus-4-8',
    'anthropic-fast': 'claude-sonnet-5',
    'gemini-default': 'gemini-3.5-flash',
    'gemini-fast': 'gemini-3.1-flash-lite',
    'openai-vision': 'gpt-5.5',
    'codex-default': 'gpt-5.5',
    'copilot-default': 'claude-sonnet-4-6',
  },
  lifecycle: {
    gemini: {
      boot_command: 'gemini',
      boot_args: ['--acp', '-y'],
      default_model: 'gemini-3.5-flash',
    },
    copilot: {
      boot_command: 'gh',
      boot_args: ['copilot', '--', '--acp', '--allow-all'],
      default_model: 'claude-sonnet-4-6',
    },
  },
};

let cachedProviderConfig: ProviderConfigFile | null = null;
let validateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, PROVIDER_CONFIG_SCHEMA_PATH);
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
    const parsed = JSON.parse(safeReadFile(PROVIDER_CONFIG_PATH, { encoding: 'utf8' }) as string);
    const validated = validateProviderConfig(parsed, PROVIDER_CONFIG_PATH);
    cachedProviderConfig = {
      default_priority: validated.default_priority,
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
