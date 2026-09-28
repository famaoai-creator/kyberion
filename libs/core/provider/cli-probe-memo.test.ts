import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() =>
  vi.fn(() => ({ status: 0, stdout: '1.2.3\n', stderr: '', error: undefined }))
);

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
  spawn: vi.fn(),
}));

import { memoizedCliSpawnSync, resetCliProbeMemo } from './provider-discovery.js';

describe('memoizedCliSpawnSync', () => {
  afterEach(() => {
    resetCliProbeMemo();
    spawnSyncMock.mockClear();
  });

  it('spawns once for the same binary and argv', () => {
    const first = memoizedCliSpawnSync('cursor', ['--version'], { timeout: 5_000 });
    const second = memoizedCliSpawnSync('cursor', ['--version'], {
      timeout: 10_000,
      env: { PATH: '/other' },
    });

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(second.stdout).toBe('1.2.3\n');
  });

  it('spawns again for a different argv', () => {
    memoizedCliSpawnSync('cursor', ['--version'], {});
    memoizedCliSpawnSync('cursor', ['status'], {});
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });
});
