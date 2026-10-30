import { beforeEach, describe, expect, it, vi } from 'vitest';
const probe = vi.hoisted(() => vi.fn(() => ({ status: 0, error: undefined })));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync: probe,
}));
import { probePcmAudioStreaming } from './streaming-voice-playback.js';
beforeEach(() => {
  probe.mockClear();
  probe.mockReturnValue({ status: 0, error: undefined });
});
describe('PCM player availability', () => {
  it('keeps ffplay as the default player', () => {
    expect(probePcmAudioStreaming()).toEqual({ available: true });
    expect(probe).toHaveBeenCalledWith('which', ['ffplay'], { stdio: 'ignore' });
  });
  it('probes the same explicit executable selected for playback', () => {
    expect(probePcmAudioStreaming(['/custom/player', '--pcm'])).toEqual({ available: true });
    expect(probe).toHaveBeenCalledWith('which', ['/custom/player'], { stdio: 'ignore' });
    probe.mockReturnValue({ status: 1, error: undefined });
    expect(probePcmAudioStreaming(['/custom/player', '--pcm'])).toEqual({
      available: false,
      reason: '/custom/player is not available on PATH',
    });
  });
});
