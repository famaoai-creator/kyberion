import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from './secure-io.js';
import {
  spawnSupervisedChild,
  stopSupervisedChild,
} from '../../satellites/shared/supervise-child.js';
describe('supervised stop result', () => {
  it('reports failure when killing throws and preserves SIGTERM', () => {
    const kill = vi.fn(() => {
      throw new Error('permission denied');
    });
    expect(stopSupervisedChild({ kill } as unknown as ChildProcess)).toBe(false);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(stopSupervisedChild(null)).toBe(false);
  });
});

// Python STT/TTS bridges require writable stdin and piped output.
it('preserves piped stdin through the governed spawn boundary', async () => {
  const child = spawnSupervisedChild(
    process.execPath,
    ['-e', 'process.stdin.pipe(process.stdout)'],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  let output = '';
  child.stdout!.on('data', (chunk) => {
    output += String(chunk);
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  child.stdin!.end('speech-bridge-input');
  expect(await closed).toBe(0);
  expect(output).toBe('speech-bridge-input');
});
