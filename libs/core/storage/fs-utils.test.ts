import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '../secure-io.js';
import { getAllFiles, mapAsync } from './fs-utils.js';

const rootDir = pathResolver.sharedTmp('fs-utils-symlink-test');

afterEach(() => {
  safeRmSync(rootDir, { recursive: true, force: true });
});

describe('fs-utils traversal', () => {
  it('does not return symlinks as regular files', () => {
    const target = `${rootDir}/target.json`;
    const link = `${rootDir}/link.json`;
    safeMkdir(rootDir, { recursive: true });
    safeWriteFile(target, '{}');
    safeSymlinkSync(target, link);

    expect(getAllFiles(rootDir)).toEqual([target]);
  });

  it('yields nothing for a missing root', () => {
    expect(getAllFiles(`${rootDir}/missing`)).toEqual([]);
  });

  it('rethrows a refusal to list the walk root instead of returning []', () => {
    // A data-only role may not list the personal tier.
    const saved = { persona: process.env.KYBERION_BASE_ROLE, role: process.env.MISSION_ROLE };
    process.env.KYBERION_BASE_ROLE = 'worker';
    process.env.MISSION_ROLE = 'finance_controller';
    try {
      expect(() => getAllFiles(pathResolver.knowledge('personal'))).toThrow(/ROLE_VIOLATION/);
    } finally {
      if (saved.persona === undefined) delete process.env.KYBERION_BASE_ROLE;
      else process.env.KYBERION_BASE_ROLE = saved.persona;
      if (saved.role === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = saved.role;
    }
  });
});

describe('mapAsync concurrency (C-FSU-004)', () => {
  it('maps every item in input order within the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapAsync([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      // Yield so the other workers start before this one finishes.
      await Promise.resolve();
      await Promise.resolve();
      active--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(await mapAsync([], 3, async (n: number) => n)).toEqual([]);
  });

  it.each([0, -1, Number.NaN, 1.5])(
    'rejects concurrency %s with a clear error instead of skipping the work',
    async (concurrency) => {
      const seen: number[] = [];
      await expect(
        mapAsync([1, 2], concurrency, async (n) => {
          seen.push(n);
          return n;
        })
      ).rejects.toThrow(/mapAsync: concurrency must be a positive integer/);
      expect(seen).toEqual([]);
    }
  );
});
