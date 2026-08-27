import { pathResolver } from './path-resolver.js';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
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

const providerConfigCatalog: GovernedCatalog<ProviderConfigFile> = defineCatalog({
  id: 'provider-config',
  path: PROVIDER_CONFIG_PATH,
  schema: PROVIDER_CONFIG_SCHEMA_PATH,
  fallback: FALLBACK,
  onFallback: (error, fallback) =>
    recordConfigFallback({
      knowledgePath: 'product/governance/provider-config.json',
      error,
      defaults: fallback,
    }),
});

export function loadProviderConfig(): ProviderConfigFile {
  return providerConfigCatalog.load();
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
