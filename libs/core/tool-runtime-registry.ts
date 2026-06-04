import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExecResult, safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { safeJsonParse } from './validators.js';
import {
  getToolRuntimePolicy,
  resolveToolRuntimeRoot,
  type ToolRuntimeEcosystem,
  type ToolRuntimeMode,
  type ToolRuntimeModePreference,
} from './tool-runtime-policy.js';

export type ToolRuntimeStatus = 'active' | 'shadow' | 'disabled';
export type ToolRuntimePlatform = 'any' | 'darwin' | 'linux' | 'win32';
export type ToolRuntimeBackendKind = 'uvx' | 'uv' | 'pipx' | 'npx' | 'npm' | 'pnpm' | 'brew' | 'system';
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

export type ToolRuntimeLifecycleStage = 'trial' | 'approved_install' | 'installed' | 'pinned' | 'install_required' | 'unsupported';

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

const DEFAULT_REGISTRY_PATH = pathResolver.knowledge('product/governance/tool-runtime-registry.json');
const STATE_VERSION = '1.0.0';

const FALLBACK_REGISTRY: ToolRuntimeRegistry = {
  version: 'fallback',
  default_tool_id: 'mflux',
  tools: [
    {
      tool_id: 'mflux',
      display_name: 'mflux Local FLUX Image Generator',
      ecosystem: 'python',
      status: 'active',
      platforms: ['darwin'],
      supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
      trial_backend: {
        kind: 'uvx',
        command: 'uvx',
        args: ['--from', 'mflux', 'mflux-generate'],
        description: 'Temporary local FLUX execution without a managed install.',
      },
      install_backend: {
        kind: 'uv',
        command: 'uv',
        args: ['tool', 'install', 'mflux'],
        description: 'Install mflux into the managed Python tool environment.',
      },
      installed_backend: {
        kind: 'uv',
        command: 'uv',
        args: ['tool', 'run', 'mflux-generate'],
        description: 'Run mflux from the managed Python tool environment.',
      },
      managed_env_subpath: 'tool-runtimes/mflux',
      notes: 'Apple Silicon FLUX entrypoint. Trial via uvx; promote to installed state after approval.',
    },
    {
      tool_id: 'playwright',
      display_name: 'Playwright Chromium Runtime',
      ecosystem: 'node',
      status: 'active',
      platforms: ['any'],
      supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
      trial_backend: {
        kind: 'npx',
        command: 'npx',
        args: ['playwright', '--version'],
        description: 'Probe Playwright availability without mutating workspace state.',
      },
      install_backend: {
        kind: 'pnpm',
        command: 'pnpm',
        args: ['exec', 'playwright', 'install', 'chromium'],
        description: 'Install the Chromium browser binary used by Playwright flows.',
      },
      installed_backend: {
        kind: 'pnpm',
        command: 'pnpm',
        args: ['exec', 'playwright', '--version'],
        description: 'Re-check the Playwright runtime after browser bootstrap.',
      },
      managed_env_subpath: 'tool-runtimes/playwright',
      notes: 'Node runtime example: trial via npx, managed browser bootstrap via pnpm exec playwright install chromium.',
    },
    {
      tool_id: 'ffmpeg',
      display_name: 'FFmpeg Media Toolkit',
      ecosystem: 'system',
      status: 'active',
      platforms: ['any'],
      supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
      trial_backend: {
        kind: 'system',
        command: 'ffmpeg',
        args: ['-version'],
        description: 'Probe FFmpeg availability without any install step.',
      },
      install_backend: {
        kind: 'brew',
        command: 'brew',
        args: ['install', 'ffmpeg'],
        description: 'Install FFmpeg through Homebrew on macOS.',
      },
      installed_backend: {
        kind: 'system',
        command: 'ffmpeg',
        args: ['-version'],
        description: 'Re-check the installed FFmpeg binary.',
      },
      managed_env_subpath: 'tool-runtimes/ffmpeg',
      notes: 'System media example for capture and composition flows.',
    },
    {
      tool_id: 'sox',
      display_name: 'SoX Audio Toolkit',
      ecosystem: 'system',
      status: 'active',
      platforms: ['any'],
      supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
      trial_backend: {
        kind: 'system',
        command: 'sox',
        args: ['--version'],
        description: 'Probe SoX availability without mutating workspace state.',
      },
      install_backend: {
        kind: 'brew',
        command: 'brew',
        args: ['install', 'sox'],
        description: 'Install SoX through Homebrew on macOS.',
      },
      installed_backend: {
        kind: 'system',
        command: 'sox',
        args: ['--version'],
        description: 'Re-check the installed SoX binary.',
      },
      managed_env_subpath: 'tool-runtimes/sox',
      notes: 'Audio capture fallback used by the voice sample recorder.',
    },
    {
      tool_id: 'tesseract',
      display_name: 'Tesseract OCR Toolkit',
      ecosystem: 'system',
      status: 'active',
      platforms: ['any'],
      supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
      trial_backend: {
        kind: 'system',
        command: 'tesseract',
        args: ['--version'],
        description: 'Probe Tesseract availability without mutating workspace state.',
      },
      install_backend: {
        kind: 'brew',
        command: 'brew',
        args: ['install', 'tesseract'],
        description: 'Install Tesseract through Homebrew on macOS.',
      },
      installed_backend: {
        kind: 'system',
        command: 'tesseract',
        args: ['--version'],
        description: 'Re-check the installed Tesseract binary.',
      },
      managed_env_subpath: 'tool-runtimes/tesseract',
      notes: 'OCR fallback example for image and screen recognition flows.',
    },
    {
      tool_id: 'mlx_audio',
      display_name: 'mlx-audio TTS Runtime',
      ecosystem: 'python',
      status: 'active',
      platforms: ['darwin'],
      supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
      trial_backend: {
        kind: 'system',
        command: 'python3',
        args: ['-c', 'import mlx_audio; print("ok")'],
        description: 'Probe mlx-audio availability through an import check.',
      },
      install_backend: {
        kind: 'uv',
        command: 'uv',
        args: ['pip', 'install', 'mlx-audio'],
        description: 'Install mlx-audio into the managed Python runtime.',
      },
      installed_backend: {
        kind: 'system',
        command: 'python3',
        args: ['-c', 'import mlx_audio; print("ok")'],
        description: 'Re-check the installed mlx-audio runtime.',
      },
      managed_env_subpath: 'tool-runtimes/mlx-audio',
      notes: 'Runtime dependency for the Qwen3-TTS voice engine bridge.',
    },
    {
      tool_id: 'mlx_whisper',
      display_name: 'mlx-whisper STT Runtime',
      ecosystem: 'python',
      status: 'active',
      platforms: ['darwin'],
      supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
      trial_backend: {
        kind: 'system',
        command: 'python3',
        args: ['-c', 'import mlx_whisper; print("ok")'],
        description: 'Probe mlx-whisper availability through an import check.',
      },
      install_backend: {
        kind: 'uv',
        command: 'uv',
        args: ['pip', 'install', 'mlx-whisper'],
        description: 'Install mlx-whisper into the managed Python runtime.',
      },
      installed_backend: {
        kind: 'system',
        command: 'python3',
        args: ['-c', 'import mlx_whisper; print("ok")'],
        description: 'Re-check the installed mlx-whisper runtime.',
      },
      managed_env_subpath: 'tool-runtimes/mlx-whisper',
      notes: 'Runtime dependency for the Qwen3-STT bridge used by voice capture flows.',
    },
  ],
};

let cachedRegistryPath: string | null = null;
let cachedRegistry: ToolRuntimeRegistry | null = null;

function getRegistryPath(): string {
  return process.env.KYBERION_TOOL_RUNTIME_REGISTRY_PATH?.trim() || DEFAULT_REGISTRY_PATH;
}

function loadRegistryFromPath(registryPath: string): ToolRuntimeRegistry {
  const raw = safeReadFile(registryPath, { encoding: 'utf8' }) as string;
  return safeJsonParse<ToolRuntimeRegistry>(raw, 'tool runtime registry');
}

function isSupportedPlatform(record: ToolRuntimeRecord, platform: NodeJS.Platform): boolean {
  return record.platforms.includes('any') || record.platforms.includes(platform as ToolRuntimePlatform);
}

function backendIsAvailable(backend: ToolRuntimeBackendCommand | null | undefined): boolean {
  if (!backend) return false;
  const result = safeExecResult('which', [backend.command], {
    timeoutMs: 5_000,
    maxOutputMB: 1,
  });
  return result.status === 0 && Boolean(result.stdout.trim());
}

function resolveManagedEnvPath(tool: ToolRuntimeRecord): string {
  const subPath = tool.managed_env_subpath || `tool-runtimes/${tool.tool_id}`;
  return path.join(resolveToolRuntimeRoot(getToolRuntimePolicy()), subPath);
}

function normalizeToolId(toolId?: string): string {
  const trimmed = toolId?.trim();
  return trimmed || '';
}

function getRegistry(): ToolRuntimeRegistry {
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
    logger.warn(`[TOOL_RUNTIME_REGISTRY] Failed to load registry at ${registryPath}: ${error.message}`);
    cachedRegistryPath = registryPath;
    cachedRegistry = FALLBACK_REGISTRY;
    return cachedRegistry;
  }
}

function statePathForTool(tool: ToolRuntimeRecord): string {
  const root = resolveToolRuntimeRoot(getToolRuntimePolicy());
  const subPath = tool.managed_env_subpath || `tool-runtimes/${tool.tool_id}`;
  return path.join(root, subPath, 'state.json');
}

export function resetToolRuntimeRegistryCache(): void {
  cachedRegistryPath = null;
  cachedRegistry = null;
}

export function getToolRuntimeRegistry(): ToolRuntimeRegistry {
  return getRegistry();
}

export function listToolRuntimes(): ToolRuntimeRecord[] {
  return getRegistry().tools;
}

export function getToolRuntimeRecord(toolId?: string): ToolRuntimeRecord {
  const registry = getRegistry();
  const resolvedToolId = normalizeToolId(toolId) || registry.default_tool_id;
  return (
    registry.tools.find((tool) => tool.tool_id === resolvedToolId)
    || registry.tools.find((tool) => tool.tool_id === registry.default_tool_id)
    || FALLBACK_REGISTRY.tools[0]
  );
}

export function getToolRuntimeStatePath(toolId?: string): string {
  return statePathForTool(getToolRuntimeRecord(toolId));
}

export function readToolRuntimeState(toolId?: string): ToolRuntimeState | null {
  const statePath = getToolRuntimeStatePath(toolId);
  if (!safeExistsSync(statePath)) return null;
  try {
    const parsed = safeJsonParse<ToolRuntimeState>(safeReadFile(statePath, { encoding: 'utf8' }) as string, 'tool runtime state');
    return parsed;
  } catch (error: any) {
    logger.warn(`[TOOL_RUNTIME_REGISTRY] Failed to read state at ${statePath}: ${error.message}`);
    return null;
  }
}

function writeToolRuntimeStateFile(state: ToolRuntimeState): void {
  const statePath = getToolRuntimeStatePath(state.tool_id);
  const dir = path.dirname(statePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(statePath, JSON.stringify(state, null, 2), { encoding: 'utf8' });
}

export function markToolRuntimeInstalled(
  toolId: string,
  provenance?: ToolRuntimeState['provenance'],
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
    installed_at: new Date().toISOString(),
    provenance: provenance || undefined,
  };
  writeToolRuntimeStateFile(state);
  return state;
}

export function markToolRuntimePinned(
  toolId: string,
  provenance?: ToolRuntimeState['provenance'],
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
    pinned_at: new Date().toISOString(),
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
  if (!resolution.selected_backend && !resolution.installed && resolution.requires_install) return 'install_required';
  if (resolution.selected_action === 'run_trial') return 'trial';
  if (resolution.selected_action === 'install') return 'approved_install';
  return resolution.installed ? 'installed' : 'trial';
}

function resolveRequestedMode(
  requestedMode: ToolRuntimeMode,
  record: ToolRuntimeRecord,
  state: ToolRuntimeState | null,
): ToolRuntimeAction {
  const installedState = currentModeFromState(state) === 'installed' || currentModeFromState(state) === 'pinned';

  if (requestedMode === 'approved_install') return 'install';
  if (installedState && record.installed_backend) return 'run_installed';
  if (requestedMode === 'installed' || requestedMode === 'pinned') {
    return record.installed_backend ? 'run_installed' : (record.trial_backend ? 'run_trial' : 'install');
  }
  if (requestedMode === 'trial') return record.trial_backend ? 'run_trial' : 'install';
  return record.trial_backend ? 'run_trial' : 'install';
}

export function probeToolRuntime(
  toolId?: string,
  requestedMode: ToolRuntimeMode = 'trial',
  platform: NodeJS.Platform = process.platform,
): ToolRuntimeResolution {
  const record = getToolRuntimeRecord(toolId);
  const state = readToolRuntimeState(record.tool_id);
  if (!isSupportedPlatform(record, platform)) {
    return {
      tool: record,
      state,
      requested_mode: requestedMode,
      selected_action: 'install',
      selected_backend: record.install_backend || null,
      trial_backend: record.trial_backend,
      install_backend: record.install_backend || null,
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
  if (selectedAction === 'run_installed') selectedBackend = record.installed_backend || record.trial_backend;
  if (selectedAction === 'run_trial') selectedBackend = record.trial_backend;
  if (selectedAction === 'install') selectedBackend = record.install_backend || null;

  const availableCommands = [
    record.trial_backend,
    record.install_backend,
    record.installed_backend,
  ]
    .filter((backend): backend is ToolRuntimeBackendCommand => Boolean(backend))
    .filter((backend) => backendIsAvailable(backend))
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
    install_backend: record.install_backend || null,
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

export function resolveToolRuntimeAction(toolId?: string, requestedMode: ToolRuntimeMode = 'trial'): ToolRuntimeAction {
  return probeToolRuntime(toolId, requestedMode).selected_action;
}

export function resolveToolRuntimeCommand(toolId?: string, requestedMode: ToolRuntimeMode = 'trial'): ToolRuntimeBackendCommand | null {
  return probeToolRuntime(toolId, requestedMode).selected_backend;
}

export function listToolRuntimeInventory(
  requestedMode: ToolRuntimeMode = 'trial',
  platform: NodeJS.Platform = process.platform,
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
  platform: NodeJS.Platform = process.platform,
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
