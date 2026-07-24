import * as path from 'node:path';

import {
  getMediaBackendRegistry,
  listMediaBackends,
  type MediaBackendModality,
} from './media-backend-registry.js';
import {
  ADAPTER_DEFAULT_KEYS,
  loadAdapterDefaultPreferences,
  setAdapterDefaultPreferences,
  type AdapterDefaultKey,
  type AdapterDefaultPreferences,
} from './adapter-default-preferences.js';
import { resolveActiveProfileRoot } from './profile-root.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import { getServiceRuntimeRegistry } from './service-runtime-registry.js';
import { listToolRuntimes, getToolRuntimeRegistry } from './tool-runtime-registry.js';
import { listVadBackends, resolveVadBackend } from './vad-registry.js';
import { listEmailBackends } from './email-bridge.js';
import { listEmailAccountProviders } from './email-account-catalog.js';

export type AdapterDefaultSelectionStatus = 'ready' | 'needs_setup' | 'unsupported';

export interface AdapterDefaultCandidate {
  id: string;
  display_name: string;
  adapter_id: string;
  status: AdapterDefaultSelectionStatus;
  selectable: boolean;
  reason: string;
}

export interface AdapterDefaultCategory {
  key: AdapterDefaultKey;
  display_name: string;
  selected_id: string;
  candidates: AdapterDefaultCandidate[];
}

export interface AdapterDefaultSelectionSnapshot {
  preferences: AdapterDefaultPreferences;
  storage_path: string;
  categories: AdapterDefaultCategory[];
}

const CATEGORY_LABELS: Record<AdapterDefaultKey, string> = {
  'media.image': 'Image generation backend',
  'media.video': 'Video rendering backend',
  'media.music': 'Music generation backend',
  'email.backend': 'Email backend',
  'email.account': 'Email account',
  'service.runtime': 'Service runtime',
  'tool.runtime': 'Tool runtime',
  'voice.vad': 'Voice activity detector',
};

function selectionPath(): string {
  return path.join(resolveActiveProfileRoot(), 'onboarding', 'adapter-defaults.json');
}

function isAdapterDefaultKey(value: string): value is AdapterDefaultKey {
  return (ADAPTER_DEFAULT_KEYS as readonly string[]).includes(value);
}

function loadPersistedPreferences(): AdapterDefaultPreferences {
  const filePath = selectionPath();
  if (!safeExistsSync(filePath)) {
    return setAdapterDefaultPreferences({ version: '1.0.0', defaults: {} });
  }
  try {
    const parsed = JSON.parse(
      String(safeReadFile(filePath, { encoding: 'utf8' }))
    ) as Partial<AdapterDefaultPreferences> & { defaults?: Record<string, unknown> };
    const defaults: Partial<Record<AdapterDefaultKey, string>> = {};
    for (const [key, value] of Object.entries(parsed.defaults || {})) {
      if (isAdapterDefaultKey(key) && typeof value === 'string' && value.trim()) {
        defaults[key] = value.trim();
      }
    }
    return setAdapterDefaultPreferences({
      version: '1.0.0',
      defaults,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : undefined,
    });
  } catch {
    return setAdapterDefaultPreferences({ version: '1.0.0', defaults: {} });
  }
}

function supportedOnCurrentPlatform(platforms: string[]): boolean {
  return platforms.includes('any') || platforms.includes(process.platform);
}

function statusForRecord(
  status: 'active' | 'shadow' | 'disabled',
  supported: boolean,
  kind: string
): Pick<AdapterDefaultCandidate, 'status' | 'selectable' | 'reason'> {
  if (!supported) {
    return {
      status: 'unsupported',
      selectable: false,
      reason: `${kind} is not supported on platform ${process.platform}.`,
    };
  }
  if (status === 'disabled') {
    return { status: 'unsupported', selectable: false, reason: `${kind} is disabled by policy.` };
  }
  if (status === 'shadow') {
    return {
      status: 'needs_setup',
      selectable: false,
      reason: `${kind} is registered as a shadow candidate and is not promoted for default use.`,
    };
  }
  return {
    status: 'ready',
    selectable: true,
    reason: `${kind} is registered as an active governed adapter. Runtime health is checked when used.`,
  };
}

function mediaCategory(modality: Exclude<MediaBackendModality, 'voice'>): AdapterDefaultCategory {
  const registry = getMediaBackendRegistry();
  const selectedId =
    loadAdapterDefaultPreferences().defaults[`media.${modality}`] ||
    registry.default_backend_ids[modality];
  return {
    key: `media.${modality}`,
    display_name: CATEGORY_LABELS[`media.${modality}`],
    selected_id: selectedId,
    candidates: listMediaBackends(modality).map((backend) => ({
      id: backend.backend_id,
      display_name: backend.display_name,
      adapter_id: `media.${backend.kind}`,
      ...statusForRecord(
        backend.status,
        supportedOnCurrentPlatform(backend.platforms),
        `Media backend ${backend.backend_id}`
      ),
    })),
  };
}

function serviceCategory(): AdapterDefaultCategory {
  const registry = getServiceRuntimeRegistry();
  const selectedId =
    loadAdapterDefaultPreferences().defaults['service.runtime'] || registry.default_service_id;
  return {
    key: 'service.runtime',
    display_name: CATEGORY_LABELS['service.runtime'],
    selected_id: selectedId,
    candidates: registry.services.map((service) => ({
      id: service.service_id,
      display_name: service.display_name,
      adapter_id: 'service-runtime',
      ...statusForRecord(
        service.status,
        supportedOnCurrentPlatform(service.platforms),
        `Service runtime ${service.service_id}`
      ),
    })),
  };
}

function toolCategory(): AdapterDefaultCategory {
  const registry = getToolRuntimeRegistry();
  const selectedId =
    loadAdapterDefaultPreferences().defaults['tool.runtime'] || registry.default_tool_id;
  return {
    key: 'tool.runtime',
    display_name: CATEGORY_LABELS['tool.runtime'],
    selected_id: selectedId,
    candidates: listToolRuntimes().map((tool) => {
      const registryStatus = statusForRecord(
        tool.status,
        supportedOnCurrentPlatform(tool.platforms),
        `Tool runtime ${tool.tool_id}`
      );
      return {
        id: tool.tool_id,
        display_name: tool.display_name,
        adapter_id: `tool-runtime.${tool.ecosystem}`,
        status: registryStatus.status,
        selectable: registryStatus.selectable,
        reason: registryStatus.reason,
      };
    }),
  };
}

function vadCategory(): AdapterDefaultCategory {
  const selectedId = loadAdapterDefaultPreferences().defaults['voice.vad'] || 'energy';
  return {
    key: 'voice.vad',
    display_name: CATEGORY_LABELS['voice.vad'],
    selected_id: selectedId,
    candidates: listVadBackends().map((id) => {
      const resolution = resolveVadBackend(id);
      const ready = resolution.backend.backend_id === id;
      return {
        id,
        display_name: id === 'energy' ? 'Energy VAD' : id,
        adapter_id: `vad.${id}`,
        status: ready ? 'ready' : 'needs_setup',
        selectable: ready,
        reason: ready
          ? 'VAD backend is registered and passed its availability probe.'
          : resolution.degradedReason || 'VAD backend is not available.',
      };
    }),
  };
}

function emailCategory(): AdapterDefaultCategory {
  const candidates = listEmailBackends();
  const selectedId =
    loadAdapterDefaultPreferences().defaults['email.backend'] ||
    candidates.find((candidate) => candidate.selectable)?.id ||
    candidates[0]?.id ||
    'auto';
  return {
    key: 'email.backend',
    display_name: CATEGORY_LABELS['email.backend'],
    selected_id: selectedId,
    candidates,
  };
}

function emailAccountCategory(): AdapterDefaultCategory {
  const candidates = listEmailAccountProviders();
  const selectedId =
    loadAdapterDefaultPreferences().defaults['email.account'] ||
    candidates.find((candidate) => candidate.selectable)?.id ||
    candidates[0]?.id ||
    'gmail';
  return {
    key: 'email.account',
    display_name: CATEGORY_LABELS['email.account'],
    selected_id: selectedId,
    candidates,
  };
}

export function getAdapterDefaultSelectionSnapshot(): AdapterDefaultSelectionSnapshot {
  const preferences = loadPersistedPreferences();
  return {
    preferences,
    storage_path: selectionPath(),
    categories: [
      mediaCategory('image'),
      mediaCategory('video'),
      mediaCategory('music'),
      emailCategory(),
      emailAccountCategory(),
      serviceCategory(),
      toolCategory(),
      vadCategory(),
    ],
  };
}

export function validateAdapterDefaultPreferences(
  input: Record<string, unknown>,
  snapshot: AdapterDefaultSelectionSnapshot = getAdapterDefaultSelectionSnapshot()
): Partial<Record<AdapterDefaultKey, string>> {
  const next: Partial<Record<AdapterDefaultKey, string>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isAdapterDefaultKey(key)) throw new Error(`Unknown adapter default category: ${key}`);
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Adapter default ${key} must be a non-empty string.`);
    }
    const category = snapshot.categories.find((entry) => entry.key === key);
    const candidate = category?.candidates.find((entry) => entry.id === value.trim());
    if (!candidate) throw new Error(`Unknown adapter default candidate for ${key}: ${value}`);
    if (!candidate.selectable) {
      throw new Error(`Adapter default ${key} is not selectable: ${candidate.reason}`);
    }
    next[key] = value.trim();
  }
  return next;
}

export function saveAdapterDefaultPreferences(
  input: Record<string, unknown>
): AdapterDefaultSelectionSnapshot {
  const snapshot = getAdapterDefaultSelectionSnapshot();
  const validated = validateAdapterDefaultPreferences(input, snapshot);
  const nextDefaults = { ...snapshot.preferences.defaults, ...validated };
  const preferences: AdapterDefaultPreferences = {
    version: '1.0.0',
    defaults: nextDefaults,
    updated_at: new Date().toISOString(),
  };
  setAdapterDefaultPreferences(preferences);
  safeWriteFile(selectionPath(), JSON.stringify(preferences, null, 2) + '\n', {
    mkdir: true,
    encoding: 'utf8',
  });
  return { ...snapshot, preferences };
}

export function initializeAdapterDefaultPreferences(): AdapterDefaultPreferences {
  return loadPersistedPreferences();
}
