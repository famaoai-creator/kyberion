import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(() => ''),
  safeMkdir: vi.fn(),
  safeWriteFile: vi.fn(),
  sharedTmp: vi.fn((value: string) => `/tmp/${value}`),
}));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    safeExec: mocks.safeExec,
    safeMkdir: mocks.safeMkdir,
    safeWriteFile: mocks.safeWriteFile,
  };
});

vi.mock('./path-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./path-resolver.js')>('./path-resolver.js');
  return {
    ...actual,
    pathResolver: {
      ...actual.pathResolver,
      sharedTmp: mocks.sharedTmp,
    },
  };
});

import { recordVoiceSample } from './voice-sample-recorder.js';

describe('voice-sample-recorder', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.KYBERION_AUDIO_RECORD_COMMAND;
  });

  it('returns blocked when no recording command is configured', () => {
    const result = recordVoiceSample({
      action: 'record_voice_sample',
      request_id: 'rec-1',
      sample_id: 's1',
      duration_sec: 8,
      prompt_text: 'Tell me about Kyberion.',
    });

    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('KYBERION_AUDIO_RECORD_COMMAND');
    expect(mocks.safeExec).not.toHaveBeenCalled();
  });

  it('invokes the configured shell recording command', () => {
    process.env.KYBERION_AUDIO_RECORD_COMMAND = 'record-tool --out {{output}} --sec {{duration_sec}}';
    const result = recordVoiceSample({
      action: 'record_voice_sample',
      request_id: 'rec-2',
      sample_id: 's2',
      duration_sec: 12,
      prompt_text: 'Please read this line.',
    });

    expect(result.status).toBe('succeeded');
    expect(result.output_path).toBe('/tmp/voice-sample-recording/rec-2/s2.wav');
    expect(mocks.safeWriteFile).toHaveBeenCalledWith('/tmp/voice-sample-recording/rec-2/s2.prompt.txt', 'Please read this line.\n');
    expect(mocks.safeExec).toHaveBeenCalledWith(
      expect.any(String),
      ['-lc', 'record-tool --out "/tmp/voice-sample-recording/rec-2/s2.wav" --sec 12'],
      expect.objectContaining({ timeoutMs: 30000 }),
    );
  });
});
