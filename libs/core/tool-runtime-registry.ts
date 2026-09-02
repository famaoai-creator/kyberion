import * as path from 'node:path';
import { logger } from './core.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { readJson } from './foundation/json.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExecResult,
  safeExistsSync,
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
      notes:
        'Apple Silicon FLUX entrypoint. Trial via uvx; promote to installed state after approval.',
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
      notes:
        'Node runtime example: trial via npx, managed browser bootstrap through the Playwright runtime installer.',
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
      install_backend_platform_overrides: {
        win32: {
          kind: 'winget',
          command: 'winget',
          args: [
            'install',
            '--id',
            'Gyan.FFmpeg',
            '--exact',
            '--source',
            'winget',
            '--accept-source-agreements',
            '--accept-package-agreements',
          ],
          description: 'Install ffmpeg through WinGet on Windows.',
        },
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
      install_backend_platform_overrides: {
        win32: {
          kind: 'winget',
          command: 'winget',
          args: [
            'install',
            '--id',
            'ChrisBagwell.SoX',
            '--exact',
            '--source',
            'winget',
            '--accept-source-agreements',
            '--accept-package-agreements',
          ],
          description: 'Install sox through WinGet on Windows.',
        },
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
      install_backend_platform_overrides: {
        win32: {
          kind: 'winget',
          command: 'winget',
          args: [
            'install',
            '--id',
            'tesseract-ocr.tesseract',
            '--exact',
            '--source',
            'winget',
            '--accept-source-agreements',
            '--accept-package-agreements',
          ],
          description: 'Install tesseract through WinGet on Windows.',
        },
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
        args: ['pip', 'install', 'mlx-audio[tts]'],
        description: 'Install the current mlx-audio TTS extras into the managed Python runtime.',
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
    {
      tool_id: 'kokoro_tts',
      display_name: 'Kokoro TTS Runtime',
      ecosystem: 'python',
      status: 'active',
      platforms: ['any'],
      supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
      trial_backend: {
        kind: 'system',
        command: 'python3',
        args: ['-c', 'import kokoro, soundfile; print("ok")'],
        description: 'Probe the Kokoro and soundfile Python packages.',
      },
      install_backend: {
        kind: 'uv',
        command: 'uv',
        args: ['pip', 'install', 'kokoro', 'soundfile', 'misaki[ja]', 'unidic-lite'],
        description: 'Install Kokoro with audio output and Japanese text dependencies.',
      },
      installed_backend: {
        kind: 'system',
        command: 'python3',
        args: ['-c', 'import kokoro, soundfile, unidic_lite; print("ok")'],
        description: 'Re-check the Kokoro TTS runtime.',
      },
      managed_env_subpath: 'tool-runtimes/kokoro-tts',
      notes: 'Optional lightweight TTS runtime used by the governed Kokoro bridge.',
    },
    {
      tool_id: 'pocket_tts',
      display_name: 'Kyutai Pocket TTS Runtime',
      ecosystem: 'python',
      status: 'active',
      platforms: ['any'],
      supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
      trial_backend: {
        kind: 'system',
        command: 'python3',
        args: ['-c', 'import pocket_tts, scipy; print("ok")'],
        description: 'Probe Pocket TTS and scipy availability.',
      },
      install_backend: {
        kind: 'uv',
        command: 'uv',
        args: ['pip', 'install', 'pocket-tts', 'scipy'],
        description: 'Install Kyutai Pocket TTS and WAV output dependencies.',
      },
      installed_backend: {
        kind: 'system',
        command: 'python3',
        args: ['-c', 'import pocket_tts, scipy; print("ok")'],
        description: 'Re-check the Pocket TTS runtime.',
      },
      managed_env_subpath: 'tool-runtimes/pocket-tts',
      notes:
        'CPU streaming TTS and consent-gated voice cloning; upstream language packs currently exclude Japanese.',
    },
    {
      tool_id: 'ten_vad',
      display_name: 'TEN VAD Runtime',
      ecosystem: 'python',
      status: 'active',
      platforms: ['darwin', 'linux', 'win32'],
      supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
      trial_backend: {
        kind: 'system',
        command: 'python3',
        args: ['-c', 'import ten_vad; print("ok")'],
        description: 'Probe the TEN VAD Python binding.',
      },
      install_backend: {
        kind: 'uv',
        command: 'uv',
        args: ['pip', 'install', 'numpy', 'git+https://github.com/TEN-framework/ten-vad.git'],
        description:
          'Install the official TEN VAD Python binding and its NumPy dependency from upstream.',
      },
      installed_backend: {
        kind: 'system',
        command: 'python3',
        args: ['-c', 'import ten_vad; print("ok")'],
        description: 'Re-check the TEN VAD runtime.',
      },
      managed_env_subpath: 'tool-runtimes/ten-vad',
      notes:
        'Optional 10/16ms-hop VAD. Review the upstream Apache-2.0 additional conditions before redistribution.',
    },
    {
      tool_id: 'silero_vad',
      display_name: 'Silero VAD Runtime',
      ecosystem: 'python',
      status: 'active',
      platforms: ['any'],
      supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
      trial_backend: {
        kind: 'system',
        command: 'python3',
        args: ['-c', 'import numpy, onnxruntime; print("ok")'],
        description: 'Probe the lightweight Silero ONNX bridge dependencies.',
      },
      install_backend: {
        kind: 'uv',
        command: 'uv',
        args: ['pip', 'install', 'numpy', 'onnxruntime'],
        description: 'Install the ONNX runtime used by the Silero VAD v6 bridge.',
      },
      installed_backend: {
        kind: 'system',
        command: 'python3',
        args: ['-c', 'import numpy, onnxruntime; print("ok")'],
        description: 'Re-check the Silero VAD dependencies.',
      },
      managed_env_subpath: 'tool-runtimes/silero-vad',
      notes:
        'The bridge accepts the current Silero VAD v6.2-compatible ONNX model through KYBERION_SILERO_VAD_MODEL.',
    },
    {
      tool_id: 'ollama',
      display_name: 'Ollama Local LLM Runtime',
      ecosystem: 'system',
      status: 'active',
      platforms: ['any'],
      supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
      trial_backend: {
        kind: 'system',
        command: 'ollama',
        args: ['--version'],
        description: 'Probe Ollama CLI availability without mutating workspace state.',
      },
      install_backend: {
        kind: 'brew',
        command: 'brew',
        args: ['install', 'ollama'],
        description: 'Install Ollama via Homebrew on macOS.',
      },
      install_backend_platform_overrides: {
        win32: {
          kind: 'winget',
          command: 'winget',
          args: [
            'install',
            '--id',
            'Ollama.Ollama',
            '--exact',
            '--source',
            'winget',
            '--accept-source-agreements',
            '--accept-package-agreements',
          ],
          description: 'Install Ollama through WinGet on Windows.',
        },
      },
      installed_backend: {
        kind: 'system',
        command: 'ollama',
        args: ['serve'],
        description: 'Run Ollama server process.',
      },
      managed_env_subpath: 'tool-runtimes/ollama',
      notes: 'Ollama local LLM server runtime.',
    },
    {
      tool_id: 'llamacpp',
      display_name: 'llama.cpp C++ LLM Engine',
      ecosystem: 'system',
      status: 'active',
      platforms: ['any'],
      supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
      trial_backend: {
        kind: 'system',
        command: 'llama-server',
        args: ['--version'],
        description: 'Probe llama-server CLI availability.',
      },
      install_backend: {
        kind: 'brew',
        command: 'brew',
        args: ['install', 'llama.cpp'],
        description: 'Install llama.cpp binaries via Homebrew.',
      },
      install_backend_platform_overrides: {
        win32: {
          kind: 'winget',
          command: 'winget',
          args: [
            'install',
            '--id',
            'ggml.llamacpp',
            '--exact',
            '--source',
            'winget',
            '--accept-source-agreements',
            '--accept-package-agreements',
          ],
          description: 'Install llama.cpp through WinGet on Windows.',
        },
      },
      installed_backend: {
        kind: 'system',
        command: 'llama-server',
        args: ['--port', '8080'],
        description: 'Run llama-server process.',
      },
      managed_env_subpath: 'tool-runtimes/llamacpp',
      notes: 'llama.cpp server runtime for GGUF model inference.',
    },
  ],
};

function getRegistryPath(): string {
  const configured =
    getRegisteredEnvText('KYBERION_TOOL_RUNTIME_REGISTRY_PATH')?.trim() || DEFAULT_REGISTRY_PATH;
  return assertSafeRepositoryPath(configured, { allowMissingLeaf: true });
}

const toolRuntimeRegistryCatalog = defineCatalog<ToolRuntimeRegistry>({
  id: 'tool-runtime-registry',
  path: getRegistryPath,
  schema: REGISTRY_SCHEMA_PATH,
  fallback: FALLBACK_REGISTRY,
  fallbackOnInvalid: true,
  onFallback(error) {
    try {
      const registryPath = getRegistryPath();
      if (safeExistsSync(registryPath)) {
        logger.warn(
          `[TOOL_RUNTIME_REGISTRY] Failed to load registry at ${registryPath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    } catch (pathError) {
      logger.warn(
        `[TOOL_RUNTIME_REGISTRY] Unsafe registry path; using fallback: ${
          pathError instanceof Error ? pathError.message : String(pathError)
        }`
      );
    }
  },
});

function readJsonWithLabel<T>(filePath: string, label: string): T {
  try {
    return readJson<T>(filePath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid ${label}: ${error.message}`);
    }
    throw error;
  }
}

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
  try {
    return toolRuntimeRegistryCatalog.load();
  } catch (error) {
    logger.warn(
      `[TOOL_RUNTIME_REGISTRY] Failed to resolve registry; using fallback: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return FALLBACK_REGISTRY;
  }
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
    FALLBACK_REGISTRY.tools[0]
  );
}

export function getToolRuntimeStatePath(toolId?: string): string {
  return statePathForTool(getToolRuntimeRecord(toolId));
}

export function readToolRuntimeState(toolId?: string): ToolRuntimeState | null {
  const statePath = getToolRuntimeStatePath(toolId);
  if (!safeExistsSync(statePath)) return null;
  try {
    return readJsonWithLabel<ToolRuntimeState>(statePath, 'tool runtime state');
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
