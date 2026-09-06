import { pathResolver } from './path-resolver.js';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';

export type ProviderConfigRuntimeRole =
  | 'anthropic-default'
  | 'anthropic-fast'
  | 'gemini-default'
  | 'gemini-fast'
  | 'openai-vision'
  | 'codex-default'
  | 'copilot-default'
  | 'cursor-default'
  | 'opencode-default';

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

const providerConfigCatalog: GovernedCatalog<ProviderConfigFile> = defineCatalog({
  id: 'provider-config',
  path: PROVIDER_CONFIG_PATH,
  schema: PROVIDER_CONFIG_SCHEMA_PATH,
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
  'cursor-default': 'cursor',
  'opencode-default': 'opencode',
};

export function resolveRuntimeDefaultModelId(role: ProviderConfigRuntimeRole): string {
  const config = loadProviderConfig();
  return (
    config.runtime_defaults[role] ||
    config.default_models[RUNTIME_ROLE_PROVIDER_FALLBACK[role]] ||
    role
  );
}
