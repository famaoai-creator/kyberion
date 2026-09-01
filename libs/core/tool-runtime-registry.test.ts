import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import {
  clearToolRuntimeState,
  getToolRuntimeRecord,
  getToolRuntimeInventoryItem,
  getToolRuntimeRegistry,
  getToolRuntimeStatePath,
  markToolRuntimeInstalled,
  listToolRuntimeInventory,
  probeToolRuntime,
  resolveManagedToolPythonBin,
  _resetToolRuntimeRegistryCacheForTests,
} from './tool-runtime-registry.js';
import { _resetToolRuntimePolicyCacheForTests } from './tool-runtime-policy.js';

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    safeExecResult: vi.fn((command: string, args: string[] = []) => {
      if (
        ['which', 'where.exe'].includes(command) &&
        [
          'uvx',
          'uv',
          'npx',
          'pnpm',
          'brew',
          'winget',
          'ffmpeg',
          'sox',
          'tesseract',
          'python3',
        ].includes(args[0] || '')
      ) {
        return { status: 0, stdout: `/mock/${args[0]}\n`, stderr: '', error: null };
      }
      if (
        [
          'uvx',
          'uv',
          'npx',
          'pnpm',
          'brew',
          'winget',
          'ffmpeg',
          'sox',
          'tesseract',
          'python3',
        ].includes(command)
      ) {
        return { status: 0, stdout: `/mock/${command}`, stderr: '', error: null };
      }
      return { status: 1, stdout: '', stderr: '', error: new Error('not found') };
    }),
  };
});

describe('tool runtime registry', () => {
  const tmpRoot = pathResolver.sharedTmp('tool-runtime-tests');
  const policyPath = path.join(tmpRoot, 'tool-runtime-policy.json');
  const registryPath = path.join(tmpRoot, 'tool-runtime-registry.json');
  const managedRoot = path.join(tmpRoot, 'managed');
  const cacheRoot = path.join(tmpRoot, 'cache');

  beforeEach(() => {
    safeMkdir(tmpRoot, { recursive: true });
    safeMkdir(managedRoot, { recursive: true });
    safeMkdir(cacheRoot, { recursive: true });
    safeWriteFile(
      policyPath,
      JSON.stringify(
        {
          version: '1.0.0',
          managed_roots: {
            tool_runtime_root: managedRoot,
            cache_root: cacheRoot,
          },
          mode_preference: {
            python: 'trial_first',
            node: 'installed_first',
            system: 'installed_first',
          },
          approval: {
            install_requires_approval: true,
            pin_requires_approval: true,
          },
        },
        null,
        2
      ),
      { encoding: 'utf8' }
    );
    safeWriteFile(
      registryPath,
      JSON.stringify(
        {
          version: '1.0.0',
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
              },
              install_backend: {
                kind: 'uv',
                command: 'uv',
                args: ['tool', 'install', 'mflux'],
              },
              installed_backend: {
                kind: 'uv',
                command: 'uv',
                args: ['tool', 'run', 'mflux-generate'],
              },
              managed_env_subpath: path.join('tool-runtimes', 'mflux'),
              notes: 'test fixture',
            },
            {
              tool_id: 'agy_sdk',
              display_name: 'Antigravity Python SDK Runtime',
              ecosystem: 'python',
              status: 'active',
              platforms: ['any'],
              supported_modes: ['trial', 'approved_install', 'installed', 'pinned'],
              trial_backend: {
                kind: 'uvx',
                command: 'uvx',
                args: ['--from', 'google-antigravity', 'python', '-c', 'import google.antigravity'],
              },
              install_backend: {
                kind: 'uv',
                command: 'uv',
                args: ['pip', 'install', 'google-antigravity'],
              },
              install_backend_platform_overrides: {
                any: {
                  kind: 'system',
                  command: 'any-installer',
                  args: [],
                },
              },
              installed_backend: {
                kind: 'system',
                command: 'python3',
                args: ['-c', 'import google.antigravity; print("ok")'],
              },
              managed_env_subpath: 'tool-runtimes/agy-sdk',
              notes: 'test fixture',
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
              },
              install_backend: {
                kind: 'pnpm',
                command: 'pnpm',
                args: ['exec', 'playwright', 'install', 'chromium'],
              },
              installed_backend: {
                kind: 'pnpm',
                command: 'pnpm',
                args: ['exec', 'playwright', '--version'],
              },
              managed_env_subpath: 'tool-runtimes/playwright',
              notes: 'test fixture',
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
              },
              install_backend: {
                kind: 'brew',
                command: 'brew',
                args: ['install', 'ffmpeg'],
              },
              install_backend_platform_overrides: {
                win32: {
                  kind: 'winget',
                  command: 'winget',
                  args: ['install', '--id', 'Gyan.FFmpeg', '--exact'],
                },
              },
              installed_backend: {
                kind: 'system',
                command: 'ffmpeg',
                args: ['-version'],
              },
              managed_env_subpath: path.join('tool-runtimes', 'ffmpeg'),
              notes: 'test fixture',
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
              },
              install_backend: {
                kind: 'brew',
                command: 'brew',
                args: ['install', 'sox'],
              },
              installed_backend: {
                kind: 'system',
                command: 'sox',
                args: ['--version'],
              },
              managed_env_subpath: 'tool-runtimes/sox',
              notes: 'test fixture',
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
              },
              install_backend: {
                kind: 'brew',
                command: 'brew',
                args: ['install', 'tesseract'],
              },
              installed_backend: {
                kind: 'system',
                command: 'tesseract',
                args: ['--version'],
              },
              managed_env_subpath: 'tool-runtimes/tesseract',
              notes: 'test fixture',
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
              },
              install_backend: {
                kind: 'uv',
                command: 'uv',
                args: ['pip', 'install', 'mlx-audio'],
              },
              installed_backend: {
                kind: 'system',
                command: 'python3',
                args: ['-c', 'import mlx_audio; print("ok")'],
              },
              managed_env_subpath: path.join('tool-runtimes', 'mlx-audio'),
              notes: 'test fixture',
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
              },
              install_backend: {
                kind: 'uv',
                command: 'uv',
                args: ['pip', 'install', 'mlx-whisper'],
              },
              installed_backend: {
                kind: 'system',
                command: 'python3',
                args: ['-c', 'import mlx_whisper; print("ok")'],
              },
              managed_env_subpath: path.join('tool-runtimes', 'mlx-whisper'),
              notes: 'test fixture',
            },
          ],
        },
        null,
        2
      ),
      { encoding: 'utf8' }
    );
    vi.stubEnv('KYBERION_TOOL_RUNTIME_POLICY_PATH', policyPath);
    vi.stubEnv('KYBERION_TOOL_RUNTIME_REGISTRY_PATH', registryPath);
    _resetToolRuntimePolicyCacheForTests();
    _resetToolRuntimeRegistryCacheForTests();
    clearToolRuntimeState('mflux');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetToolRuntimePolicyCacheForTests();
    _resetToolRuntimeRegistryCacheForTests();
  });

  it('loads the governed registry and defaults to mflux', () => {
    const registry = getToolRuntimeRegistry();
    expect(registry.default_tool_id).toBe('mflux');
    expect(getToolRuntimeRecord().tool_id).toBe('mflux');
    expect(getToolRuntimeRecord('mflux').trial_backend.command).toBe('uvx');
    expect(getToolRuntimeRecord('playwright').trial_backend.command).toBe('npx');
    expect(getToolRuntimeRecord('ffmpeg').install_backend?.command).toBe('brew');
    expect(getToolRuntimeRecord('mlx_audio').install_backend?.command).toBe('uv');
    expect(getToolRuntimeRecord('agy_sdk').install_backend?.args).toEqual([
      'pip',
      'install',
      'google-antigravity',
    ]);
  });

  it('prefers trial execution when no install state exists', () => {
    const resolution = probeToolRuntime('mflux', 'trial', 'darwin');
    expect(resolution.selected_action).toBe('run_trial');
    expect(resolution.selected_backend?.command).toBe('uvx');
    expect(resolution.requires_install).toBe(false);
    expect(resolution.managed_env_path).toContain(path.join('tool-runtimes', 'mflux'));
  });

  it('supports node and system runtime records', () => {
    const playwright = probeToolRuntime('playwright', 'trial', 'darwin');
    expect(playwright.selected_action).toBe('run_trial');
    expect(playwright.selected_backend?.kind).toBe('npx');
    expect(playwright.install_backend?.kind).toBe('pnpm');

    const ffmpeg = probeToolRuntime('ffmpeg', 'approved_install', 'darwin');
    expect(ffmpeg.selected_action).toBe('install');
    expect(ffmpeg.selected_backend?.kind).toBe('brew');
    expect(ffmpeg.managed_env_path).toContain(path.join('tool-runtimes', 'ffmpeg'));

    const ffmpegWindows = probeToolRuntime('ffmpeg', 'approved_install', 'win32');
    expect(ffmpegWindows.selected_action).toBe('install');
    expect(ffmpegWindows.selected_backend?.kind).toBe('winget');
    expect(ffmpegWindows.selected_backend?.args).toEqual([
      'install',
      '--id',
      'Gyan.FFmpeg',
      '--exact',
    ]);
    const agyLinux = probeToolRuntime('agy_sdk', 'approved_install', 'linux');
    expect(agyLinux.selected_backend?.command).toBe('any-installer');
  });

  it('keeps WinGet fallbacks available when the governed registry is missing', () => {
    vi.stubEnv('KYBERION_TOOL_RUNTIME_REGISTRY_PATH', path.join(tmpRoot, 'missing-registry.json'));
    _resetToolRuntimeRegistryCacheForTests();

    const ollama = probeToolRuntime('ollama', 'approved_install', 'win32');
    expect(ollama.selected_backend?.command).toBe('winget');
    expect(ollama.selected_backend?.args).toContain('Ollama.Ollama');

    const llamaCpp = probeToolRuntime('llamacpp', 'approved_install', 'win32');
    expect(llamaCpp.selected_backend?.command).toBe('winget');
    expect(llamaCpp.selected_backend?.args).toContain('ggml.llamacpp');
  });

  it('uses the fallback when the governed registry fails schema validation', () => {
    safeWriteFile(registryPath, JSON.stringify({ version: 'invalid' }), { encoding: 'utf8' });
    _resetToolRuntimeRegistryCacheForTests();

    expect(getToolRuntimeRegistry().default_tool_id).toBe('mflux');
    expect(getToolRuntimeRecord('llamacpp').installed_backend?.command).toBe('llama-server');
  });

  it('uses the fallback when the registry override is outside the repository', () => {
    vi.stubEnv('KYBERION_TOOL_RUNTIME_REGISTRY_PATH', '/tmp/tool-runtime-registry-external.json');
    _resetToolRuntimeRegistryCacheForTests();

    expect(getToolRuntimeRegistry().version).toBe('fallback');
  });

  it('lists inventory items with lifecycle stages', () => {
    const inventory = listToolRuntimeInventory('trial', 'darwin');
    expect(inventory.default_tool_id).toBe('mflux');
    expect(inventory.items).toHaveLength(8);
    expect(inventory.items.map((item) => item.tool.tool_id)).toEqual([
      'mflux',
      'agy_sdk',
      'playwright',
      'ffmpeg',
      'sox',
      'tesseract',
      'mlx_audio',
      'mlx_whisper',
    ]);
    expect(
      inventory.items.find((item) => item.tool.tool_id === 'playwright')?.lifecycle_stage
    ).toBe('trial');
    expect(inventory.items.find((item) => item.tool.tool_id === 'ffmpeg')?.selected_action).toBe(
      'run_trial'
    );
    expect(
      inventory.items.find((item) => item.tool.tool_id === 'mlx_audio')?.selected_backend?.command
    ).toBe('python3');

    const installed = getToolRuntimeInventoryItem('mflux', 'installed', 'darwin');
    expect(installed.tool.tool_id).toBe('mflux');
    expect(installed.lifecycle_stage).toBe('trial');
    markToolRuntimeInstalled('mflux');
    const installedAfterState = getToolRuntimeInventoryItem('mflux', 'installed', 'darwin');
    expect(installedAfterState.lifecycle_stage).toBe('installed');
  });

  it('selects installed execution after install state is recorded', () => {
    markToolRuntimeInstalled('mflux');
    const resolution = probeToolRuntime('mflux', 'installed', 'darwin');
    expect(resolution.installed).toBe(true);
    expect(resolution.selected_action).toBe('run_installed');
    expect(resolution.selected_backend?.command).toBe('uv');
    expect(resolution.state?.status).toBe('installed');
  });

  it('exposes an install plan when explicitly requested', () => {
    const resolution = probeToolRuntime('mflux', 'approved_install', 'darwin');
    expect(resolution.selected_action).toBe('install');
    expect(resolution.requires_install).toBe(true);
    expect(resolution.install_backend?.command).toBe('uv');
  });

  it('probes system tooling on installed mode', () => {
    const resolution = probeToolRuntime('sox', 'installed', 'darwin');
    expect(resolution.selected_action).toBe('run_installed');
    expect(resolution.selected_backend?.command).toBe('sox');
    expect(resolution.tool.tool_id).toBe('sox');
  });

  it('probes mlx-audio and mlx-whisper as managed python runtimes', () => {
    const tts = probeToolRuntime('mlx_audio', 'trial', 'darwin');
    expect(tts.selected_action).toBe('run_trial');
    expect(tts.selected_backend?.command).toBe('python3');
    expect(tts.managed_env_path).toContain(path.join('tool-runtimes', 'mlx-audio'));

    const stt = probeToolRuntime('mlx_whisper', 'approved_install', 'darwin');
    expect(stt.selected_action).toBe('install');
    expect(stt.selected_backend?.command).toBe('uv');
    expect(stt.managed_env_path).toContain(path.join('tool-runtimes', 'mlx-whisper'));
  });

  it('resolves the managed python binary when present on disk', () => {
    const runtimeRoot = path.join(
      managedRoot,
      'tool-runtimes',
      'mlx-audio',
      process.platform === 'win32' ? 'Scripts' : 'bin'
    );
    safeMkdir(runtimeRoot, { recursive: true });
    const pythonName = process.platform === 'win32' ? 'python.exe' : 'python';
    safeWriteFile(path.join(runtimeRoot, pythonName), '', { encoding: 'utf8' });

    expect(resolveManagedToolPythonBin('mlx_audio')).toBe(path.join(runtimeRoot, pythonName));
  });

  it('rejects a registry managed environment path that escapes the repository', () => {
    const registry = JSON.parse(String(safeReadFile(registryPath, { encoding: 'utf8' }))) as {
      tools: Array<{ tool_id: string; managed_env_subpath?: string }>;
    };
    registry.tools[0].managed_env_subpath = 'tool-runtimes/../../outside-managed-root';
    safeWriteFile(registryPath, JSON.stringify(registry), { encoding: 'utf8' });
    _resetToolRuntimeRegistryCacheForTests();

    expect(() => getToolRuntimeStatePath('mflux')).toThrow(/RESOURCE_PATH|repository|outside/i);
  });
});
