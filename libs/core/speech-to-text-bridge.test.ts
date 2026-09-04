import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('./path-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./path-resolver.js')>('./path-resolver.js');
  return { ...actual, rootResolve: vi.fn() };
});

vi.mock('./tier-guard.js', () => ({
  validateWritePermission: () => ({ allowed: true }),
  validateReadPermission: () => ({ allowed: true }),
  detectTier: () => 'public',
}));

vi.mock('./policy-engine.js', () => ({
  policyEngine: { evaluate: () => ({ allowed: true, action: 'allow' }) },
}));

import { pathResolver, rootResolve } from './path-resolver.js';
import { safeReadFile, safeSymlinkSync, safeUnlinkSync } from './secure-io.js';
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
    vi.clearAllMocks();
    resetSpeechToTextBridge();
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

  it('keeps explicit shell STT ahead of the FluidAudio fallback', () => {
    expect(
      installFluidAudioSpeechToTextBridgeIfAvailable({
        KYBERION_STT_COMMAND: 'whisper --file {{audio}}',
        KYBERION_FLUID_AUDIO_STT_COMMAND: 'parakeet --audio {{audio}}',
      })
    ).toBe(false);
  });

  it('routes STT environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(path.join(pathResolver.rootDir(), 'libs/core/speech-to-text-bridge.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });
});
