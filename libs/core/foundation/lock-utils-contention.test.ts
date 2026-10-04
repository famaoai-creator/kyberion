import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import {
  acquireLock,
  inspectLockRecovery,
  LOCK_RECOVERY_AGE_MS,
  registerLockIo,
  releaseLock,
  withLockSync,
  type LockIo,
} from './lock-utils.js';

const DEAD_PID = 2147483647;
const resource = 'lock-publication-interleaving';
const lock = path.join(pathResolver.rootDir(), 'active/shared/runtime/locks', resource + '.lock');
type Cell = { text: string; mtime: number };
let files: Map<string, Cell>;
let now: number;
let hooks: {
  opened?: (file: string) => void;
  read?: (file: string) => void;
  missing?: (file: string) => void;
};
let removed: string[];
let previousIo: LockIo | undefined;
const error = (code: string) => Object.assign(new Error(code), { code });
function publish(file: string, pid = process.pid) {
  files.set(file, { text: JSON.stringify({ pid }), mtime: now });
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
      const cell = { text: '', mtime: now };
      files.set(file, cell);
      hooks.opened?.(file);
      cell.text = text;
    },
    unlink: (file) => {
      removed.push(file);
      files.delete(file);
    },
    ageMs: (file) => (files.has(file) ? now - files.get(file)!.mtime : undefined),
    rename: (from, to) => {
      const cell = files.get(from);
      if (!cell) throw error('ENOENT');
      files.delete(from);
      files.set(to, cell);
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
  previousIo = registerLockIo(io);
});
afterEach(() => {
  registerLockIo(previousIo);
  vi.restoreAllMocks();
});

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
      ).toThrow(/\[LOCK_TIMEOUT\].*reclaimed automatically/);
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
    };
    expect(withLockSync(resource, () => 'winner', 100)).toBe('winner');
    // The incomplete (fresh) cleanup guard is uncertain: report contention, never throw.
    await expect(nested).resolves.toBe(false);
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
  it.each(['', JSON.stringify({ pid: 0 }), JSON.stringify({ pid: process.pid })])(
    'retains a fresh cleanup marker and reclaims it once past the recovery age (%s)',
    (text) => {
      publish(lock, DEAD_PID);
      files.set(lock + '.reclaim', { text, mtime: now });
      expect(() => withLockSync(resource, () => 'must not run', 50)).toThrow('[LOCK_TIMEOUT]');
      expect(files.has(lock)).toBe(true);
      expect(files.has(lock + '.reclaim')).toBe(true);
      expect(removed).toEqual([]);

      now += LOCK_RECOVERY_AGE_MS; // unverifiable or PID-reused guard is now provably orphaned
      expect(withLockSync(resource, () => 'recovered', 50)).toBe('recovered');
      expect(files.has(lock + '.reclaim')).toBe(false);
      expect([...files.keys()].filter((file) => file.includes('.stale-'))).toEqual([]);
    }
  );
  it('reclaims a cleanup marker left by a dead cleaner without waiting', () => {
    publish(lock, DEAD_PID);
    publish(lock + '.reclaim', DEAD_PID);
    expect(withLockSync(resource, () => 'recovered', 50)).toBe('recovered');
    expect(files.has(lock + '.reclaim')).toBe(false);
  });
  it('puts back a fresh guard that replaced the orphan before the tomb rename', () => {
    publish(lock, DEAD_PID);
    publish(lock + '.reclaim', DEAD_PID);
    const fresh = JSON.stringify({ pid: process.pid + 1 });
    hooks.read = (file) => {
      // Between judging the orphan and claiming it, a live cleaner replaces it.
      if (file === lock + '.reclaim' && files.get(file)!.text !== fresh)
        files.set(file, { text: fresh, mtime: now });
    };
    expect(() => withLockSync(resource, () => 'must not run', 50)).toThrow('[LOCK_TIMEOUT]');
    expect(files.get(lock + '.reclaim')?.text).toBe(fresh);
    expect(files.has(lock)).toBe(true);
  });
  it('reclaims an empty main record only after the recovery age and reports it meanwhile', async () => {
    files.set(lock, { text: '', mtime: now });
    await expect(acquireLock(resource, 0)).resolves.toBe(false);
    expect(inspectLockRecovery(resource)).toMatchObject({
      path: lock,
      kind: 'lock_record',
      state: 'unknown',
      reclaimInMs: LOCK_RECOVERY_AGE_MS,
    });
    now += LOCK_RECOVERY_AGE_MS;
    await expect(acquireLock(resource, 0)).resolves.toBe(true);
    expect(JSON.parse(files.get(lock)!.text).pid).toBe(process.pid);
    expect(inspectLockRecovery(resource)).toBeUndefined();
    releaseLock(resource);
  });
  it('publishes through the atomic seam when available, never exposing a partial record', () => {
    const seen: string[] = [];
    const io: LockIo = {
      exists: () => true,
      mkdir: () => {},
      createExclusive: () => {
        throw new Error('non-atomic path must not be used');
      },
      publishExclusive: (file, text) => {
        if (files.has(file)) throw error('EEXIST');
        files.set(file, { text, mtime: now });
      },
      unlink: (file) => void files.delete(file),
      loadJson: <T>(file: string): T => {
        const cell = files.get(file);
        if (!cell) throw error('ENOENT');
        seen.push(cell.text);
        return JSON.parse(cell.text) as T;
      },
    };
    registerLockIo(io);
    expect(withLockSync(resource, () => 'ok', 50)).toBe('ok');
    expect(seen.every((text) => text.length > 0)).toBe(true);
    expect(files.has(lock)).toBe(false);
  });
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
