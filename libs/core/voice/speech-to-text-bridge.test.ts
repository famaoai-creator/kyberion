import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as secureIo from '../secure-io.js';
import { discoverLocalSttBackends } from '../local-stt-discovery.js';
import * as path from 'node:path';

vi.mock('../local-stt-discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../local-stt-discovery.js')>()),
  discoverLocalSttBackends: vi.fn(() => []),
}));

vi.mock('../path-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../path-resolver.js')>('../path-resolver.js');
  return { ...actual, rootResolve: vi.fn() };
});

vi.mock('../tier-guard.js', () => ({
  validateWritePermission: () => ({ allowed: true }),
  validateReadPermission: () => ({ allowed: true }),
  detectTier: () => 'public',
}));

vi.mock('../governance/policy-engine.js', () => ({
  policyEngine: { evaluate: () => ({ allowed: true, action: 'allow' }) },
}));

import { pathResolver, rootResolve } from '../path-resolver.js';
import { safeReadFile, safeSymlinkSync, safeUnlinkSync } from '../secure-io.js';
import {
  getSpeechToTextBridge,
  getSpeechToTextBridges,
  getSpeechToTextCapabilities,
  registerSpeechToTextBridge,
  resetSpeechToTextBridge,
  normalizeSpeechToTextResult,
  parseSpeechToTextCapabilities,
  stubSpeechToTextBridge,
  ShellSpeechToTextBridge,
  buildWhisperKitTranscribeArgs,
  installAvailableSpeechToTextBridges,
  installManagedFasterWhisperSpeechToTextBridgeIfAvailable,
  installFluidAudioSpeechToTextBridgeIfAvailable,
  installShellSpeechToTextBridgeIfAvailable,
  type SpeechToTextBridge,
} from './speech-to-text-bridge.js';

describe('speech-to-text-bridge', () => {
  let tmpDir = '';
  const mockResolve = rootResolve as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = pathResolver.sharedTmp(`stt-${process.pid}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    mockResolve.mockImplementation((rel: string) =>
      path.isAbsolute(rel) ? rel : path.join(tmpDir, rel)
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.mocked(discoverLocalSttBackends).mockReturnValue([]);
    vi.clearAllMocks();
    resetSpeechToTextBridge();
  });

  it('transcribes Japanese with the managed faster-whisper bridge in UTF-8', async () => {
    const script = path.join(
      tmpDir,
      'libs/actuators/voice-actuator/scripts/faster_whisper_stt_bridge.py'
    );
    secureIo.safeMkdir(path.dirname(script), { recursive: true });
    secureIo.safeWriteFile(script, '# fixture');
    const audio = path.join(tmpDir, 'sample.wav');
    secureIo.safeWriteFile(audio, 'audio fixture');
    vi.mocked(discoverLocalSttBackends).mockReturnValue([
      {
        backend: 'faster_whisper',
        display_name: 'faster-whisper',
        source: 'managed-runtime',
        priority: 90,
        verification: 'python-module',
        python_bin: 'managed-python',
        detail: 'ready',
        connection: {},
      },
    ]);
    const exec = vi.spyOn(secureIo, 'safeExecResult').mockReturnValue({
      status: 0,
      stderr: '',
      stdout: JSON.stringify({
        status: 'success',
        text: 'こんにちは。',
        language: 'ja',
        segments: [{ start_sec: 0, end_sec: 1, text: 'こんにちは。' }],
      }),
    });
    expect(installManagedFasterWhisperSpeechToTextBridgeIfAvailable({})).toBe(true);
    const bridge = getSpeechToTextBridges().find(
      (candidate) => candidate.name === 'faster_whisper'
    )!;
    const result = await bridge.transcribe({
      audioPath: audio,
      language: 'ja',
      outputPath: path.join(tmpDir, 'transcript.txt'),
    });
    expect(result.text).toBe('こんにちは。');
    expect(result.segments).toEqual([{ start_sec: 0, end_sec: 1, text: 'こんにちは。' }]);
    expect(exec).toHaveBeenCalledWith(
      'managed-python',
      ['-X', 'utf8', script],
      expect.objectContaining({ input: expect.stringContaining('ja') })
    );
    expect(safeReadFile(path.join(tmpDir, 'transcript.txt'))).toBe('こんにちは。\n');
    exec.mockRestore();
    vi.mocked(discoverLocalSttBackends).mockReturnValue([]);
  });

  it.each([
    {
      label: 'local model directory and explicit device, compute type and language',
      env: {
        KYBERION_STT_MODEL_DIR: 'local-model-日本語',
        KYBERION_STT_MODEL: 'ignored-model',
        KYBERION_STT_DEVICE: 'cuda',
        KYBERION_STT_COMPUTE_TYPE: 'float32',
        KYBERION_STT_LANGUAGE: 'ja',
      },
      inputLanguage: undefined,
      expected: {
        model: 'local-model-日本語',
        device: 'cuda',
        compute_type: 'float32',
        language: 'ja',
      },
    },
    {
      label: 'model name, GPU compute default and per-request language precedence',
      env: {
        KYBERION_STT_MODEL: 'configured-model',
        KYBERION_STT_DEVICE: 'cuda',
        KYBERION_STT_LANGUAGE: 'ja',
      },
      inputLanguage: 'en',
      expected: {
        model: 'configured-model',
        device: 'cuda',
        compute_type: 'float16',
        language: 'en',
      },
    },
    {
      label: 'unconfigured bridge defaults',
      env: {},
      inputLanguage: undefined,
      expected: { model: 'small', device: 'cpu', compute_type: 'int8', language: null },
    },
  ])(
    'passes $label to the actual Python subprocess',
    async ({ env, inputLanguage, expected }, context) => {
      const python = ['python3', 'python'].find((command) => {
        const probe = secureIo.safeExecResult(command, ['--version']);
        return !probe.error && probe.status === 0 && probe.stdout.startsWith('Python 3.');
      });
      if (!python) return context.skip();
      const relative = 'libs/actuators/voice-actuator/scripts';
      const fixtureDir = path.join(tmpDir, relative);
      secureIo.safeMkdir(fixtureDir, { recursive: true });
      for (const name of ['faster_whisper_stt_bridge.py', 'json_boundary.py']) {
        secureIo.safeWriteFile(
          path.join(fixtureDir, name),
          safeReadFile(path.join(pathResolver.rootDir(), relative, name))
        );
      }
      // Run the production Python bridge without installing a model, using a
      // hermetic model module to expose the configuration it actually receives.
      secureIo.safeWriteFile(
        path.join(fixtureDir, 'faster_whisper.py'),
        [
          'import json, os',
          'from types import SimpleNamespace',
          'class WhisperModel:',
          '    def __init__(self, model, device, compute_type):',
          '        self.config = dict(model=model, device=device, compute_type=compute_type)',
          '    def transcribe(self, audio_path, language=None, vad_filter=True):',
          "        self.config.update(language=language, secret=os.environ.get('OPENAI_API_KEY'))",
          '        text = json.dumps(self.config, ensure_ascii=False)',
          '        return [SimpleNamespace(text=text, start=0, end=1)], SimpleNamespace(language=language or "auto")',
          '',
        ].join('\n')
      );
      const audio = path.join(tmpDir, 'configured.wav');
      secureIo.safeWriteFile(audio, 'audio fixture');
      vi.mocked(discoverLocalSttBackends).mockReturnValue([
        {
          backend: 'faster_whisper',
          display_name: 'fixture',
          priority: 90,
          verification: 'python-module',
          python_bin: python,
          source: 'managed-runtime',
          detail: 'hermetic subprocess fixture',
          connection: {},
        },
      ]);
      vi.stubEnv('OPENAI_API_KEY', 'must-not-reach-stt-child');
      try {
        expect(
          installManagedFasterWhisperSpeechToTextBridgeIfAvailable({
            ...env,
            OPENAI_API_KEY: 'must-not-be-forwarded-from-config',
          })
        ).toBe(true);
        const bridge = getSpeechToTextBridges().find(
          (candidate) => candidate.name === 'faster_whisper'
        )!;
        const result = await bridge.transcribe({ audioPath: audio, language: inputLanguage });
        expect(JSON.parse(result.text)).toEqual({ ...expected, secret: null });
        expect(safeReadFile(result.written_to!)).toBe(result.text + '\n');
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );

  it('does not install an unavailable managed faster-whisper runtime or override an explicit command', () => {
    vi.mocked(discoverLocalSttBackends).mockReturnValue([]);
    expect(installManagedFasterWhisperSpeechToTextBridgeIfAvailable({})).toBe(false);
    expect(getSpeechToTextBridge().name).toBe('stub');
    expect(
      installManagedFasterWhisperSpeechToTextBridgeIfAvailable({ KYBERION_STT_COMMAND: 'explicit' })
    ).toBe(false);
  });

  it.each([
    {
      label: 'nonzero exit',
      status: 1,
      stdout: '{"text":"must not persist"}',
      stderr: 'model failed',
      error: 'backend failed: model failed',
    },
    {
      label: 'error response',
      status: 0,
      stdout: '{"status":"error","error":"model failed"}',
      stderr: '',
      error: 'backend returned empty text',
    },
    { label: 'invalid JSON', status: 0, stdout: 'not-json', stderr: '', error: 'valid JSON' },
    {
      label: 'empty text',
      status: 0,
      stdout: '{"status":"success","text":"   "}',
      stderr: '',
      error: 'backend returned empty text',
    },
  ])('rejects managed faster-whisper $label without writing a transcript', async (response) => {
    const script = path.join(
      tmpDir,
      'libs/actuators/voice-actuator/scripts/faster_whisper_stt_bridge.py'
    );
    secureIo.safeMkdir(path.dirname(script), { recursive: true });
    secureIo.safeWriteFile(script, '# fixture');
    const audio = path.join(tmpDir, 'failure.wav');
    const output = path.join(tmpDir, 'failure.txt');
    secureIo.safeWriteFile(audio, 'audio fixture');
    vi.mocked(discoverLocalSttBackends).mockReturnValue([
      {
        backend: 'faster_whisper',
        display_name: 'faster-whisper',
        source: 'managed-runtime',
        priority: 90,
        verification: 'python-module',
        python_bin: 'managed-python',
        detail: 'ready',
        connection: {},
      },
    ]);
    const exec = vi.spyOn(secureIo, 'safeExecResult').mockReturnValue({
      status: response.status,
      stdout: response.stdout,
      stderr: response.stderr,
    });
    expect(installManagedFasterWhisperSpeechToTextBridgeIfAvailable({})).toBe(true);
    const bridge = getSpeechToTextBridges().find(
      (candidate) => candidate.name === 'faster_whisper'
    )!;
    await expect(bridge.transcribe({ audioPath: audio, outputPath: output })).rejects.toThrow(
      response.error
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect(secureIo.safeExistsSync(output)).toBe(false);
  });

  it('keeps an explicit command ahead of a previously registered runtime', () => {
    registerSpeechToTextBridge({
      name: 'faster_whisper',
      priority: 90,
      transcribe: async () => ({ text: 'previous', backend: 'faster_whisper' }),
    });
    expect(
      installManagedFasterWhisperSpeechToTextBridgeIfAvailable({
        KYBERION_STT_COMMAND: 'explicit',
      })
    ).toBe(false);
    const selected = installAvailableSpeechToTextBridges({ KYBERION_STT_COMMAND: 'explicit' });
    expect(getSpeechToTextBridges().map((bridge) => bridge.name)).toContain('shell');
    expect(selected.name).toBe('shell');
  });

  it('preserves explicit manual STT priority when a runtime was already registered', () => {
    registerSpeechToTextBridge({
      name: 'faster_whisper',
      priority: 90,
      transcribe: async () => ({ text: 'previous', backend: 'faster_whisper' }),
    });
    expect(
      installAvailableSpeechToTextBridges({
        KYBERION_STT_COMMAND: 'explicit',
        KYBERION_STT_PRIORITY: '7',
      }).name
    ).toBe('faster_whisper');
    expect(getSpeechToTextBridges().find((bridge) => bridge.name === 'shell')?.priority).toBe(7);
  });

  it('keeps explicit FluidAudio ahead of a previously registered higher-priority runtime', () => {
    registerSpeechToTextBridge({
      name: 'faster_whisper',
      priority: 150,
      transcribe: async () => ({ text: 'previous', backend: 'faster_whisper' }),
    });
    expect(
      installAvailableSpeechToTextBridges({
        KYBERION_FLUID_AUDIO_STT_COMMAND: 'explicit',
      }).name
    ).toBe('fluid-audio-parakeet');
  });

  it('defaults to the stub bridge', () => {
    expect(getSpeechToTextBridge().name).toBe('stub');
    expect(getSpeechToTextCapabilities(getSpeechToTextBridge())).toEqual({
      timestamps: false,
      granularity: 'none',
    });
  });

  it('stub falls back to a sidecar transcript when available', async () => {
    const audioAbs = path.join(tmpDir, 'call.wav');
    fs.writeFileSync(audioAbs, 'fake-audio');
    fs.writeFileSync(`${audioAbs}.transcript.txt`, '顧客A: はじめまして');

    const result = await stubSpeechToTextBridge.transcribe({ audioPath: 'call.wav' });
    expect(result.backend).toBe('stub-sidecar');
    expect(result.text).toContain('はじめまして');
    expect(result.synthetic).toBe(true);
  });

  it('stub throws when no sidecar is present', async () => {
    fs.writeFileSync(path.join(tmpDir, 'call.wav'), 'fake-audio');
    await expect(stubSpeechToTextBridge.transcribe({ audioPath: 'call.wav' })).rejects.toThrow(
      /no transcript backend/u
    );
  });

  it('rejects a directory used as a transcript sidecar', async () => {
    const audioAbs = path.join(tmpDir, 'directory-sidecar.wav');
    fs.writeFileSync(audioAbs, 'fake-audio');
    fs.mkdirSync(`${audioAbs}.transcript.txt`);

    await expect(
      stubSpeechToTextBridge.transcribe({ audioPath: 'directory-sidecar.wav' })
    ).rejects.toThrow('[stt-bridge] transcript sidecar must be a regular file');
  });
  it('rejects audio paths outside the repository', async () => {
    await expect(
      stubSpeechToTextBridge.transcribe({ audioPath: '/tmp/external-call.wav' })
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects audio paths traversing a symbolic link', async () => {
    const targetPath = path.join(tmpDir, 'target.wav');
    const linkPath = path.join(tmpDir, 'linked.wav');
    fs.writeFileSync(targetPath, 'fake-audio');
    safeSymlinkSync(targetPath, linkPath);
    try {
      await expect(stubSpeechToTextBridge.transcribe({ audioPath: linkPath })).rejects.toThrow(
        '[RESOURCE_PATH_SYMLINK]'
      );
    } finally {
      safeUnlinkSync(linkPath);
    }
  });

  it('rejects a shell transcript output path outside the repository', async () => {
    fs.writeFileSync(path.join(tmpDir, 'call.wav'), 'fake-audio');
    const bridge = new ShellSpeechToTextBridge({ command: "printf 'hello'" });
    await expect(
      bridge.transcribe({ audioPath: 'call.wav', outputPath: '/tmp/external-transcript.txt' })
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects a directory passed as shell audio input', async () => {
    fs.mkdirSync(path.join(tmpDir, 'audio-directory'));
    const bridge = new ShellSpeechToTextBridge({ command: "printf 'hello'" });

    await expect(bridge.transcribe({ audioPath: 'audio-directory' })).rejects.toThrow(
      '[stt-bridge] audio input must be a regular file'
    );
  });
  it('normalizes structured shell output and drops malformed segments', async () => {
    const audioPath = path.join(tmpDir, 'structured.wav');
    fs.writeFileSync(audioPath, 'fake-audio');
    const bridge = new ShellSpeechToTextBridge({
      command: `printf '%s' '{"text":"hello","capabilities":{"timestamps":true,"granularity":"segment"},"segments":[{"start_sec":0,"end_sec":1,"text":"hello"},null,{"start_sec":"bad"}]}'`,
      structuredOutput: true,
    });

    const result = await bridge.transcribe({ audioPath: 'structured.wav' });

    expect(result.text).toBe('hello');
    expect(result.capabilities).toEqual({ timestamps: true, granularity: 'segment' });
    expect(result.segments).toEqual([{ start_sec: 0, end_sec: 1, text: 'hello' }]);
  });

  it('rejects structured output whose root is not a JSON object', async () => {
    const audioPath = path.join(tmpDir, 'invalid-structured.wav');
    fs.writeFileSync(audioPath, 'fake-audio');
    const bridge = new ShellSpeechToTextBridge({
      command: "printf '%s' '[1,2]'",
      structuredOutput: true,
    });

    await expect(bridge.transcribe({ audioPath: 'invalid-structured.wav' })).rejects.toThrow(
      'structured output was not valid JSON'
    );
  });

  it('normalizes configured capabilities and rejects malformed shapes', () => {
    expect(
      parseSpeechToTextCapabilities({ timestamps: true, granularity: 'word', local_only: true })
    ).toEqual({ timestamps: true, granularity: 'word', local_only: true });
    expect(parseSpeechToTextCapabilities([])).toBeUndefined();
    expect(
      parseSpeechToTextCapabilities({ timestamps: 'true', granularity: 'segment' })
    ).toBeUndefined();
    expect(
      parseSpeechToTextCapabilities({ timestamps: true, granularity: 'invalid' })
    ).toBeUndefined();
  });

  it('resolves a registered bridge', () => {
    const fake: SpeechToTextBridge = {
      name: 'fake',
      transcribe: async () =>
        ({ text: 'x', backend: 'fake', started_at: new Date().toISOString() }) as any,
    };
    registerSpeechToTextBridge(fake);
    expect(getSpeechToTextBridge().name).toBe('fake');
  });

  it('rejects duplicate names in the named seam', () => {
    const fake: SpeechToTextBridge = {
      name: 'duplicate',
      transcribe: async () => ({ text: 'x', backend: 'duplicate' }),
    };
    registerSpeechToTextBridge(fake);
    expect(() => registerSpeechToTextBridge(fake)).toThrow(/already registered/);
  });

  it('exposes timestamp capability for a timestamped backend', () => {
    const fake: SpeechToTextBridge = {
      name: 'timestamped-fake',
      capabilities: { timestamps: true, granularity: 'segment' },
      transcribe: async () => ({
        text: 'x',
        backend: 'timestamped-fake',
        capabilities: { timestamps: true, granularity: 'segment' },
        segments: [{ start_sec: 0, end_sec: 1, text: 'x' }],
      }),
    };
    registerSpeechToTextBridge(fake);
    expect(getSpeechToTextCapabilities(getSpeechToTextBridge())).toEqual({
      timestamps: true,
      granularity: 'segment',
    });
  });

  it('keeps multiple registered bridges available for capability-based selection', () => {
    registerSpeechToTextBridge({
      name: 'plain',
      priority: 1,
      transcribe: async () => ({ text: 'plain', backend: 'plain' }),
    });
    registerSpeechToTextBridge({
      name: 'timestamped',
      priority: 2,
      capabilities: { timestamps: true, granularity: 'segment' },
      transcribe: async () => ({
        text: 'timestamped',
        backend: 'timestamped',
        capabilities: { timestamps: true, granularity: 'segment' },
        segments: [{ start_sec: 0, end_sec: 1, text: 'timestamped' }],
      }),
    });
    expect(getSpeechToTextBridges().map((bridge) => bridge.name)).toEqual(['plain', 'timestamped']);
  });

  it('downgrades a falsely declared timestamp capability when no valid segments are returned', () => {
    const result = normalizeSpeechToTextResult(
      { name: 'bad-backend', capabilities: { timestamps: true, granularity: 'segment' } },
      { text: 'x', backend: 'bad-backend', segments: [{ start_sec: -1, end_sec: 0, text: 'x' }] }
    );
    expect(result.capabilities).toEqual({ timestamps: false, granularity: 'none' });
    expect(result.segments).toEqual([]);
  });

  it('installs configured STT bridges from the injected environment', () => {
    expect(
      installShellSpeechToTextBridgeIfAvailable({
        KYBERION_STT_COMMAND: 'whisper --file {{audio}}',
        KYBERION_STT_CAPABILITIES: JSON.stringify({
          timestamps: true,
          granularity: 'segment',
        }),
        KYBERION_STT_PRIORITY: '7',
      })
    ).toBe(true);
    expect(getSpeechToTextBridge().name).toBe('shell');
    expect(getSpeechToTextBridge().priority).toBe(7);
    expect(getSpeechToTextCapabilities(getSpeechToTextBridge())).toEqual({
      timestamps: true,
      granularity: 'segment',
    });

    resetSpeechToTextBridge();
    expect(
      installFluidAudioSpeechToTextBridgeIfAvailable({
        KYBERION_FLUID_AUDIO_STT_COMMAND: 'parakeet --audio {{audio}}',
      })
    ).toBe(true);
    expect(getSpeechToTextBridge().name).toBe('fluid-audio-parakeet');
  });

  it('builds WhisperKit argv without a shell command or whisper.cpp flags', () => {
    expect(buildWhisperKitTranscribeArgs('/repo/audio.wav', 'ja')).toEqual([
      'transcribe',
      '--audio-path',
      '/repo/audio.wav',
      '--language',
      'ja',
      '--without-timestamps',
    ]);
  });

  it('keeps explicit shell STT ahead of the FluidAudio fallback', () => {
    expect(
      installFluidAudioSpeechToTextBridgeIfAvailable({
        KYBERION_STT_COMMAND: 'whisper --file {{audio}}',
        KYBERION_FLUID_AUDIO_STT_COMMAND: 'parakeet --audio {{audio}}',
      })
    ).toBe(false);
  });

  it('keeps shared STT registration idempotent while preserving explicit configuration', () => {
    const env = {
      KYBERION_STT_COMMAND: 'whisper --file {{audio}}',
      KYBERION_FLUID_AUDIO_STT_COMMAND: 'parakeet --audio {{audio}}',
    };
    expect(installAvailableSpeechToTextBridges(env).name).toBe('shell');
    expect(installAvailableSpeechToTextBridges(env).name).toBe('shell');
  });

  it('routes STT environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(path.join(pathResolver.rootDir(), 'libs/core/voice/speech-to-text-bridge.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });
});
