import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
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

import { rootResolve } from './path-resolver.js';
import {
  getSpeechToTextBridge,
  getSpeechToTextBridges,
  getSpeechToTextCapabilities,
  registerSpeechToTextBridge,
  resetSpeechToTextBridge,
  normalizeSpeechToTextResult,
  stubSpeechToTextBridge,
  type SpeechToTextBridge,
} from './speech-to-text-bridge.js';

describe('speech-to-text-bridge', () => {
  let tmpDir = '';
  const mockResolve = rootResolve as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-'));
    mockResolve.mockImplementation((rel: string) => path.join(tmpDir, rel));
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
      /no transcript backend/u,
    );
  });

  it('resolves a registered bridge', () => {
    const fake: SpeechToTextBridge = {
      name: 'fake',
      transcribe: async () => ({ text: 'x', backend: 'fake', started_at: new Date().toISOString() } as any),
    };
    registerSpeechToTextBridge(fake);
    expect(getSpeechToTextBridge().name).toBe('fake');
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
    registerSpeechToTextBridge({ name: 'plain', priority: 1, transcribe: async () => ({ text: 'plain', backend: 'plain' }) });
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
      { text: 'x', backend: 'bad-backend', segments: [{ start_sec: -1, end_sec: 0, text: 'x' }] },
    );
    expect(result.capabilities).toEqual({ timestamps: false, granularity: 'none' });
    expect(result.segments).toEqual([]);
  });
});
