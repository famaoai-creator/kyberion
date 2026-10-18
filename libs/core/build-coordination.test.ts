import { describe, it, expect, vi } from 'vitest';
import { tryInspectCompilerOutputs, withCompilerOutputs } from './build-coordination.js';

vi.mock('./foundation/lock-utils.js', async (original) => {
  const io = await original<typeof import('./foundation/lock-utils.js')>();
  const key = `compiler-coordination-test-${process.pid}`;
  return {
    ...io,
    acquireLock: (_key: string, timeout?: number) => io.acquireLock(key, timeout),
    releaseLock: () => io.releaseLock(key),
  };
});

describe('compiler output coordination', () => {
  it('defers inspections while a writer holds the mutex and releases on error', async () => {
    await expect(
      withCompilerOutputs(async () => {
        expect(await tryInspectCompilerOutputs(async () => 'unsafe')).toEqual({ deferred: true });
        throw new Error('compiler failed');
      })
    ).rejects.toThrow('compiler failed');
    expect(await tryInspectCompilerOutputs(async () => 'safe')).toEqual({
      deferred: false,
      value: 'safe',
    });
  });

  it('excludes concurrent inspections and releases after their callback fails', async () => {
    await expect(
      tryInspectCompilerOutputs(async () => {
        expect(await tryInspectCompilerOutputs(async () => 'second')).toEqual({ deferred: true });
        throw new Error('inspection failed');
      })
    ).rejects.toThrow('inspection failed');
    expect(await withCompilerOutputs(async () => 'next')).toBe('next');
  });
});
