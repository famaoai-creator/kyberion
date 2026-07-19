import { describe, expect, it } from 'vitest';

import { playAudioFile, probeAudioPlayback } from './audio-playback.js';

describe('audio playback', () => {
  it('reports a custom command as available', () => {
    expect(probeAudioPlayback({ command: ['true'] }).available).toBe(true);
  });

  it('resolves ok for a successful player process', async () => {
    const handle = playAudioFile('/tmp/whatever.wav', {
      command: [process.execPath, '-e', 'setTimeout(()=>process.exit(0),50)'],
    });
    const result = await handle.done;
    expect(result).toEqual({ ok: true, interrupted: false });
  });

  it('stop() interrupts a long-running player immediately', async () => {
    const handle = playAudioFile('/tmp/whatever.wav', {
      command: [process.execPath, '-e', 'setTimeout(()=>process.exit(0),60000)'],
    });
    const startedAt = Date.now();
    const result = await handle.stop();
    expect(result.interrupted).toBe(true);
    expect(result.ok).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it('reports player failure with the exit detail', async () => {
    const handle = playAudioFile('/tmp/whatever.wav', {
      command: [process.execPath, '-e', 'console.error("boom");process.exit(3)'],
    });
    const result = await handle.done;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/code 3/);
    expect(result.error).toMatch(/boom/);
  });

  it('substitutes the {file} placeholder in custom commands', async () => {
    const handle = playAudioFile('/tmp/target.wav', {
      command: [
        process.execPath,
        '-e',
        'process.exit(process.argv[1] === "/tmp/target.wav" ? 0 : 9)',
        '{file}',
      ],
    });
    const result = await handle.done;
    expect(result.ok).toBe(true);
  });
});
