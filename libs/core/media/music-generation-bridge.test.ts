import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChatMusicianGenerationProvider,
  LocalMusicGenMlxGenerationProvider,
  LocalStableAudioGenerationProvider,
  MlAudioGenGenerationProvider,
  extractAbcNotation,
  generateMusic,
  listMusicGenerationCandidates,
} from './music-generation-bridge.js';
import { pathResolver } from '../path-resolver.js';
import {
  clampMlAudioGenDurationSec,
  clampMusicGenDurationSec,
  clampStableAudioDurationSec,
  resolveChatMusicianGenerationPolicy,
  resolveLocalMusicGenMlxGenerationPolicy,
  resolveLocalStableAudioGenerationPolicy,
  resolveMlAudioGenGenerationPolicy,
  resolveMlAudioGenVariant,
} from './music-generation-policy.js';
import { buildMusicPromptFromAdf } from './music-workflow-compiler.js';

const mocks = vi.hoisted(() => ({
  safeExecResult: vi.fn(),
  safeExistsSync: vi.fn(),
  safeMkdir: vi.fn(),
  safeWriteFile: vi.fn(),
  probeToolRuntime: vi.fn(),
  assertSafeRepositoryPath: vi.fn((value: string) => value),
}));

vi.mock('../secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('../secure-io.js')>('../secure-io.js');
  return {
    ...actual,
    safeExecResult: mocks.safeExecResult,
    safeExistsSync: mocks.safeExistsSync,
    safeMkdir: mocks.safeMkdir,
    safeWriteFile: mocks.safeWriteFile,
    assertSafeRepositoryPath: mocks.assertSafeRepositoryPath,
  };
});

vi.mock('../tool/tool-runtime-registry.js', () => ({
  probeToolRuntime: mocks.probeToolRuntime,
}));

const selectionMocks = vi.hoisted(() => ({
  isAppleSilicon: vi.fn<() => boolean>(),
  record: vi.fn(),
  pinSeamProviderDecision: vi.fn(),
}));

vi.mock('../platform.js', async () => {
  const actual = await vi.importActual<typeof import('../platform.js')>('../platform.js');
  selectionMocks.isAppleSilicon.mockImplementation(actual.isAppleSilicon);
  return { ...actual, isAppleSilicon: selectionMocks.isAppleSilicon };
});

vi.mock('../governance/audit-chain.js', () => ({
  auditChain: { record: selectionMocks.record },
}));

vi.mock('../provider/provider-pins-store.js', () => ({
  loadSeamProviderPin: () => null,
  pinSeamProviderDecision: selectionMocks.pinSeamProviderDecision,
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
      expect.anything()
    );
    const execOpts = mocks.safeExecResult.mock.calls.at(-1)?.[2] as { timeoutMs?: unknown };
    expect(typeof execOpts?.timeoutMs).toBe('number');
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
      expect.anything()
    );
    const execOpts = mocks.safeExecResult.mock.calls.at(-1)?.[2] as { timeoutMs?: unknown };
    expect(typeof execOpts?.timeoutMs).toBe('number');
  });
});

describe('MlAudioGenGenerationProvider', () => {
  const cacheDirFor = (variant: string): string =>
    path.join(process.env.HOME || '', '.mlx-audiogen', 'models', variant);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExistsSync.mockImplementation(
      (candidate: string) =>
        String(candidate).includes('active/shared/') || String(candidate).includes('.mlx-audiogen')
    );
    mocks.safeExecResult.mockImplementation((_command: string, args: string[]) => {
      const outputIndex = args.indexOf('--output');
      if (outputIndex >= 0) {
        mocks.safeExistsSync.mockImplementation(
          (candidate: string) =>
            String(candidate) === args[outputIndex + 1] ||
            String(candidate).includes('active/shared/') ||
            String(candidate).includes('.mlx-audiogen')
        );
      }
      return { stdout: '', stderr: '', status: 0 };
    });
    mocks.probeToolRuntime.mockReturnValue({
      selected_action: 'run_trial',
      selected_backend: {
        kind: 'uvx',
        command: 'uvx',
        args: ['--from', 'mlx-audiogen', 'mlx-audiogen'],
      },
      trial_backend: {
        kind: 'uvx',
        command: 'uvx',
        args: ['--from', 'mlx-audiogen', 'mlx-audiogen'],
      },
      install_backend: null,
      installed_backend: null,
      installed: false,
      requires_install: false,
      managed_env_path: '/tmp/tool-runtime/musicgen-audiogen',
      state_path: '/tmp/tool-runtime/musicgen-audiogen/state.json',
      available_commands: ['uvx'],
      reason: 'mocked tool runtime',
    });
  });

  it('invokes mlx-audiogen via uvx with musicgen text-to-music flags', async () => {
    const provider = new MlAudioGenGenerationProvider();
    const result = await provider.generate({
      prompt: 'upbeat synthwave, 110 BPM, no vocals',
      durationSec: 12,
      targetPath: 'active/shared/tmp/audiogen-demo.wav',
    });

    expect(result.status).toBe('succeeded');
    expect(result.provider).toBe('musicgen_audiogen');
    expect(result.path).toBe('active/shared/tmp/audiogen-demo.wav');
    expect(mocks.safeExecResult).toHaveBeenCalledWith(
      'uvx',
      expect.arrayContaining([
        '--from',
        'mlx-audiogen',
        'mlx-audiogen',
        '--model',
        'musicgen',
        '--prompt',
        'upbeat synthwave, 110 BPM, no vocals',
        '--seconds',
        '12',
        '--output',
        'active/shared/tmp/audiogen-demo.wav',
        '--weights-dir',
        cacheDirFor('musicgen-small'),
      ]),
      expect.anything()
    );
  });

  it('maps request models to provisioned variant weights', async () => {
    const provider = new MlAudioGenGenerationProvider();
    const result = await provider.generate({
      prompt: 'orchestral swell',
      model: 'facebook/musicgen-medium',
      targetPath: 'active/shared/tmp/audiogen-medium.wav',
    });
    expect(result.status).toBe('succeeded');
    expect(mocks.safeExecResult).toHaveBeenCalledWith(
      'uvx',
      expect.arrayContaining(['--weights-dir', cacheDirFor('musicgen-medium')]),
      expect.anything()
    );
    expect(resolveMlAudioGenVariant('facebook/musicgen-stereo-large')).toBe(
      'musicgen-stereo-large'
    );
    expect(resolveMlAudioGenVariant('unknown-model')).toBe('musicgen-small');
  });

  it('auto-downloads pre-converted weights once when the cache is empty', async () => {
    mocks.safeExistsSync.mockImplementation((candidate: string) =>
      String(candidate).includes('active/shared/')
    );
    mocks.safeExecResult.mockImplementation((command: string, args: string[]) => {
      if (args.includes('hf') || args.includes('huggingface-cli')) {
        mocks.safeExistsSync.mockImplementation(() => true);
        return { stdout: 'downloaded', stderr: '', status: 0 };
      }
      return { stdout: '', stderr: '', status: 0 };
    });
    const result = await new MlAudioGenGenerationProvider().generate({
      prompt: 'first-run pad',
      targetPath: 'active/shared/tmp/audiogen-first-run.wav',
    });
    expect(result.status).toBe('succeeded');
    expect(mocks.safeExecResult).toHaveBeenCalledWith(
      'uvx',
      expect.arrayContaining([
        '--from',
        'huggingface_hub',
        'hf',
        'download',
        'jasonvassallo/mlx-musicgen-small',
      ]),
      expect.anything()
    );
  });

  it('fails with setup guidance when weights download fails', async () => {
    mocks.safeExistsSync.mockImplementation((candidate: string) =>
      String(candidate).includes('active/shared/')
    );
    mocks.safeExecResult.mockImplementation(() => ({
      stdout: '',
      stderr: 'network unreachable',
      status: 1,
    }));
    const result = await new MlAudioGenGenerationProvider().generate({
      prompt: 'offline pad',
      targetPath: 'active/shared/tmp/audiogen-offline.wav',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('network unreachable');
  });

  it('forwards the configured weights dir for stereo/melody variants', async () => {
    vi.stubEnv('KYBERION_MUSAUDIOGEN_WEIGHTS_DIR', '/models/musicgen-stereo-medium');
    try {
      const provider = new MlAudioGenGenerationProvider();
      const result = await provider.generate({
        prompt: 'wide stereo pad',
        targetPath: 'active/shared/tmp/audiogen-stereo.wav',
      });
      expect(result.status).toBe('succeeded');
      expect(mocks.safeExecResult).toHaveBeenCalledWith(
        'uvx',
        expect.arrayContaining(['--weights-dir', '/models/musicgen-stereo-medium']),
        expect.anything()
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails closed when the tool runtime requires install', async () => {
    mocks.probeToolRuntime.mockReturnValue({ selected_action: 'install' });
    const result = await generateMusic({
      prompt: 'ambient pad',
      targetPath: 'active/shared/tmp/audiogen-install.wav',
      providerPreference: ['musicgen_audiogen'],
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('musicgen_audiogen_install_required');
  });

  it('fails on empty prompts and missing outputs', async () => {
    const empty = await new MlAudioGenGenerationProvider().generate({
      prompt: '   ',
      targetPath: 'active/shared/tmp/audiogen-empty.wav',
    });
    expect(empty.status).toBe('failed');
    expect(empty.error).toBe('musicgen_audiogen_prompt_required');

    mocks.safeExistsSync.mockImplementation(
      (candidate: string) =>
        String(candidate).includes('.mlx-audiogen') &&
        !String(candidate).endsWith('audiogen-gone.wav')
    );
    // Plain exec mock: the describe default re-arms file existence on --output.
    mocks.safeExecResult.mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const missing = await new MlAudioGenGenerationProvider().generate({
      prompt: 'audible pad',
      targetPath: 'active/shared/tmp/audiogen-gone.wav',
    });
    expect(missing.status).toBe('failed');
    expect(missing.error).toBe('musicgen_audiogen_output_missing');
  });

  it('applies mlx-audiogen defaults and clamps duration', () => {
    const policy = resolveMlAudioGenGenerationPolicy({} as NodeJS.ProcessEnv);
    expect(policy).toEqual(
      expect.objectContaining({
        packageSpec: 'mlx-audiogen',
        model: 'facebook/musicgen-small',
        durationSec: 10,
        maxDurationSec: 30,
        topK: 250,
        guidance: 3,
      })
    );
    expect(clampMlAudioGenDurationSec(90, policy)).toBe(30);
  });
});

describe('ChatMusicianGenerationProvider', () => {
  const ABC_STDOUT = [
    'Here is your score:',
    'X:1',
    'T:Trial Jig',
    'M:6/8',
    'L:1/8',
    'R:jig',
    'K:G',
    'GAB c2B|d2B dBA|',
  ].join('\n');

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExistsSync.mockImplementation((candidate: string) =>
      String(candidate).includes('active/shared/')
    );
    mocks.safeExecResult.mockImplementation((command: string, args: string[]) => {
      if (command === 'which') {
        return {
          stdout: '/opt/homebrew/bin/abc2midi\n/opt/homebrew/bin/fluidsynth\n',
          stderr: '',
          status: 0,
        };
      }
      if (command === 'uvx') {
        return { stdout: ABC_STDOUT, stderr: '', status: 0 };
      }
      return { stdout: '', stderr: '', status: 0 };
    });
    mocks.probeToolRuntime.mockReturnValue({
      selected_action: 'run_trial',
      selected_backend: {
        kind: 'uvx',
        command: 'uvx',
        args: ['--from', 'mlx-lm', 'mlx_lm.generate'],
      },
      trial_backend: {
        kind: 'uvx',
        command: 'uvx',
        args: ['--from', 'mlx-lm', 'mlx_lm.generate'],
      },
      install_backend: null,
      installed_backend: null,
      installed: false,
      requires_install: false,
      managed_env_path: '/tmp/tool-runtime/chatmusician-mlx',
      state_path: '/tmp/tool-runtime/chatmusician-mlx/state.json',
      available_commands: ['uvx'],
      reason: 'mocked tool runtime',
    });
    vi.stubEnv('KYBERION_CHATMUSICIAN_SOUNDFONT', 'active/shared/soundfont.sf2');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('extracts ABC blocks from prose-wrapped LLM output', () => {
    expect(extractAbcNotation(ABC_STDOUT)).toContain('X:1');
    expect(extractAbcNotation(ABC_STDOUT)).toContain('K:G');
    expect(extractAbcNotation('no score here')).toBeNull();
    expect(extractAbcNotation('X:1\njust a header')).toBeNull();
  });

  it('composes ABC, converts to MIDI, and renders WAV', async () => {
    const provider = new ChatMusicianGenerationProvider();
    const result = await provider.generate({
      prompt: 'a cheerful jig in G major',
      targetPath: 'active/shared/tmp/chatmusician-demo.wav',
    });

    expect(result.status).toBe('succeeded');
    expect(result.provider).toBe('chatmusician_mlx');
    expect(result.path).toBe('active/shared/tmp/chatmusician-demo.wav');
    expect(mocks.safeExecResult).toHaveBeenCalledWith(
      'uvx',
      expect.arrayContaining(['mlx_lm.generate', '--model', 'm-a-p/ChatMusician']),
      expect.anything()
    );
    expect(mocks.safeWriteFile).toHaveBeenCalledWith(
      'active/shared/tmp/chatmusician-demo.abc',
      expect.stringContaining('X:1')
    );
    expect(mocks.safeExecResult).toHaveBeenCalledWith(
      'abc2midi',
      ['active/shared/tmp/chatmusician-demo.abc', '-o', 'active/shared/tmp/chatmusician-demo.midi'],
      expect.anything()
    );
    expect(mocks.safeExecResult).toHaveBeenCalledWith(
      'fluidsynth',
      [
        '-ni',
        '-F',
        'active/shared/tmp/chatmusician-demo.wav',
        '-r',
        '44100',
        'active/shared/soundfont.sf2',
        'active/shared/tmp/chatmusician-demo.midi',
      ],
      expect.anything()
    );
  });

  it('fails with abc_parse_failed when the LLM returns no score', async () => {
    mocks.safeExecResult.mockImplementation((command: string) => {
      if (command === 'which') {
        return { stdout: '/opt/homebrew/bin/abc2midi\n', stderr: '', status: 0 };
      }
      return { stdout: 'sorry, no music today', stderr: '', status: 0 };
    });
    const result = await new ChatMusicianGenerationProvider().generate({
      prompt: 'x',
      targetPath: 'active/shared/tmp/chatmusician-noabc.wav',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('chatmusician_abc_parse_failed');
  });

  it('fails closed when abc2midi is missing', async () => {
    mocks.safeExecResult.mockImplementation((command: string) => {
      if (command === 'which') return { stdout: '', stderr: '', status: 1 };
      return { stdout: ABC_STDOUT, stderr: '', status: 0 };
    });
    const result = await new ChatMusicianGenerationProvider().generate({
      prompt: 'x',
      targetPath: 'active/shared/tmp/chatmusician-noabc2midi.wav',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('chatmusician_abc2midi_install_required');
  });

  it('fails closed when fluidsynth is missing', async () => {
    mocks.safeExecResult.mockImplementation((command: string, args: string[]) => {
      if (command === 'which') {
        const found =
          String(args[args.length - 1]) === 'abc2midi' ? '/opt/homebrew/bin/abc2midi\n' : '';
        return { stdout: found, stderr: '', status: found ? 0 : 1 };
      }
      return { stdout: ABC_STDOUT, stderr: '', status: 0 };
    });
    const result = await new ChatMusicianGenerationProvider().generate({
      prompt: 'x',
      targetPath: 'active/shared/tmp/chatmusician-nofluid.wav',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('chatmusician_fluidsynth_install_required');
  });

  it('fails when no MIDI comes out of abc2midi', async () => {
    mocks.safeExistsSync.mockImplementation(
      (candidate: string) =>
        String(candidate).includes('active/shared/') &&
        !String(candidate).endsWith('.midi') &&
        !String(candidate).endsWith('.mid')
    );
    const result = await new ChatMusicianGenerationProvider().generate({
      prompt: 'x',
      targetPath: 'active/shared/tmp/chatmusician-nomidi.wav',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('chatmusician_midi_missing');
  });

  it('fails on render errors and empty prompts', async () => {
    mocks.safeExecResult.mockImplementation((command: string) => {
      if (command === 'fluidsynth') {
        return { stdout: '', stderr: 'no instruments', status: 1 };
      }
      if (command === 'which') {
        return {
          stdout: '/opt/homebrew/bin/abc2midi\n/opt/homebrew/bin/fluidsynth\n',
          stderr: '',
          status: 0,
        };
      }
      return { stdout: ABC_STDOUT, stderr: '', status: 0 };
    });
    const renderFailed = await new ChatMusicianGenerationProvider().generate({
      prompt: 'x',
      targetPath: 'active/shared/tmp/chatmusician-badrender.wav',
    });
    expect(renderFailed.status).toBe('failed');
    expect(renderFailed.error).toBe('no instruments');

    const empty = await new ChatMusicianGenerationProvider().generate({
      prompt: '',
      targetPath: 'active/shared/tmp/chatmusician-empty.wav',
    });
    expect(empty.status).toBe('failed');
    expect(empty.error).toBe('chatmusician_prompt_required');
  });

  it('fails closed when no SoundFont is configured', async () => {
    vi.stubEnv('KYBERION_CHATMUSICIAN_SOUNDFONT', '');
    const result = await new ChatMusicianGenerationProvider().generate({
      prompt: 'x',
      targetPath: 'active/shared/tmp/chatmusician-nosf.wav',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('chatmusician_soundfont_missing');
  });

  it('applies ChatMusician defaults', () => {
    const policy = resolveChatMusicianGenerationPolicy({} as NodeJS.ProcessEnv);
    expect(policy).toEqual(
      expect.objectContaining({
        packageSpec: 'mlx-lm',
        hfRepo: 'm-a-p/ChatMusician',
        maxTokens: 1024,
        temperature: 0.7,
      })
    );
  });
});

describe('generateMusic provider selection', () => {
  const runnable = {
    selected_action: 'run_trial',
    selected_backend: { kind: 'uvx', command: 'uvx', args: [] },
    trial_backend: { kind: 'uvx', command: 'uvx', args: [] },
  };
  const succeeded = (provider: string) => ({
    status: 'succeeded' as const,
    provider,
    path: `active/shared/tmp/${provider}.wav`,
    elapsedMs: 1,
  });
  const rulesDir = path.join(
    pathResolver.sharedTmp('music-generation-rules-test'),
    String(process.pid)
  );
  const rulesFile = path.join(rulesDir, 'rules.json');
  let musicgen: ReturnType<typeof vi.spyOn>;
  let stableAudio: ReturnType<typeof vi.spyOn>;
  let audiogen: ReturnType<typeof vi.spyOn>;
  let chatmusician: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('MISSION_ID', '');
    vi.stubEnv('KYBERION_SEAM_SELECTION_RULES_PATH', rulesFile);
    const actual = await vi.importActual<typeof import('../secure-io.js')>('../secure-io.js');
    // The governed policy and the rules overlay are read from disk.
    mocks.safeExistsSync.mockImplementation(actual.safeExistsSync);
    mocks.probeToolRuntime.mockReturnValue(runnable);
    selectionMocks.isAppleSilicon.mockReturnValue(true);
    musicgen = vi
      .spyOn(LocalMusicGenMlxGenerationProvider.prototype, 'generate')
      .mockResolvedValue(succeeded('musicgen_mlx'));
    stableAudio = vi
      .spyOn(LocalStableAudioGenerationProvider.prototype, 'generate')
      .mockResolvedValue(succeeded('stable_audio_3'));
    audiogen = vi
      .spyOn(MlAudioGenGenerationProvider.prototype, 'generate')
      .mockResolvedValue(succeeded('musicgen_audiogen'));
    chatmusician = vi
      .spyOn(ChatMusicianGenerationProvider.prototype, 'generate')
      .mockResolvedValue(succeeded('chatmusician_mlx'));
  });
  afterEach(async () => {
    musicgen.mockRestore();
    stableAudio.mockRestore();
    audiogen.mockRestore();
    chatmusician.mockRestore();
    vi.unstubAllEnvs();
    const actual = await vi.importActual<typeof import('../secure-io.js')>('../secure-io.js');
    actual.safeRmSync(rulesDir, { recursive: true, force: true });
  });

  it('ranks eligible providers by purpose and records the decision', async () => {
    const result = await generateMusic({ prompt: 'calm piano', purpose: 'quality' });
    expect(result.provider).toBe('stable_audio_3');
    expect(musicgen).not.toHaveBeenCalled();
    expect(selectionMocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'provider_selection' })
    );
    const decision = selectionMocks.record.mock.calls.at(-1)?.[0]?.metadata;
    expect(decision).toEqual(
      expect.objectContaining({ strategy: 'purpose', purpose: 'quality', decision_key: 'quality' })
    );
  });

  it('treats declared duration and format limits as hard requirements', async () => {
    const candidates = await listMusicGenerationCandidates({ durationSec: 60, format: 'mp3' });
    expect(candidates).toEqual([
      { id: 'chatmusician_mlx', eligible: false, unmet: ['format mp3 (writes wav)'] },
      {
        id: 'musicgen_audiogen',
        eligible: false,
        unmet: ['format mp3 (writes wav)', 'duration 60s exceeds max 30s'],
      },
      {
        id: 'musicgen_mlx',
        eligible: false,
        unmet: ['format mp3 (writes wav)', 'duration 60s exceeds max 30s'],
      },
      { id: 'stable_audio_3', eligible: false, unmet: ['format mp3 (writes wav)'] },
    ]);
    const tooLong = await generateMusic({ prompt: 'x', purpose: 'speed', durationSec: 500 });
    expect(tooLong.status).toBe('failed');
    expect(tooLong.error).toMatch(/no provider can run this task.*duration 500s exceeds max 120s/);
    expect(stableAudio).not.toHaveBeenCalled();
  });

  it('skips unavailable providers without a purpose instead of running them', async () => {
    mocks.probeToolRuntime.mockImplementation((toolId: string) =>
      toolId === 'musicgen_mlx' || toolId === 'musicgen_audiogen'
        ? { selected_action: 'install' }
        : runnable
    );
    const result = await generateMusic({ prompt: 'x' });
    expect(result.provider).toBe('stable_audio_3');
    expect(musicgen).not.toHaveBeenCalled();
    expect(audiogen).not.toHaveBeenCalled();
    expect(selectionMocks.record).not.toHaveBeenCalled();

    mocks.probeToolRuntime.mockReturnValue({ selected_action: 'install' });
    const none = await generateMusic({ prompt: 'x' });
    expect(none.status).toBe('failed');
    expect(none.error).toMatch(
      /chatmusician_mlx: unavailable; musicgen_audiogen: unavailable; musicgen_mlx: unavailable; stable_audio_3: unavailable/
    );
  });

  it('keeps the platform order without a purpose', async () => {
    expect((await generateMusic({ prompt: 'x' })).provider).toBe('musicgen_mlx');
    selectionMocks.isAppleSilicon.mockReturnValue(false);
    expect((await generateMusic({ prompt: 'x' })).provider).toBe('stable_audio_3');
  });

  it('lets a matching operator rule lead the platform order without a purpose', async () => {
    const actual = await vi.importActual<typeof import('../secure-io.js')>('../secure-io.js');
    actual.safeMkdir(rulesDir, { recursive: true });
    actual.safeWriteFile(
      rulesFile,
      JSON.stringify({
        version: '1.0.0',
        rules: [
          {
            rule_id: 'prefer-stable',
            seam: 'music-generation-provider',
            when: {},
            prefer: ['stable_audio_3'],
            set_by: 'test',
            set_at: '2026-09-22T00:00:00.000Z',
          },
        ],
      })
    );
    const result = await generateMusic({ prompt: 'x' });
    expect(result.provider).toBe('stable_audio_3');
    expect(selectionMocks.record.mock.calls.at(-1)?.[0]?.metadata).toEqual(
      expect.objectContaining({
        strategy: 'rule',
        rule_id: 'prefer-stable',
        decision_key: 'default',
      })
    );
  });

  it('lets a named provider win over the purpose', async () => {
    const result = await generateMusic({
      prompt: 'x',
      purpose: 'quality',
      providerPreference: ['musicgen_mlx'],
    });
    expect(result.provider).toBe('musicgen_mlx');
    expect(selectionMocks.record).not.toHaveBeenCalled();
  });

  it('throws on an unknown purpose naming the known ones', async () => {
    await expect(generateMusic({ prompt: 'x', purpose: 'vibes' })).rejects.toThrow(
      /unknown purpose 'vibes'.*known: compose, quality, speed/
    );
  });

  it('fails closed when vocals are requested with an explicit instrumental provider', async () => {
    const result = await generateMusic({
      prompt: 'a lullaby',
      vocals: true,
      lyrics: 'hush now',
      providerPreference: ['musicgen_mlx'],
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('instrumental-only');
    expect(musicgen).not.toHaveBeenCalled();
  });

  it('excludes instrumental-only providers from vocal requests with an actionable error', async () => {
    const candidates = await listMusicGenerationCandidates({ vocals: true });
    expect(candidates.every((candidate) => !candidate.eligible)).toBe(true);
    expect(candidates[0]?.unmet).toContain('vocals requested (instrumental-only provider)');
    const result = await generateMusic({ prompt: 'x', vocals: true, lyrics: 'la la' });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/No vocal-capable provider/);
    expect(musicgen).not.toHaveBeenCalled();
    expect(audiogen).not.toHaveBeenCalled();
    expect(stableAudio).not.toHaveBeenCalled();
    expect(chatmusician).not.toHaveBeenCalled();
  });
});
