import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LocalMusicGenMlxGenerationProvider,
  LocalStableAudioGenerationProvider,
  generateMusic,
} from './music-generation-bridge.js';
import {
  clampMusicGenDurationSec,
  clampStableAudioDurationSec,
  resolveLocalMusicGenMlxGenerationPolicy,
  resolveLocalStableAudioGenerationPolicy,
} from './music-generation-policy.js';
import { buildMusicPromptFromAdf } from './music-workflow-compiler.js';

const mocks = vi.hoisted(() => ({
  safeExecResult: vi.fn(),
  safeExistsSync: vi.fn(),
  safeMkdir: vi.fn(),
  probeToolRuntime: vi.fn(),
  assertSafeRepositoryPath: vi.fn((value: string) => value),
}));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    safeExecResult: mocks.safeExecResult,
    safeExistsSync: mocks.safeExistsSync,
    safeMkdir: mocks.safeMkdir,
    assertSafeRepositoryPath: mocks.assertSafeRepositoryPath,
  };
});

vi.mock('./tool-runtime-registry.js', () => ({
  probeToolRuntime: mocks.probeToolRuntime,
}));

describe('music-generation-policy', () => {
  it('applies MusicGen defaults and clamps duration', () => {
    const policy = resolveLocalMusicGenMlxGenerationPolicy({} as NodeJS.ProcessEnv);
    expect(policy).toEqual(
      expect.objectContaining({
        packageSpec: 'mlx-audiocraft',
        model: 'facebook/musicgen-small',
        durationSec: 10,
        maxDurationSec: 30,
      })
    );
    expect(clampMusicGenDurationSec(90, policy)).toBe(30);
    expect(clampMusicGenDurationSec(5, policy)).toBe(5);
  });

  it('honors environment overrides', () => {
    const policy = resolveLocalMusicGenMlxGenerationPolicy({
      KYBERION_MUSICGEN_PACKAGE: 'mlx-audiocraft==0.1.0',
      KYBERION_MUSICGEN_MODEL: 'facebook/musicgen-medium',
      KYBERION_MUSICGEN_DURATION_SEC: '20',
      KYBERION_MUSICGEN_MAX_DURATION_SEC: '25',
      KYBERION_MUSICGEN_TIMEOUT_MS: '120000',
      KYBERION_MUSICGEN_SEED: '42',
    } as NodeJS.ProcessEnv);
    expect(policy).toEqual({
      packageSpec: 'mlx-audiocraft==0.1.0',
      model: 'facebook/musicgen-medium',
      durationSec: 20,
      maxDurationSec: 25,
      timeoutMs: 120000,
      seed: '42',
    });
  });

  it('applies Stable Audio 3 small-music defaults and clamps duration', () => {
    const policy = resolveLocalStableAudioGenerationPolicy({} as NodeJS.ProcessEnv);
    expect(policy).toEqual(
      expect.objectContaining({
        packageSpec: 'git+https://github.com/Stability-AI/stable-audio-3.git',
        model: 'small-music',
        durationSec: 30,
        maxDurationSec: 120,
        steps: 8,
      })
    );
    expect(clampStableAudioDurationSec(200, policy)).toBe(120);
    expect(clampStableAudioDurationSec(15, policy)).toBe(15);
  });
});

describe('buildMusicPromptFromAdf', () => {
  it('builds an instrumental prompt without compiling Comfy nodes', () => {
    const brief = buildMusicPromptFromAdf({
      kind: 'music-generation-adf',
      version: '1.0.0',
      intent: 'anniversary theme',
      style: { genre: 'country', mood: ['warm'] },
      composition: { duration_sec: 18 },
      lyrics: { mode: 'instrumental' },
      output: { format: 'wav', target_path: 'active/shared/tmp/local-music.wav' },
    });
    expect(brief.prompt).toContain('country');
    expect(brief.prompt).toContain('no vocals');
    expect(brief.durationSec).toBe(18);
    expect(brief.targetPath).toBe('active/shared/tmp/local-music.wav');
  });
});

describe('LocalMusicGenMlxGenerationProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExistsSync.mockImplementation((candidate: string) =>
      String(candidate).includes('active/shared/')
    );
    mocks.safeExecResult.mockImplementation((_command: string, args: string[]) => {
      const outputIndex = args.indexOf('-o');
      if (outputIndex >= 0) {
        mocks.safeExistsSync.mockImplementation(
          (candidate: string) =>
            String(candidate) === args[outputIndex + 1] ||
            String(candidate).includes('active/shared/')
        );
      }
      return { stdout: '', stderr: '', status: 0 };
    });
    mocks.probeToolRuntime.mockReturnValue({
      selected_action: 'run_trial',
      selected_backend: {
        kind: 'uvx',
        command: 'uvx',
        args: ['--from', 'mlx-audiocraft', 'musicgen-mlx'],
      },
      trial_backend: {
        kind: 'uvx',
        command: 'uvx',
        args: ['--from', 'mlx-audiocraft', 'musicgen-mlx'],
      },
      install_backend: null,
      installed_backend: null,
      installed: false,
      requires_install: false,
      managed_env_path: '/tmp/tool-runtime/musicgen-mlx',
      state_path: '/tmp/tool-runtime/musicgen-mlx/state.json',
      available_commands: ['uvx'],
      reason: 'mocked tool runtime',
    });
  });

  it('invokes musicgen-mlx via uvx and writes the requested target path', async () => {
    const provider = new LocalMusicGenMlxGenerationProvider();
    const result = await provider.generate({
      prompt: 'calm piano, soft pads, no vocals',
      durationSec: 12,
      targetPath: 'active/shared/tmp/local-musicgen.wav',
    });

    expect(result.status).toBe('succeeded');
    expect(result.provider).toBe('musicgen_mlx');
    expect(result.path).toBe('active/shared/tmp/local-musicgen.wav');
    expect(mocks.safeExecResult).toHaveBeenCalledWith(
      'uvx',
      expect.arrayContaining([
        '--from',
        'mlx-audiocraft',
        'musicgen-mlx',
        'calm piano, soft pads, no vocals',
        '-m',
        'facebook/musicgen-small',
        '-d',
        '12',
        '-o',
        'active/shared/tmp/local-musicgen.wav',
      ]),
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
  });

  it('fails closed when the tool runtime requires install', async () => {
    mocks.probeToolRuntime.mockReturnValue({
      selected_action: 'install',
      selected_backend: null,
      trial_backend: null,
      install_backend: { kind: 'uv', command: 'uv', args: ['tool', 'install', 'mlx-audiocraft'] },
      installed_backend: null,
      installed: false,
      requires_install: true,
      managed_env_path: '/tmp/tool-runtime/musicgen-mlx',
      state_path: '/tmp/tool-runtime/musicgen-mlx/state.json',
      available_commands: [],
      reason: 'install required',
    });
    const result = await generateMusic({
      prompt: 'ambient pad',
      targetPath: 'active/shared/tmp/missing-install.wav',
      providerPreference: ['musicgen_mlx'],
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('musicgen_mlx_install_required');
  });
});

describe('LocalStableAudioGenerationProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExistsSync.mockImplementation((candidate: string) =>
      String(candidate).includes('active/shared/')
    );
    mocks.safeExecResult.mockImplementation((_command: string, args: string[]) => {
      const outputIndex = args.indexOf('-o');
      if (outputIndex >= 0) {
        mocks.safeExistsSync.mockImplementation(
          (candidate: string) =>
            String(candidate) === args[outputIndex + 1] ||
            String(candidate).includes('active/shared/')
        );
      }
      return { stdout: '', stderr: '', status: 0 };
    });
    mocks.probeToolRuntime.mockReturnValue({
      selected_action: 'run_trial',
      selected_backend: {
        kind: 'uvx',
        command: 'uvx',
        args: ['--from', 'git+https://github.com/Stability-AI/stable-audio-3.git', 'stable-audio'],
      },
      trial_backend: {
        kind: 'uvx',
        command: 'uvx',
        args: ['--from', 'git+https://github.com/Stability-AI/stable-audio-3.git', 'stable-audio'],
      },
      install_backend: null,
      installed_backend: null,
      installed: false,
      requires_install: false,
      managed_env_path: '/tmp/tool-runtime/stable-audio-3',
      state_path: '/tmp/tool-runtime/stable-audio-3/state.json',
      available_commands: ['uvx'],
      reason: 'mocked tool runtime',
    });
  });

  it('invokes stable-audio via uvx with small-music defaults', async () => {
    const provider = new LocalStableAudioGenerationProvider();
    const result = await provider.generate({
      prompt: 'lo-fi hip hop beat, 90 BPM',
      durationSec: 30,
      targetPath: 'active/shared/tmp/stable-audio-demo.wav',
    });

    expect(result.status).toBe('succeeded');
    expect(result.provider).toBe('stable_audio_3');
    expect(result.path).toBe('active/shared/tmp/stable-audio-demo.wav');
    expect(mocks.safeExecResult).toHaveBeenCalledWith(
      'uvx',
      expect.arrayContaining([
        '--from',
        'git+https://github.com/Stability-AI/stable-audio-3.git',
        'stable-audio',
        '--model',
        'small-music',
        '-p',
        'lo-fi hip hop beat, 90 BPM',
        '--duration',
        '30',
        '-o',
        'active/shared/tmp/stable-audio-demo.wav',
        '--steps',
        '8',
      ]),
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
  });
});
