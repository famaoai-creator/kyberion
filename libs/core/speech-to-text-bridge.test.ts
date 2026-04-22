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
  registerSpeechToTextBridge,
  resetSpeechToTextBridge,
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
});
