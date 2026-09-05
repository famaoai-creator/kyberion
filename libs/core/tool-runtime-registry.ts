import * as path from 'node:path';
import { logger } from './core.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExecResult,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import {
  getToolRuntimePolicy,
  resolveToolRuntimeRoot,
  type ToolRuntimeEcosystem,
  type ToolRuntimeMode,
  type ToolRuntimeModePreference,
} from './tool-runtime-policy.js';
import { getAdapterDefault } from './adapter-default-preferences.js';

export type ToolRuntimeStatus = 'active' | 'shadow' | 'disabled';
export type ToolRuntimePlatform = 'any' | 'darwin' | 'linux' | 'win32';
export type ToolRuntimeBackendKind =
  'uvx' | 'uv' | 'pipx' | 'npx' | 'npm' | 'pnpm' | 'brew' | 'winget' | 'system';
export type ToolRuntimeAction = 'run_trial' | 'run_installed' | 'install' | 'pin';

export interface ToolRuntimeBackendCommand {
  kind: ToolRuntimeBackendKind;
  command: string;
  args: string[];
  description?: string;
}

export interface ToolRuntimeRecord {
  tool_id: string;
  display_name: string;
  ecosystem: ToolRuntimeEcosystem;
  status: ToolRuntimeStatus;
  platforms: ToolRuntimePlatform[];
  supported_modes: ToolRuntimeMode[];
  trial_backend: ToolRuntimeBackendCommand;
  install_backend?: ToolRuntimeBackendCommand;
  install_backend_platform_overrides?: Partial<
    Record<ToolRuntimePlatform, ToolRuntimeBackendCommand>
  >;
  installed_backend?: ToolRuntimeBackendCommand;
  fallback_tool_id?: string;
  managed_env_subpath?: string;
  notes?: string;
}

export interface ToolRuntimeRegistry {
  version: string;
  default_tool_id: string;
  tools: ToolRuntimeRecord[];
}

export interface ToolRuntimeState {
  version: string;
  tool_id: string;
  status: ToolRuntimeMode;
  backend_kind: ToolRuntimeBackendKind;
  command: string;
  args: string[];
  managed_env_path: string;
  installed_at?: string;
  pinned_at?: string;
  provenance?: {
    action: string;
    command?: string;
    args?: string[];
    notes?: string;
  };
}

export interface ToolRuntimeResolution {
  tool: ToolRuntimeRecord;
  state: ToolRuntimeState | null;
  requested_mode: ToolRuntimeMode;
  selected_action: ToolRuntimeAction;
  selected_backend: ToolRuntimeBackendCommand | null;
  trial_backend: ToolRuntimeBackendCommand;
  install_backend: ToolRuntimeBackendCommand | null;
  installed_backend: ToolRuntimeBackendCommand | null;
  installed: boolean;
  requires_install: boolean;
  managed_env_path: string;
  state_path: string;
  available_commands: string[];
  reason: string;
}

export type ToolRuntimeLifecycleStage =
  'trial' | 'approved_install' | 'installed' | 'pinned' | 'install_required' | 'unsupported';

export interface ToolRuntimeInventoryItem {
  tool: ToolRuntimeRecord;
  state: ToolRuntimeState | null;
  requested_mode: ToolRuntimeMode;
  lifecycle_stage: ToolRuntimeLifecycleStage;
  selected_action: ToolRuntimeAction;
  selected_backend: ToolRuntimeBackendCommand | null;
  trial_backend: ToolRuntimeBackendCommand;
  install_backend: ToolRuntimeBackendCommand | null;
  installed_backend: ToolRuntimeBackendCommand | null;
  installed: boolean;
  requires_install: boolean;
  managed_env_path: string;
  state_path: string;
  available_commands: string[];
  reason: string;
}

export interface ToolRuntimeInventory {
  version: string;
  platform: NodeJS.Platform;
  requested_mode: ToolRuntimeMode;
  default_tool_id: string;
  items: ToolRuntimeInventoryItem[];
}

const DEFAULT_REGISTRY_PATH = pathResolver.knowledge(
  'product/governance/tool-runtime-registry.json'
);
const REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/tool-runtime-registry.schema.json'
);
const TOOL_RUNTIME_STATE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/tool-runtime-state.schema.json'
);
const STATE_VERSION = '1.0.0';

function getRegistryPath(): string {
  const configured =
    getRegisteredEnvText('KYBERION_TOOL_RUNTIME_REGISTRY_PATH')?.trim() || DEFAULT_REGISTRY_PATH;
  return assertSafeRepositoryPath(configured, { allowMissingLeaf: true });
}

const toolRuntimeRegistryCatalog = defineCatalog<ToolRuntimeRegistry>({
  id: 'tool-runtime-registry',
  path: getRegistryPath,
  schema: REGISTRY_SCHEMA_PATH,
});

const toolRuntimeStateCatalog = defineCatalog<ToolRuntimeState>({
  id: 'tool-runtime-state',
  path: TOOL_RUNTIME_STATE_SCHEMA_PATH,
  schema: TOOL_RUNTIME_STATE_SCHEMA_PATH,
});

function isSupportedPlatform(record: ToolRuntimeRecord, platform: NodeJS.Platform): boolean {
  return (
    record.platforms.includes('any') || record.platforms.includes(platform as ToolRuntimePlatform)
  );
}

function resolveInstallBackend(
  record: ToolRuntimeRecord,
  platform: NodeJS.Platform
): ToolRuntimeBackendCommand | null {
  return (
    record.install_backend_platform_overrides?.[platform as ToolRuntimePlatform] ||
    record.install_backend_platform_overrides?.any ||
    record.install_backend ||
    null
  );
}

function backendIsAvailable(
  backend: ToolRuntimeBackendCommand | null | undefined,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!backend) return false;
  const resolver = platform === 'win32' ? 'where.exe' : 'which';
  const result = safeExecResult(resolver, [backend.command], {
    timeoutMs: 5_000,
    maxOutputMB: 1,
  });
  return result.status === 0 && Boolean(result.stdout.trim());
}

function resolveManagedEnvPath(tool: ToolRuntimeRecord): string {
  const root = resolveToolRuntimeRoot(getToolRuntimePolicy());
  const subPath = tool.managed_env_subpath || `tool-runtimes/${tool.tool_id}`;
  return assertManagedRuntimePath(root, path.join(root, subPath));
}

function assertManagedRuntimePath(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
  const relative = path.relative(resolvedRoot, resolved).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`[TOOL_RUNTIME_PATH_SCOPE] path escapes managed runtime root: ${candidate}`);
  }
  return resolved;
}

function resolveManagedPythonCandidates(managedEnvPath: string): string[] {
  if (process.platform === 'win32') {
    return [
      path.join(managedEnvPath, 'Scripts', 'python.exe'),
      path.join(managedEnvPath, 'Scripts', 'python3.exe'),
    ];
  }
  return [path.join(managedEnvPath, 'bin', 'python'), path.join(managedEnvPath, 'bin', 'python3')];
}

function normalizeToolId(toolId?: string): string {
  const trimmed = toolId?.trim();
  return trimmed || '';
}

function getRegistry(): ToolRuntimeRegistry {
  return toolRuntimeRegistryCatalog.load();
}

function statePathForTool(tool: ToolRuntimeRecord): string {
  const root = resolveToolRuntimeRoot(getToolRuntimePolicy());
  const subPath = tool.managed_env_subpath || `tool-runtimes/${tool.tool_id}`;
  return assertManagedRuntimePath(root, path.join(root, subPath, 'state.json'));
}

export function _resetToolRuntimeRegistryCacheForTests(): void {
  toolRuntimeRegistryCatalog.reset();
}

export function getToolRuntimeRegistry(): ToolRuntimeRegistry {
  return getRegistry();
}

export function listToolRuntimes(): ToolRuntimeRecord[] {
  return getRegistry().tools;
}

export function getToolRuntimeRecord(toolId?: string): ToolRuntimeRecord {
  const registry = getRegistry();
  const resolvedToolId =
    normalizeToolId(toolId) || getAdapterDefault('tool.runtime') || registry.default_tool_id;
  return (
    registry.tools.find((tool) => tool.tool_id === resolvedToolId) ||
    registry.tools.find((tool) => tool.tool_id === registry.default_tool_id) ||
    registry.tools[0]
  );
}

export function getToolRuntimeStatePath(toolId?: string): string {
  return statePathForTool(getToolRuntimeRecord(toolId));
}

function parseToolRuntimeState(
  value: unknown,
  statePath: string,
  toolId: string
): ToolRuntimeState {
  const record = toolRuntimeStateCatalog.validate(value, statePath);
  if (record.version !== STATE_VERSION) {
    throw new Error('tool runtime state version is invalid');
  }
  if (record.tool_id !== toolId) {
    throw new Error('tool runtime state tool scope mismatch');
  }
  const expectedManagedPath = path.dirname(path.resolve(statePath));
  const managedPath = assertSafeRepositoryPath(record.managed_env_path, {
    allowMissingLeaf: true,
  });
  if (path.resolve(managedPath) !== expectedManagedPath) {
    throw new Error('tool runtime state managed path mismatch');
  }
  return {
    version: record.version,
    tool_id: record.tool_id,
    status: record.status,
    backend_kind: record.backend_kind,
    command: record.command,
    args: [...record.args],
    managed_env_path: managedPath,
    ...(record.installed_at ? { installed_at: record.installed_at } : {}),
    ...(record.pinned_at ? { pinned_at: record.pinned_at } : {}),
    ...(record.provenance
      ? {
          provenance: {
            ...record.provenance,
            args: record.provenance.args ? [...record.provenance.args] : undefined,
          },
        }
      : {}),
  };
}

/** Load tool runtime state through schema, regular-file, and tool/path binding checks. */
export function loadToolRuntimeStateAtPath(statePath: string, toolId: string): ToolRuntimeState {
  const safeStatePath = assertSafeRepositoryPath(statePath, { allowMissingLeaf: true });
  if (!safeLstat(safeStatePath).isFile()) {
    throw new Error(`[TOOL_RUNTIME_STATE] state must be a regular file: ${statePath}`);
  }
  const value = defineCatalog<ToolRuntimeState>({
    id: 'tool-runtime-state',
    path: safeStatePath,
    schema: TOOL_RUNTIME_STATE_SCHEMA_PATH,
  }).load();
  return parseToolRuntimeState(value, safeStatePath, toolId);
}

export function readToolRuntimeState(toolId?: string): ToolRuntimeState | null {
  const statePath = getToolRuntimeStatePath(toolId);
  if (!safeExistsSync(statePath)) return null;
  try {
    return loadToolRuntimeStateAtPath(statePath, getToolRuntimeRecord(toolId).tool_id);
  } catch (error: unknown) {
    logger.warn(
      `[TOOL_RUNTIME_REGISTRY] Failed to read state at ${statePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

function writeToolRuntimeStateFile(state: ToolRuntimeState): void {
  const statePath = getToolRuntimeStatePath(state.tool_id);
  const dir = path.dirname(statePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  const validated = parseToolRuntimeState(state, statePath, state.tool_id);
  safeWriteFile(statePath, JSON.stringify(validated, null, 2), { encoding: 'utf8' });
}

export function markToolRuntimeInstalled(
  toolId: string,
  provenance?: ToolRuntimeState['provenance']
): ToolRuntimeState {
  const tool = getToolRuntimeRecord(toolId);
  const state: ToolRuntimeState = {
    version: STATE_VERSION,
    tool_id: tool.tool_id,
    status: 'installed',
    backend_kind: tool.installed_backend?.kind || tool.trial_backend.kind,
    command: tool.installed_backend?.command || tool.trial_backend.command,
    args: tool.installed_backend?.args || tool.trial_backend.args,
    managed_env_path: resolveManagedEnvPath(tool),
    installed_at: nowIso(),
    provenance: provenance || undefined,
  };
  writeToolRuntimeStateFile(state);
  return state;
}

export function markToolRuntimePinned(
  toolId: string,
  provenance?: ToolRuntimeState['provenance']
): ToolRuntimeState {
  const tool = getToolRuntimeRecord(toolId);
  const state: ToolRuntimeState = {
    version: STATE_VERSION,
    tool_id: tool.tool_id,
    status: 'pinned',
    backend_kind: tool.installed_backend?.kind || tool.trial_backend.kind,
    command: tool.installed_backend?.command || tool.trial_backend.command,
    args: tool.installed_backend?.args || tool.trial_backend.args,
    managed_env_path: resolveManagedEnvPath(tool),
    pinned_at: nowIso(),
    provenance: provenance || undefined,
  };
  writeToolRuntimeStateFile(state);
  return state;
}

export function clearToolRuntimeState(toolId: string): void {
  const statePath = getToolRuntimeStatePath(toolId);
  if (safeExistsSync(statePath)) {
    safeRmSync(statePath, { force: true });
  }
}

function currentModeFromState(state: ToolRuntimeState | null): ToolRuntimeMode | null {
  if (!state) return null;
  return state.status;
}

function resolveLifecycleStage(resolution: ToolRuntimeResolution): ToolRuntimeLifecycleStage {
  const currentState = currentModeFromState(resolution.state);
  if (currentState === 'installed') return 'installed';
  if (currentState === 'pinned') return 'pinned';
  if (resolution.requested_mode === 'approved_install') return 'approved_install';
  if (!resolution.selected_backend && !resolution.installed && resolution.requires_install)
    return 'install_required';
  if (resolution.selected_action === 'run_trial') return 'trial';
  if (resolution.selected_action === 'install') return 'approved_install';
  return resolution.installed ? 'installed' : 'trial';
}

function resolveRequestedMode(
  requestedMode: ToolRuntimeMode,
  record: ToolRuntimeRecord,
  state: ToolRuntimeState | null
): ToolRuntimeAction {
  const installedState =
    currentModeFromState(state) === 'installed' || currentModeFromState(state) === 'pinned';

  if (requestedMode === 'approved_install') return 'install';
  if (installedState && record.installed_backend) return 'run_installed';
  if (requestedMode === 'installed' || requestedMode === 'pinned') {
    return record.installed_backend
      ? 'run_installed'
      : record.trial_backend
        ? 'run_trial'
        : 'install';
  }
  if (requestedMode === 'trial') return record.trial_backend ? 'run_trial' : 'install';
  return record.trial_backend ? 'run_trial' : 'install';
}

export function probeToolRuntime(
  toolId?: string,
  requestedMode: ToolRuntimeMode = 'trial',
  platform: NodeJS.Platform = process.platform
): ToolRuntimeResolution {
  const record = getToolRuntimeRecord(toolId);
  const state = readToolRuntimeState(record.tool_id);
  const installBackend = resolveInstallBackend(record, platform);
  if (!isSupportedPlatform(record, platform)) {
    return {
      tool: record,
      state,
      requested_mode: requestedMode,
      selected_action: 'install',
      selected_backend: installBackend,
      trial_backend: record.trial_backend,
      install_backend: installBackend,
      installed_backend: record.installed_backend || null,
      installed: false,
      requires_install: true,
      managed_env_path: resolveManagedEnvPath(record),
      state_path: statePathForTool(record),
      available_commands: [],
      reason: `tool runtime ${record.tool_id} is not supported on platform ${platform}`,
    };
  }
  const selectedAction = resolveRequestedMode(requestedMode, record, state);

  let selectedBackend: ToolRuntimeBackendCommand | null = null;
  if (selectedAction === 'run_installed')
    selectedBackend = record.installed_backend || record.trial_backend;
  if (selectedAction === 'run_trial') selectedBackend = record.trial_backend;
  if (selectedAction === 'install') selectedBackend = installBackend;

  const availableCommands = [record.trial_backend, installBackend, record.installed_backend]
    .filter((backend): backend is ToolRuntimeBackendCommand => Boolean(backend))
    .filter((backend) => backendIsAvailable(backend, platform))
    .map((backend) => backend.command);

  const installed = Boolean(state && (state.status === 'installed' || state.status === 'pinned'));
  const requiresInstall = selectedAction === 'install';
  const reason =
    selectedAction === 'run_installed'
      ? installed
        ? `using installed tool runtime for ${record.tool_id}`
        : `installed backend selected for ${record.tool_id}`
      : selectedAction === 'run_trial'
        ? `using trial backend for ${record.tool_id}`
        : `install required for ${record.tool_id}`;

  return {
    tool: record,
    state,
    requested_mode: requestedMode,
    selected_action: selectedAction,
    selected_backend: selectedBackend,
    trial_backend: record.trial_backend,
    install_backend: installBackend,
    installed_backend: record.installed_backend || null,
    installed,
    requires_install: requiresInstall,
    managed_env_path: resolveManagedEnvPath(record),
    state_path: statePathForTool(record),
    available_commands: availableCommands,
    reason,
  };
}

export function getToolRuntimeModePreference(toolId?: string): ToolRuntimeModePreference {
  const record = getToolRuntimeRecord(toolId);
  return getToolRuntimePolicy().mode_preference[record.ecosystem] || 'trial_first';
}

export function resolveToolRuntimeAction(
  toolId?: string,
  requestedMode: ToolRuntimeMode = 'trial'
): ToolRuntimeAction {
  return probeToolRuntime(toolId, requestedMode).selected_action;
}

export function resolveToolRuntimeCommand(
  toolId?: string,
  requestedMode: ToolRuntimeMode = 'trial'
): ToolRuntimeBackendCommand | null {
  return probeToolRuntime(toolId, requestedMode).selected_backend;
}

export function resolveManagedToolPythonBin(toolId?: string): string | null {
  const resolution = probeToolRuntime(toolId, 'installed');
  for (const candidate of resolveManagedPythonCandidates(resolution.managed_env_path)) {
    if (safeExistsSync(candidate)) return candidate;
  }
  return null;
}

export function listToolRuntimeInventory(
  requestedMode: ToolRuntimeMode = 'trial',
  platform: NodeJS.Platform = process.platform
): ToolRuntimeInventory {
  const registry = getRegistry();
  const items = registry.tools.map((tool) => {
    const resolution = probeToolRuntime(tool.tool_id, requestedMode, platform);
    return {
      tool: resolution.tool,
      state: resolution.state,
      requested_mode: resolution.requested_mode,
      lifecycle_stage: resolveLifecycleStage(resolution),
      selected_action: resolution.selected_action,
      selected_backend: resolution.selected_backend,
      trial_backend: resolution.trial_backend,
      install_backend: resolution.install_backend,
      installed_backend: resolution.installed_backend,
      installed: resolution.installed,
      requires_install: resolution.requires_install,
      managed_env_path: resolution.managed_env_path,
      state_path: resolution.state_path,
      available_commands: resolution.available_commands,
      reason: resolution.reason,
    };
  });
  return {
    version: registry.version,
    platform,
    requested_mode: requestedMode,
    default_tool_id: registry.default_tool_id,
    items,
  };
}

export function getToolRuntimeInventoryItem(
  toolId?: string,
  requestedMode: ToolRuntimeMode = 'trial',
  platform: NodeJS.Platform = process.platform
): ToolRuntimeInventoryItem {
  const resolution = probeToolRuntime(toolId, requestedMode, platform);
  return {
    tool: resolution.tool,
    state: resolution.state,
    requested_mode: resolution.requested_mode,
    lifecycle_stage: resolveLifecycleStage(resolution),
    selected_action: resolution.selected_action,
    selected_backend: resolution.selected_backend,
    trial_backend: resolution.trial_backend,
    install_backend: resolution.install_backend,
    installed_backend: resolution.installed_backend,
    installed: resolution.installed,
    requires_install: resolution.requires_install,
    managed_env_path: resolution.managed_env_path,
    state_path: resolution.state_path,
    available_commands: resolution.available_commands,
    reason: resolution.reason,
  };
}
