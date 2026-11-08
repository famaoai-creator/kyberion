import { getRegisteredEnvText, setRegisteredEnv } from '../foundation/env.js';
import { persistEnvValue } from '../foundation/env-dotenv.js';
import { nowIso } from '../foundation/time.js';

import { discoverProviders } from '../provider/provider-discovery.js';
import {
  discoverReasoningEndpoints,
  type ReasoningEndpointInfo,
  type ReasoningEndpointPolicy,
} from './reasoning-endpoint-discovery.js';
import {
  getReasoningProviderDescriptor,
  isLocalReasoningEndpoint,
  resolveReasoningProviderSecretEnvValue,
} from './reasoning-provider-registry.js';
import type { ReasoningBackendMode } from './reasoning-backend-policy.js';
import { loadModelRegistry } from './reasoning-model-routing.js';
import { loadReasoningRoutePolicy, type ReasoningRoutePolicy } from './reasoning-route-resolver.js';
import {
  getLlmSelectionPreferencesPath,
  loadLlmSelectionPreferences as loadPersistedLlmSelectionPreferences,
  validateLlmSelectionPreferencesAtPath,
  type LlmSelectionPreferences,
} from './llm-selection-state.js';
import { safeWriteFile } from '../secure-io.js';

export type LlmSelectionStatus = 'ready' | 'needs_setup' | 'unsupported';

export type { LlmSelectionPreferences } from './llm-selection-state.js';

export type LlmSelectionSetupKind = 'always' | 'cli' | 'api_key' | 'endpoint' | 'unsupported';

/**
 * How a `needs_setup` candidate becomes ready — derived from the governed
 * provider descriptor and route policy so the UI can offer the right
 * registration flow instead of a free-form hint. Never carries values.
 */
export interface LlmSelectionSetup {
  kind: LlmSelectionSetupKind;
  /** Availability env names from the route policy (hints only, no values). */
  env_names: string[];
  /** Governed secret-introduction target for `api_key` / optional keys. */
  secret_service_id?: string;
  secret_key?: string;
  /** Whether a credential is resolvable right now (env or secret store). */
  credential_ready?: boolean;
  /** First URL-style env name for `endpoint` providers. */
  endpoint_env_name?: string;
  endpoint_configured?: boolean;
  endpoint_policy?: ReasoningEndpointPolicy;
  hint?: string;
}

export interface LlmSelectionCandidate {
  provider: string;
  display_name: string;
  adapter: string;
  status: LlmSelectionStatus;
  selectable: boolean;
  model_ids: string[];
  capabilities: string[];
  reason: string;
  setup: LlmSelectionSetup;
}

export interface LlmSelectionSnapshot {
  preferences: LlmSelectionPreferences;
  storage_path: string;
  candidates: LlmSelectionCandidate[];
}

const DEFAULT_SELECTION: LlmSelectionPreferences = {
  version: '1.0.0',
  provider: 'codex-cli',
};

function hasProfileForMode(policy: ReasoningRoutePolicy, mode: string): boolean {
  return Object.values(policy.profiles).some((profile) => profile.mode === mode);
}

function isAvailable(
  runtime: string,
  selection: NonNullable<ReasoningRoutePolicy['runtime_adapters'][string]['selection']>,
  discovered: ReturnType<typeof discoverProviders>,
  env: NodeJS.ProcessEnv,
  endpointDiscovery: ReasoningEndpointInfo[]
): boolean {
  if (selection.availability.kind === 'always') return true;
  if (selection.availability.kind === 'provider_discovery') {
    return Boolean(
      selection.discovery_provider &&
      discovered.find(
        (provider) =>
          provider.provider === selection.discovery_provider &&
          provider.installed &&
          provider.healthy
      )
    );
  }
  return Boolean(
    endpointDiscovery.find((endpoint) => endpoint.runtime === runtime)?.configured ??
    (selection.availability.names || []).some((name) =>
      env === process.env
        ? Boolean(resolveReasoningProviderSecretEnvValue(name, env)?.trim())
        : Boolean(env[name]?.trim())
    )
  );
}

const URL_ENV_PATTERN = /(_URL|_HOST|_ENDPOINT)$/u;

function setupFor(
  runtime: string,
  selection: NonNullable<ReasoningRoutePolicy['runtime_adapters'][string]['selection']> | undefined,
  profileAvailable: boolean,
  env: NodeJS.ProcessEnv,
  endpointDiscovery: ReasoningEndpointInfo[]
): LlmSelectionSetup {
  const names =
    selection?.availability.kind === 'env_any' ? [...(selection.availability.names ?? [])] : [];
  if (!selection || !profileAvailable) return { kind: 'unsupported', env_names: names };
  if (selection.availability.kind === 'always') return { kind: 'always', env_names: names };
  if (selection.availability.kind === 'provider_discovery')
    return { kind: 'cli', env_names: names };

  const descriptor = getReasoningProviderDescriptor(runtime as ReasoningBackendMode);
  const endpointInfo = endpointDiscovery.find((endpoint) => endpoint.runtime === runtime);
  const endpointEnvName = names.find((name) => URL_ENV_PATTERN.test(name));
  const secretRef = descriptor?.secret_refs?.[0];
  const credentialReady = names.some((name) =>
    env === process.env
      ? Boolean(resolveReasoningProviderSecretEnvValue(name, env)?.trim())
      : Boolean(env[name]?.trim())
  );
  const looksEndpoint =
    Boolean(endpointEnvName) &&
    (descriptor?.transport === 'local-server' || names.every((name) => URL_ENV_PATTERN.test(name)));
  return {
    kind: looksEndpoint ? 'endpoint' : secretRef ? 'api_key' : 'endpoint',
    env_names: names,
    ...(secretRef
      ? { secret_service_id: secretRef.service_id, secret_key: secretRef.secret_key }
      : {}),
    credential_ready: credentialReady,
    ...(endpointEnvName ? { endpoint_env_name: endpointEnvName } : {}),
    endpoint_configured: endpointInfo?.configured ?? credentialReady,
    endpoint_policy: endpointInfo?.endpoint_policy,
    hint: descriptor?.setup_hint,
  };
}

function modelIdsFor(
  adapter: NonNullable<ReasoningRoutePolicy['runtime_adapters'][string]>,
  discovered: ReturnType<typeof discoverProviders>
): string[] {
  if (adapter.adapter === 'stub') return [];
  const registry = loadModelRegistry();
  const registered = registry.models
    .filter(
      (model) =>
        model.status !== 'blocked' &&
        model.status !== 'deprecated' &&
        (!adapter.selection?.model_provider || model.provider === adapter.selection.model_provider)
    )
    .map((model) => model.model_id);
  const discoveredModels = adapter.selection?.discovery_provider
    ? discovered.find((provider) => provider.provider === adapter.selection?.discovery_provider)
        ?.models || []
    : [];
  const models =
    adapter.model_policy === 'local-unregistered'
      ? [...registered, ...discoveredModels]
      : registered;
  return Array.from(new Set(models.filter((model) => model.trim())));
}

function defaultSelection(policy: ReasoningRoutePolicy): LlmSelectionPreferences {
  const requested = getRegisteredEnvText('KYBERION_REASONING_BACKEND')?.trim();
  const provider =
    requested && policy.runtime_adapters[requested] ? requested : DEFAULT_SELECTION.provider;
  const adapter = policy.runtime_adapters[provider];
  const registry = loadModelRegistry();
  const model_id = adapter?.selection?.model_provider
    ? registry.models.find(
        (model) =>
          model.provider === adapter.selection?.model_provider && model.status === 'approved'
      )?.model_id
    : undefined;
  return { version: '1.0.0', provider, model_id };
}

function getPreferences(policy: ReasoningRoutePolicy): LlmSelectionPreferences {
  return loadPersistedLlmSelectionPreferences() || defaultSelection(policy);
}

export function getLlmSelectionSnapshot(
  env: NodeJS.ProcessEnv = process.env
): LlmSelectionSnapshot {
  const policy = loadReasoningRoutePolicy();
  const discovered = discoverProviders();
  const endpointDiscovery = discoverReasoningEndpoints(env, policy);
  const preferences = getPreferences(policy);
  const candidates = Object.entries(policy.runtime_adapters).map(([provider, adapter]) => {
    const selection = adapter.selection;
    const profileAvailable = hasProfileForMode(policy, provider);
    const available = Boolean(
      selection &&
      profileAvailable &&
      isAvailable(provider, selection, discovered, env, endpointDiscovery)
    );
    const status: LlmSelectionStatus =
      !selection || !profileAvailable ? 'unsupported' : available ? 'ready' : 'needs_setup';
    const reason = !selection
      ? 'This runtime is not registered for user selection.'
      : !profileAvailable
        ? 'No governed reasoning profile is configured for this runtime.'
        : available
          ? `Ready through the ${selection.display_name} adapter.`
          : 'Configure the required credentials, endpoint, or local runtime before selecting it.';
    return {
      provider,
      display_name: selection?.display_name || provider,
      adapter: adapter.adapter,
      status,
      selectable: available,
      model_ids: modelIdsFor(adapter, discovered),
      capabilities: adapter.capabilities,
      reason,
      setup: setupFor(provider, selection, profileAvailable, env, endpointDiscovery),
    };
  });
  return { preferences, storage_path: getLlmSelectionPreferencesPath(), candidates };
}

export function loadLlmSelectionPreferences(): LlmSelectionPreferences | null {
  return loadPersistedLlmSelectionPreferences();
}

export function validateLlmSelectionPreferences(
  input: { provider?: unknown; model_id?: unknown },
  snapshot: LlmSelectionSnapshot = getLlmSelectionSnapshot()
): Pick<LlmSelectionPreferences, 'provider' | 'model_id'> {
  const provider =
    typeof input.provider === 'string' && input.provider.trim()
      ? input.provider.trim()
      : snapshot.preferences.provider;
  const candidate = snapshot.candidates.find((entry) => entry.provider === provider);
  if (!candidate) throw new Error(`Unknown reasoning provider: ${provider}`);
  if (!candidate.selectable) {
    throw new Error(`Reasoning provider ${provider} is not selectable: ${candidate.reason}`);
  }
  const model_id =
    typeof input.model_id === 'string' && input.model_id.trim() ? input.model_id.trim() : undefined;
  if (model_id && !candidate.model_ids.includes(model_id)) {
    throw new Error(`Model ${model_id} is not registered for reasoning provider ${provider}`);
  }
  return { provider, model_id };
}

export function saveLlmSelectionPreferences(input: {
  provider?: unknown;
  model_id?: unknown;
}): LlmSelectionSnapshot {
  const snapshot = getLlmSelectionSnapshot();
  const { provider, model_id } = validateLlmSelectionPreferences(input, snapshot);
  const next: LlmSelectionPreferences = {
    version: '1.0.0',
    provider,
    model_id,
    updated_at: nowIso(),
  };
  const filePath = getLlmSelectionPreferencesPath();
  const validated = validateLlmSelectionPreferencesAtPath(next, filePath);
  safeWriteFile(filePath, JSON.stringify(validated, null, 2) + '\n', {
    mkdir: true,
    encoding: 'utf8',
  });
  return { ...snapshot, preferences: next };
}

/**
 * Persist a non-secret endpoint URL for an `endpoint`-kind candidate into
 * `.env.local` and the live process env. Provider must be a known candidate
 * whose setup requires a URL — never a free-form env name from the client.
 */
export function saveReasoningEndpoint(input: {
  provider?: unknown;
  url?: unknown;
}): LlmSelectionSnapshot {
  const provider =
    typeof input.provider === 'string' && input.provider.trim() ? input.provider.trim() : '';
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : '';
  const snapshot = getLlmSelectionSnapshot();
  const candidate = snapshot.candidates.find((entry) => entry.provider === provider);
  if (!candidate) throw new Error(`Unknown reasoning provider: ${provider}`);
  const envName = candidate.setup.endpoint_env_name;
  if (candidate.setup.kind !== 'endpoint' || !envName) {
    throw new Error(`Reasoning provider ${provider} is not configured through an endpoint URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Endpoint must be a valid http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Endpoint must be a valid http(s) URL');
  }
  if (candidate.setup.endpoint_policy === 'local' && !isLocalReasoningEndpoint(url)) {
    throw new Error(`Reasoning provider ${provider} only accepts a local endpoint URL`);
  }
  persistEnvValue(envName, parsed.toString().replace(/\/+$/u, ''));
  setRegisteredEnv(envName, parsed.toString().replace(/\/+$/u, ''));
  return getLlmSelectionSnapshot();
}
