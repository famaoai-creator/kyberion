import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { safeJsonParse } from './validators.js';
import { secureFetch } from './network.js';
import { getServiceEndpointRecord } from './service-binding.js';
import {
  getServiceRuntimePolicy,
  resolveServiceRuntimeRoot,
  type ServiceRuntimeMode,
} from './service-runtime-policy.js';

export type ServiceRuntimeStatus = 'active' | 'shadow' | 'disabled';
export type ServiceRuntimePlatform = 'any' | 'darwin' | 'linux' | 'win32';
export type ServiceRuntimeKind = 'local_service' | 'remote_service';
export type ServiceRuntimeAction = 'probe' | 'provision' | 'reuse' | 'pin';

export interface ServiceRuntimeProbeDefinition {
  kind: 'http';
  method: 'GET' | 'POST';
  path: string;
  description?: string;
}

export interface ServiceRuntimeProvisionPlan {
  kind: 'service_preset';
  preset_path?: string;
  description?: string;
}

export interface ServiceRuntimeRecord {
  service_id: string;
  display_name: string;
  kind: ServiceRuntimeKind;
  status: ServiceRuntimeStatus;
  platforms: ServiceRuntimePlatform[];
  supported_modes: ServiceRuntimeMode[];
  default_base_url?: string;
  trial_probe: ServiceRuntimeProbeDefinition;
  install_plan?: ServiceRuntimeProvisionPlan;
  installed_probe?: ServiceRuntimeProbeDefinition;
  fallback_service_id?: string;
  managed_service_subpath?: string;
  service_endpoint_path?: string;
  service_preset_path?: string;
  notes?: string;
}

export interface ServiceRuntimeRegistry {
  version: string;
  default_service_id: string;
  services: ServiceRuntimeRecord[];
}

export interface ServiceRuntimeState {
  version: string;
  service_id: string;
  status: ServiceRuntimeMode;
  base_url?: string;
  managed_service_path: string;
  installed_at?: string;
  pinned_at?: string;
  provenance?: {
    action: string;
    command?: string;
    args?: string[];
    notes?: string;
  };
}

export type ServiceRuntimeLifecycleStage =
  | 'trial'
  | 'approved_install'
  | 'installed'
  | 'pinned'
  | 'install_required'
  | 'unsupported';

export interface ServiceRuntimeResolution {
  service: ServiceRuntimeRecord;
  state: ServiceRuntimeState | null;
  requested_mode: ServiceRuntimeMode;
  selected_action: ServiceRuntimeAction;
  selected_probe: ServiceRuntimeProbeDefinition | null;
  selected_plan: ServiceRuntimeProvisionPlan | null;
  available: boolean;
  installed: boolean;
  requires_install: boolean;
  managed_service_path: string;
  state_path: string;
  base_url: string;
  probe_url?: string;
  reason: string;
}

export interface ServiceRuntimeInventoryItem {
  service: ServiceRuntimeRecord;
  state: ServiceRuntimeState | null;
  requested_mode: ServiceRuntimeMode;
  lifecycle_stage: ServiceRuntimeLifecycleStage;
  selected_action: ServiceRuntimeAction;
  selected_probe: ServiceRuntimeProbeDefinition | null;
  selected_plan: ServiceRuntimeProvisionPlan | null;
  available: boolean;
  installed: boolean;
  requires_install: boolean;
  managed_service_path: string;
  state_path: string;
  base_url: string;
  probe_url?: string;
  reason: string;
}

export interface ServiceRuntimeInventory {
  version: string;
  platform: NodeJS.Platform;
  requested_mode: ServiceRuntimeMode;
  default_service_id: string;
  items: ServiceRuntimeInventoryItem[];
}

const DEFAULT_REGISTRY_PATH = pathResolver.knowledge('product/governance/service-runtime-registry.json');
const STATE_VERSION = '1.0.0';

const FALLBACK_REGISTRY: ServiceRuntimeRegistry = {
  version: 'fallback',
  default_service_id: 'comfyui',
  services: [
    {
      service_id: 'comfyui',
      display_name: 'ComfyUI Local Service Runtime',
      kind: 'local_service',
      status: 'active',
      platforms: ['darwin', 'linux', 'win32'],
      supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
      default_base_url: 'http://127.0.0.1:8188',
      trial_probe: {
        kind: 'http',
        method: 'GET',
        path: 'system_stats',
        description: 'Probe the local ComfyUI service statistics endpoint.',
      },
      install_plan: {
        kind: 'service_preset',
        preset_path: 'knowledge/product/orchestration/service-presets/comfyui.json',
        description: 'Use the ComfyUI service preset to provision or connect the local runtime.',
      },
      installed_probe: {
        kind: 'http',
        method: 'GET',
        path: 'system_stats',
        description: 'Re-check the ComfyUI service after provisioning.',
      },
      managed_service_subpath: 'service-runtimes/comfyui',
      service_endpoint_path: 'knowledge/product/orchestration/service-endpoints/comfyui.json',
      service_preset_path: 'knowledge/product/orchestration/service-presets/comfyui.json',
      notes: 'ComfyUI is managed as a service runtime so availability, provisioning intent, and managed location can be tracked separately from media-generation routing.',
    },
  ],
};

let cachedRegistryPath: string | null = null;
let cachedRegistry: ServiceRuntimeRegistry | null = null;

function getRegistryPath(): string {
  return process.env.KYBERION_SERVICE_RUNTIME_REGISTRY_PATH?.trim() || DEFAULT_REGISTRY_PATH;
}

function loadRegistryFromPath(registryPath: string): ServiceRuntimeRegistry {
  const raw = safeReadFile(registryPath, { encoding: 'utf8' }) as string;
  return safeJsonParse<ServiceRuntimeRegistry>(raw, 'service runtime registry');
}

function getRegistry(): ServiceRuntimeRegistry {
  const registryPath = getRegistryPath();
  if (cachedRegistryPath === registryPath && cachedRegistry) return cachedRegistry;

  if (!safeExistsSync(registryPath)) {
    cachedRegistryPath = registryPath;
    cachedRegistry = FALLBACK_REGISTRY;
    return cachedRegistry;
  }

  try {
    const parsed = loadRegistryFromPath(registryPath);
    cachedRegistryPath = registryPath;
    cachedRegistry = parsed;
    return parsed;
  } catch (error: any) {
    logger.warn(`[SERVICE_RUNTIME_REGISTRY] Failed to load registry at ${registryPath}: ${error.message}`);
    cachedRegistryPath = registryPath;
    cachedRegistry = FALLBACK_REGISTRY;
    return cachedRegistry;
  }
}

function isSupportedPlatform(record: ServiceRuntimeRecord, platform: NodeJS.Platform): boolean {
  return record.platforms.includes('any') || record.platforms.includes(platform as ServiceRuntimePlatform);
}

function normalizeServiceId(serviceId?: string): string {
  return String(serviceId || '').trim();
}

function resolveManagedServicePath(record: ServiceRuntimeRecord): string {
  const subPath = record.managed_service_subpath || `service-runtimes/${record.service_id}`;
  return path.join(resolveServiceRuntimeRoot(getServiceRuntimePolicy()), subPath);
}

function resolveStatePath(record: ServiceRuntimeRecord): string {
  return path.join(resolveManagedServicePath(record), 'state.json');
}

function loadStateFromPath(statePath: string): ServiceRuntimeState | null {
  if (!safeExistsSync(statePath)) return null;
  try {
    return safeJsonParse<ServiceRuntimeState>(safeReadFile(statePath, { encoding: 'utf8' }) as string, 'service runtime state');
  } catch {
    return null;
  }
}

function writeState(record: ServiceRuntimeRecord, state: Omit<ServiceRuntimeState, 'version' | 'service_id' | 'managed_service_path'> & Partial<Pick<ServiceRuntimeState, 'version'>>): ServiceRuntimeState {
  const resolvedState: ServiceRuntimeState = {
    version: state.version || STATE_VERSION,
    service_id: record.service_id,
    managed_service_path: resolveManagedServicePath(record),
    status: state.status,
    base_url: state.base_url,
    installed_at: state.installed_at,
    pinned_at: state.pinned_at,
    provenance: state.provenance,
  };
  const statePath = resolveStatePath(record);
  safeMkdir(path.dirname(statePath), { recursive: true });
  safeWriteFile(statePath, JSON.stringify(resolvedState, null, 2));
  return resolvedState;
}

function resolveBaseUrl(record: ServiceRuntimeRecord, state: ServiceRuntimeState | null): string {
  const envCandidates = [
    'KYBERION_COMFY_BASE_URL',
    `KYBERION_${record.service_id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BASE_URL`,
  ];
  for (const envKey of envCandidates) {
    const value = process.env[envKey]?.trim();
    if (value) return value;
  }
  const endpointBase = getServiceEndpointRecord(record.service_id)?.base_url?.trim();
  if (endpointBase) return endpointBase;
  if (state?.base_url?.trim()) return state.base_url.trim();
  return (record.default_base_url || '').trim();
}

function resolveProbe(record: ServiceRuntimeRecord, requestedMode: ServiceRuntimeMode): ServiceRuntimeProbeDefinition | null {
  if (requestedMode === 'pinned' && record.installed_probe) {
    return record.installed_probe;
  }
  if (requestedMode === 'installed' && record.installed_probe) {
    return record.installed_probe;
  }
  return record.trial_probe || null;
}

function resolvePlan(record: ServiceRuntimeRecord, requestedMode: ServiceRuntimeMode): ServiceRuntimeProvisionPlan | null {
  if (requestedMode === 'approved_install' || requestedMode === 'pinned') {
    return record.install_plan || null;
  }
  return record.install_plan || null;
}

function selectAction(state: ServiceRuntimeState | null, requestedMode: ServiceRuntimeMode): ServiceRuntimeAction {
  if (state?.status === 'pinned') return 'pin';
  if (state?.status === 'installed') return 'reuse';
  if (requestedMode === 'approved_install') return 'provision';
  if (requestedMode === 'pinned') return 'pin';
  return 'probe';
}

async function runHttpProbe(
  record: ServiceRuntimeRecord,
  state: ServiceRuntimeState | null,
  probe: ServiceRuntimeProbeDefinition,
): Promise<{ available: boolean; probe_url?: string; reason: string }> {
  const baseUrl = resolveBaseUrl(record, state);
  if (!baseUrl) {
    return { available: false, reason: 'no_base_url_configured' };
  }
  const probeUrl = `${baseUrl.replace(/\/+$/u, '')}/${probe.path.replace(/^\/+/u, '')}`;
  try {
    await secureFetch({
      method: probe.method,
      url: probeUrl,
      timeout: 4000,
      kyberion_allow_local_network: true,
    });
    return { available: true, probe_url: probeUrl, reason: 'probe_succeeded' };
  } catch (error: any) {
    return {
      available: false,
      probe_url: probeUrl,
      reason: error?.message || 'probe_failed',
    };
  }
}

export function resetServiceRuntimeRegistryCache(): void {
  cachedRegistryPath = null;
  cachedRegistry = null;
}

export function getServiceRuntimeRegistry(): ServiceRuntimeRegistry {
  return getRegistry();
}

export function getServiceRuntimeRecord(serviceId?: string): ServiceRuntimeRecord | null {
  const normalized = normalizeServiceId(serviceId);
  if (!normalized) return null;
  return getRegistry().services.find((service) => service.service_id === normalized) || null;
}

export async function resolveServiceRuntimeForPlatform(
  serviceId?: string,
  requestedMode: ServiceRuntimeMode = 'trial',
  platform: NodeJS.Platform = process.platform,
): Promise<ServiceRuntimeResolution> {
  const registry = getRegistry();
  const service = getServiceRuntimeRecord(serviceId) || getServiceRuntimeRecord(registry.default_service_id);
  if (!service) {
    throw new Error(`No service runtime record found for "${serviceId || registry.default_service_id}"`);
  }
  if (service.status === 'disabled') {
    return {
      service,
      state: null,
      requested_mode: requestedMode,
      selected_action: 'probe',
      selected_probe: null,
      selected_plan: null,
      available: false,
      installed: false,
      requires_install: false,
      managed_service_path: resolveManagedServicePath(service),
      state_path: resolveStatePath(service),
      base_url: resolveBaseUrl(service, null),
      reason: 'service_disabled',
    };
  }

  const managedServicePath = resolveManagedServicePath(service);
  const statePath = resolveStatePath(service);
  const state = loadStateFromPath(statePath);
  const selectedProbe = resolveProbe(service, requestedMode);
  const selectedPlan = resolvePlan(service, requestedMode);
  const selectedAction = selectAction(state, requestedMode);
  const baseUrl = resolveBaseUrl(service, state);

  if (!isSupportedPlatform(service, platform)) {
    return {
      service,
      state,
      requested_mode: requestedMode,
      selected_action: selectedAction,
      selected_probe: selectedProbe,
      selected_plan: selectedPlan,
      available: false,
      installed: Boolean(state),
      requires_install: !Boolean(state),
      managed_service_path: managedServicePath,
      state_path: statePath,
      base_url: baseUrl,
      reason: 'unsupported_platform',
    };
  }

  if (!selectedProbe) {
    return {
      service,
      state,
      requested_mode: requestedMode,
      selected_action: selectedAction,
      selected_probe: null,
      selected_plan: selectedPlan,
      available: false,
      installed: Boolean(state),
      requires_install: !Boolean(state),
      managed_service_path: managedServicePath,
      state_path: statePath,
      base_url: baseUrl,
      reason: 'no_probe_defined',
    };
  }

  const availableProbe = state?.status === 'pinned' || state?.status === 'installed'
    ? await runHttpProbe(service, state, selectedProbe)
    : await runHttpProbe(service, state, selectedProbe);

  const available = availableProbe.available;
  const installed = available || Boolean(state?.status === 'installed' || state?.status === 'pinned');
  const requiresInstall = !installed && requestedMode !== 'trial';
  const reason = availableProbe.reason;

  return {
    service,
    state,
    requested_mode: requestedMode,
    selected_action: selectedAction,
    selected_probe: selectedProbe,
    selected_plan: selectedPlan,
    available,
    installed,
    requires_install: requiresInstall,
    managed_service_path: managedServicePath,
    state_path: statePath,
    base_url: baseUrl,
    probe_url: availableProbe.probe_url,
    reason,
  };
}

export async function probeServiceRuntime(
  serviceId?: string,
  requestedMode: ServiceRuntimeMode = 'trial',
  platform: NodeJS.Platform = process.platform,
): Promise<ServiceRuntimeResolution> {
  return resolveServiceRuntimeForPlatform(serviceId, requestedMode, platform);
}

export async function listServiceRuntimeInventory(
  requestedMode: ServiceRuntimeMode = 'trial',
  platform: NodeJS.Platform = process.platform,
): Promise<ServiceRuntimeInventory> {
  const registry = getRegistry();
  const items: ServiceRuntimeInventoryItem[] = [];
  for (const service of registry.services) {
    const resolution = await resolveServiceRuntimeForPlatform(service.service_id, requestedMode, platform);
    const lifecycleStage: ServiceRuntimeLifecycleStage =
      !isSupportedPlatform(service, platform)
        ? 'unsupported'
        : resolution.state?.status === 'pinned'
          ? 'pinned'
          : resolution.state?.status === 'installed'
            ? 'installed'
          : resolution.available
              ? requestedMode === 'approved_install'
                ? 'approved_install'
                : requestedMode === 'installed'
                  ? 'installed'
                  : requestedMode === 'pinned'
                    ? 'pinned'
                    : 'trial'
              : resolution.requires_install
                ? 'install_required'
                : 'unsupported';
    items.push({
      service,
      state: resolution.state,
      requested_mode: requestedMode,
      lifecycle_stage: lifecycleStage,
      selected_action: resolution.selected_action,
      selected_probe: resolution.selected_probe,
      selected_plan: resolution.selected_plan,
      available: resolution.available,
      installed: resolution.installed,
      requires_install: resolution.requires_install,
      managed_service_path: resolution.managed_service_path,
      state_path: resolution.state_path,
      base_url: resolution.base_url,
      probe_url: resolution.probe_url,
      reason: resolution.reason,
    });
  }

  return {
    version: registry.version,
    platform,
    requested_mode: requestedMode,
    default_service_id: registry.default_service_id,
    items,
  };
}

export async function getServiceRuntimeInventoryItem(
  serviceId: string,
  requestedMode: ServiceRuntimeMode = 'trial',
  platform: NodeJS.Platform = process.platform,
): Promise<ServiceRuntimeInventoryItem | null> {
  const inventory = await listServiceRuntimeInventory(requestedMode, platform);
  return inventory.items.find((item) => item.service.service_id === serviceId) || null;
}

export function getServiceRuntimeState(serviceId: string): ServiceRuntimeState | null {
  const record = getServiceRuntimeRecord(serviceId);
  if (!record) return null;
  return loadStateFromPath(resolveStatePath(record));
}

export function markServiceRuntimeInstalled(
  serviceId: string,
  baseUrl?: string,
  notes?: string,
): ServiceRuntimeState {
  const record = getServiceRuntimeRecord(serviceId);
  if (!record) {
    throw new Error(`Unknown service runtime: ${serviceId}`);
  }
  const state = writeState(record, {
    status: 'installed',
    base_url: baseUrl,
    installed_at: new Date().toISOString(),
    provenance: {
      action: 'install',
      notes,
    },
  });
  return state;
}

export function markServiceRuntimePinned(
  serviceId: string,
  baseUrl?: string,
  notes?: string,
): ServiceRuntimeState {
  const record = getServiceRuntimeRecord(serviceId);
  if (!record) {
    throw new Error(`Unknown service runtime: ${serviceId}`);
  }
  const state = writeState(record, {
    status: 'pinned',
    base_url: baseUrl,
    pinned_at: new Date().toISOString(),
    provenance: {
      action: 'pin',
      notes,
    },
  });
  return state;
}

export function clearServiceRuntimeState(serviceId: string): void {
  const record = getServiceRuntimeRecord(serviceId);
  if (!record) return;
  safeRmSync(resolveStatePath(record), { force: true });
}
