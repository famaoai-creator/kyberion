import * as path from 'node:path';

import { discoverProviders } from './provider-discovery.js';
import { resolveActiveProfileRoot } from './profile-root.js';
import { loadModelRegistry } from './reasoning-model-routing.js';
import { loadReasoningRoutePolicy, type ReasoningRoutePolicy } from './reasoning-route-resolver.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';

export type LlmSelectionStatus = 'ready' | 'needs_setup' | 'unsupported';

export interface LlmSelectionPreferences {
  version: '1.0.0';
  provider: string;
  model_id?: string;
  updated_at?: string;
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

function selectionPath(): string {
  return path.join(resolveActiveProfileRoot(), 'onboarding', 'llm-selection.json');
}

function readSelection(): LlmSelectionPreferences | null {
  const filePath = selectionPath();
  if (!safeExistsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(
      String(safeReadFile(filePath, { encoding: 'utf8' }))
    ) as Partial<LlmSelectionPreferences>;
    if (typeof parsed.provider !== 'string' || !parsed.provider.trim()) return null;
    return {
      version: '1.0.0',
      provider: parsed.provider.trim(),
      model_id:
        typeof parsed.model_id === 'string' && parsed.model_id.trim()
          ? parsed.model_id.trim()
          : undefined,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : undefined,
    };
  } catch {
    return null;
  }
}

function hasProfileForMode(policy: ReasoningRoutePolicy, mode: string): boolean {
  return Object.values(policy.profiles).some((profile) => profile.mode === mode);
}

function isAvailable(
  selection: NonNullable<ReasoningRoutePolicy['runtime_adapters'][string]['selection']>,
  discovered: ReturnType<typeof discoverProviders>,
  env: NodeJS.ProcessEnv
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
  return (selection.availability.names || []).some((name) => Boolean(env[name]?.trim()));
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
  const requested = process.env.KYBERION_REASONING_BACKEND?.trim();
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
  return readSelection() || defaultSelection(policy);
}

export function getLlmSelectionSnapshot(
  env: NodeJS.ProcessEnv = process.env
): LlmSelectionSnapshot {
  const policy = loadReasoningRoutePolicy();
  const discovered = discoverProviders();
  const preferences = getPreferences(policy);
  const candidates = Object.entries(policy.runtime_adapters).map(([provider, adapter]) => {
    const selection = adapter.selection;
    const profileAvailable = hasProfileForMode(policy, provider);
    const available = Boolean(
      selection && profileAvailable && isAvailable(selection, discovered, env)
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
    };
  });
  return { preferences, storage_path: selectionPath(), candidates };
}

export function loadLlmSelectionPreferences(): LlmSelectionPreferences | null {
  return readSelection();
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
    updated_at: new Date().toISOString(),
  };
  safeWriteFile(selectionPath(), JSON.stringify(next, null, 2) + '\n', {
    mkdir: true,
    encoding: 'utf8',
  });
  return { ...snapshot, preferences: next };
}
