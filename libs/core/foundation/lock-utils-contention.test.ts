import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import {
  acquireLock,
  registerLockIo,
  releaseLock,
  withLockSync,
  type LockIo,
} from './lock-utils.js';

const DEAD_PID = 2147483647;
const resource = 'lock-publication-interleaving';
const lock = path.join(pathResolver.rootDir(), 'active/shared/runtime/locks', resource + '.lock');
type Cell = { text: string };
let files: Map<string, Cell>;
let now: number;
let hooks: {
  opened?: (file: string) => void;
  read?: (file: string) => void;
  missing?: (file: string) => void;
};
let removed: string[];
const error = (code: string) => Object.assign(new Error(code), { code });
function publish(file: string, pid = process.pid) {
  files.set(file, { text: JSON.stringify({ pid }) });
}

beforeEach(() => {
  files = new Map();
  removed = [];
  now = 0;
  hooks = {};
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(Atomics, 'wait').mockImplementation(() => {
    now += 50;
    return 'timed-out';
  });
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid === DEAD_PID) throw error('ESRCH');
    return true;
  });
  const io: LockIo = {
    exists: (file) => file === path.dirname(lock) || files.has(file),
    mkdir: () => {},
    createExclusive: (file, text) => {
      if (files.has(file)) throw error('EEXIST');
      // Model wx publishing an empty inode before the writer fills the PID JSON.
      const cell = { text: '' };
      files.set(file, cell);
      hooks.opened?.(file);
      cell.text = text;
    },
    unlink: (file) => {
      removed.push(file);
      files.delete(file);
    },
    loadJson: <T>(file: string): T => {
      const cell = files.get(file);
      if (!cell) {
        hooks.missing?.(file);
        throw error('ENOENT');
      }
      const snapshot = cell.text;
      hooks.read?.(file);
      return JSON.parse(snapshot) as T;
    },
  };
  registerLockIo(io);
});
afterEach(() => vi.restoreAllMocks());

describe('lock publication and cleanup interleavings', () => {
  it('does not enter or delete another writer during its partial publication', () => {
    let innerRan = false;
    let nested = false;
    hooks.opened = (file) => {
      if (file !== lock || nested) return;
      nested = true;
      expect(() =>
        withLockSync(
          resource,
          () => {
            innerRan = true;
          },
          50
        )
      ).toThrow('[LOCK_RECOVERY_REQUIRED]');
      expect(removed).not.toContain(lock);
    };
    expect(withLockSync(resource, () => 'outer', 200)).toBe('outer');
    expect(innerRan).toBe(false);
    expect(nested).toBe(true);
  });
  it('rechecks ownership under cleanup guard instead of deleting a newer live lock', async () => {
    publish(lock, DEAD_PID);
    let nested: Promise<boolean> | undefined;
    let once = false;
    hooks.read = (file) => {
      if (file !== lock || once) return;
      once = true;
      nested = acquireLock(resource, 0); // It reclaims old PID and keeps its new live lock.
    };
    let outerRan = false;
    expect(() =>
      withLockSync(
        resource,
        () => {
          outerRan = true;
        },
        100
      )
    ).toThrow('[LOCK_TIMEOUT]');
    await expect(nested).resolves.toBe(true);
    expect(outerRan).toBe(false);
    expect(JSON.parse(files.get(lock)!.text).pid).toBe(process.pid);
    expect(removed.filter((file) => file === lock)).toHaveLength(1);
  });
  it('permits only one concurrent stale cleanup even while its guard is incomplete', async () => {
    publish(lock, DEAD_PID);
    let nested: Promise<boolean> | undefined;
    let once = false;
    hooks.opened = (file) => {
      if (file !== lock + '.reclaim' || once) return;
      once = true;
      nested = acquireLock(resource, 0);
      // Attach rejection immediately: the incomplete cleanup owner is uncertain.
      nested.catch(() => {});
    };
    expect(withLockSync(resource, () => 'winner', 100)).toBe('winner');
    await expect(nested).rejects.toThrow('[LOCK_RECOVERY_REQUIRED]');
    expect(removed.filter((file) => file === lock)).toHaveLength(2); // old PID + owner's release
  });
  it('does not unlink a new publication after guarded read observed ENOENT', () => {
    publish(lock, DEAD_PID);
    hooks.opened = (file) => {
      if (file === lock + '.reclaim') files.delete(lock);
    };
    hooks.missing = (file) => {
      if (file === lock) publish(lock);
    };
    expect(() => withLockSync(resource, () => 'must not run', 100)).toThrow('[LOCK_TIMEOUT]');
    expect(files.has(lock)).toBe(true);
    expect(removed).not.toContain(lock);
  });
  it.each(['', JSON.stringify({ pid: DEAD_PID }), JSON.stringify({ pid: 0 })])(
    'retains an abandoned cleanup marker and names explicit recovery (%s)',
    (text) => {
      publish(lock, DEAD_PID);
      files.set(lock + '.reclaim', { text });
      expect(() => withLockSync(resource, () => 'must not run', 50)).toThrow(lock + '.reclaim');
      expect(files.has(lock)).toBe(true);
      expect(files.has(lock + '.reclaim')).toBe(true);
      expect(removed).toEqual([]);
    }
  );
  it('retains permission-denied owner and never force-releases malformed metadata', () => {
    publish(lock);
    vi.mocked(process.kill).mockImplementation(() => {
      throw error('EPERM');
    });
    expect(() => withLockSync(resource, () => 'must not run', 50)).toThrow('[LOCK_TIMEOUT]');
    files.set(lock, { text: '' });
    releaseLock(resource);
    expect(files.has(lock)).toBe(true);
    expect(removed).toEqual([]);
  });
});
