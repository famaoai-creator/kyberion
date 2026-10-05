import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import {
  acquireLock,
  inspectLockRecovery,
  LOCK_LIVE_GUARD_RECOVERY_AGE_MS,
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
  renamed?: (from: string, to: string) => void;
};
let removed: string[];
let denied: Set<string>;
let previousIo: LockIo | undefined;
const error = (code: string) => Object.assign(new Error(code), { code });
function publish(file: string, pid = process.pid) {
  files.set(file, { text: JSON.stringify({ pid }), mtime: now });
}

beforeEach(() => {
  files = new Map();
  removed = [];
  denied = new Set();
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
      removed.push(from); // the record leaves its path (tomb rename)
      files.delete(from);
      files.set(to, cell);
      hooks.renamed?.(from, to);
    },
    linkExclusive: (from, to) => {
      const cell = files.get(from);
      if (!cell) throw error('ENOENT');
      if (files.has(to)) throw error('EEXIST');
      files.set(to, cell); // same inode
    },
    readdir: (dir) =>
      [...files.keys()].filter((file) => path.dirname(file) === dir).map((f) => path.basename(f)),
    loadJson: <T>(file: string): T => {
      if (denied.has(file)) throw error('EACCES');
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
  it.each([
    ['writer-lease-path:abc', 'writer-lease-path%3Aabc'],
    ['../nested\\key', '..%2Fnested%5Ckey'],
    ['CON', '%43ON'],
    ['nul.txt', '%6Eul.txt'],
  ])('reports no recovery for a healthy portable lock %s', (key, filename) => {
    const file = path.join(path.dirname(lock), filename + '.lock');
    // This IO fixture preserves ENOENT for the absent cleanup guard.
    expect(inspectLockRecovery(key)).toBeUndefined();
    withLockSync(key, () => {
      expect(files.has(file)).toBe(true);
      expect(inspectLockRecovery(key)).toBeUndefined();
      expect(() => withLockSync(key, () => undefined, 1)).toThrow('[LOCK_TIMEOUT]');
    });
    expect(files.has(file)).toBe(false);
    expect(inspectLockRecovery(key)).toBeUndefined();
  });

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
  it.each([
    ['', LOCK_RECOVERY_AGE_MS],
    [JSON.stringify({ pid: 0 }), LOCK_RECOVERY_AGE_MS],
    [JSON.stringify({ pid: process.pid }), LOCK_LIVE_GUARD_RECOVERY_AGE_MS],
  ])('retains cleanup ownership even past the former recovery age (%s)', (text, recoveryAge) => {
    publish(lock, DEAD_PID);
    files.set(lock + '.reclaim', { text, mtime: now });
    expect(() => withLockSync(resource, () => 'must not run', 50)).toThrow('[LOCK_TIMEOUT]');
    expect(files.has(lock)).toBe(true);
    expect(files.has(lock + '.reclaim')).toBe(true);
    expect(removed).toEqual([]);

    now += LOCK_RECOVERY_AGE_MS;
    if (recoveryAge > LOCK_RECOVERY_AGE_MS) {
      // A guard whose PID is alive is not reclaimed at the unverifiable-record age.
      expect(() => withLockSync(resource, () => 'must not run', 50)).toThrow('[LOCK_TIMEOUT]');
      expect(files.has(lock + '.reclaim')).toBe(true);
      now += recoveryAge;
    }
    // Age alone cannot authorize a race-free guard takeover.
    expect(() => withLockSync(resource, () => 'must not run', 50)).toThrow(
      /LOCK_TIMEOUT.*never reclaimed automatically/
    );
    expect(files.has(lock + '.reclaim')).toBe(true);
    expect(inspectLockRecovery(resource)).toMatchObject({
      kind: 'cleanup_guard',
      manualRecoveryRequired: true,
    });
    expect(inspectLockRecovery(resource)?.reclaimInMs).toBeUndefined();
    expect(removed).toEqual([]);
    expect([...files.keys()].filter((file) => file.includes('.stale-'))).toEqual([]);
  });
  it('retains a cleanup marker left by a dead cleaner for quiescent recovery', () => {
    publish(lock, DEAD_PID);
    publish(lock + '.reclaim', DEAD_PID);
    expect(() => withLockSync(resource, () => 'must not run', 50)).toThrow(
      /LOCK_TIMEOUT.*never reclaimed automatically/
    );
    expect(files.has(lock + '.reclaim')).toBe(true);
    expect(removed).toEqual([]);
  });
  it('never moves a fresh guard that replaced an observed orphan', () => {
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

describe('identity-checked removal', () => {
  const guard = lock + '.reclaim';
  const record = (pid: number, ts: string) => JSON.stringify({ pid, ts });
  const tombs = () => [...files.keys()].filter((file) => file.includes('.stale-'));

  it('restores a holder that published between the dead inspection and the removal', () => {
    publish(lock, DEAD_PID);
    const holder = { text: record(process.pid + 1, 'holder'), mtime: now };
    let armed = false;
    let replaced = false;
    hooks.read = (file) => {
      // The cleaner has inspected the record as dead and now confirms its own
      // guard; meanwhile (stolen guard) the dead record is replaced by a live holder.
      if (file === lock) armed = true;
      else if (file === guard && armed && !replaced) {
        replaced = true;
        files.set(lock, holder);
      }
    };
    expect(() => withLockSync(resource, () => 'must not run', 50)).toThrow('[LOCK_TIMEOUT]');
    expect(files.get(lock)).toBe(holder); // same inode put back, never deleted
    expect(tombs()).toEqual([]);
    expect(files.has(guard)).toBe(false);
  });

  it('aborts when its own guard was taken over before the removal', () => {
    publish(lock, DEAD_PID);
    let swapped = false;
    hooks.read = (file) => {
      if (file === lock && files.has(guard) && !swapped) {
        swapped = true;
        files.set(guard, { text: record(process.pid + 1, 'other-cleaner'), mtime: now });
      }
    };
    expect(() => withLockSync(resource, () => 'must not run', 50)).toThrow('[LOCK_TIMEOUT]');
    expect(JSON.parse(files.get(lock)!.text).pid).toBe(DEAD_PID); // left to the guard owner
    expect(JSON.parse(files.get(guard)!.text).ts).toBe('other-cleaner'); // never released by us
  });

  it('never opens the guard displacement window to a second cleaner', async () => {
    publish(lock, DEAD_PID);
    publish(guard, DEAD_PID);
    const fresh = { text: record(process.pid + 1, 'fresh-cleaner'), mtime: now };
    let nested: Promise<boolean> | undefined;
    let fired = false;
    hooks.read = (file) => {
      // A live cleaner replaces the orphan between judgement and the tomb rename.
      if (file === guard && !files.get(guard)!.text.includes('fresh-cleaner'))
        files.set(guard, fresh);
    };
    hooks.renamed = (from) => {
      // Put-back window: the fresh guard sits in a tomb; a third cleaner runs.
      if (from === guard && !fired) {
        fired = true;
        hooks.read = undefined;
        nested = acquireLock(resource, 0);
      }
    };
    expect(() => withLockSync(resource, () => 'must not run', 50)).toThrow('[LOCK_TIMEOUT]');
    expect(nested).toBeUndefined(); // No rename: no window in which the third cleaner can enter.
    expect(JSON.parse(files.get(lock)!.text).pid).toBe(DEAD_PID);
    expect(files.get(guard)).toBe(fresh);
    expect(removed).toEqual([]);
  });

  it('does not create a guard put-back race or displaced-record litter', () => {
    publish(lock, DEAD_PID);
    publish(guard, DEAD_PID);
    const fresh = { text: record(process.pid + 1, 'fresh-cleaner'), mtime: now };
    const third = { text: record(process.pid + 2, 'third-cleaner'), mtime: now };
    let done = false;
    hooks.read = (file) => {
      if (file === guard && !done && files.get(guard)!.text.includes(String(DEAD_PID)))
        files.set(guard, fresh);
    };
    hooks.renamed = (from) => {
      if (from === guard && !done) {
        done = true;
        files.set(guard, third); // third cleaner takes the guard while it is absent
      }
    };
    expect(() => withLockSync(resource, () => 'must not run', 50)).toThrow('[LOCK_TIMEOUT]');
    expect(done).toBe(false); // Guard was never moved, so no third cleaner entered.
    expect(files.get(guard)).toBe(fresh);
    expect(JSON.parse(files.get(lock)!.text).pid).toBe(DEAD_PID);
    expect(tombs()).toEqual([]);
  });

  it('treats an unreadable record as held: never reclaimed, reported without an estimate', () => {
    publish(lock, DEAD_PID);
    denied.add(lock);
    now += LOCK_RECOVERY_AGE_MS * 100;
    expect(() => withLockSync(resource, () => 'must not run', 50)).toThrow('[LOCK_TIMEOUT]');
    expect(files.has(lock)).toBe(true);
    expect(removed).toEqual([]);
    const recovery = inspectLockRecovery(resource);
    expect(recovery).toMatchObject({
      path: lock,
      kind: 'lock_record',
      state: 'live',
      unreadable: true,
    });
    expect(recovery?.reclaimInMs).toBeUndefined();
  });

  it('retries a publication whose temp was swept mid-publish (ENOENT) instead of throwing', async () => {
    let lost = 0;
    const io: LockIo = {
      exists: () => true,
      mkdir: () => {},
      createExclusive: () => {
        throw new Error('non-atomic path must not be used');
      },
      publishExclusive: (file, text) => {
        // The litter sweep removed the temp sibling before the link: nothing published.
        if (lost++ % 2 === 0) throw error('ENOENT');
        if (files.has(file)) throw error('EEXIST');
        files.set(file, { text, mtime: now });
      },
      unlink: (file) => void files.delete(file),
      loadJson: <T>(file: string): T => {
        const cell = files.get(file);
        if (!cell) throw error('ENOENT');
        return JSON.parse(cell.text) as T;
      },
    };
    registerLockIo(io);
    expect(withLockSync(resource, () => 'sync', 50)).toBe('sync');
    expect(await acquireLock(resource, 50)).toBe(true);
    releaseLock(resource);
    expect(files.has(lock)).toBe(false);
    expect(lost).toBe(4);

    // Persistent ENOENT (e.g. an unwritable locks root) still surfaces, bounded.
    io.publishExclusive = () => {
      throw error('ENOENT');
    };
    expect(() => withLockSync(resource, () => 'never', 50)).toThrow('ENOENT');
  });
  it('sweeps old publication temps and dead tombs during reclaim, keeping fresh ones', () => {
    const dir = path.dirname(lock);
    const other = path.join(dir, 'other.lock');
    files.set(other + '.123.0123456789ab.tmp', { text: '', mtime: 0 });
    files.set(other + `.reclaim.stale-${DEAD_PID}-0-1`, { text: '{}', mtime: 0 });
    files.set(other + `.stale-${process.pid}-0-2`, { text: '{}', mtime: 0 }); // live cleaner
    files.set(path.join(dir, 'unrelated.json'), { text: '{}', mtime: 0 });
    now = LOCK_LIVE_GUARD_RECOVERY_AGE_MS * 2;
    files.set(other + '.456.abcdefabcdef.tmp', { text: '', mtime: now }); // fresh
    publish(lock, DEAD_PID);
    expect(withLockSync(resource, () => 'recovered', 50)).toBe('recovered');
    expect([...files.keys()].sort()).toEqual(
      [
        other + '.456.abcdefabcdef.tmp',
        other + `.stale-${process.pid}-0-2`,
        path.join(dir, 'unrelated.json'),
      ].sort()
    );
  });
});

describe('orphan guard mutual-exclusion regression', () => {
  it('does not let competing orphan-guard reclaimers displace cleanup ownership', async () => {
    publish(lock, DEAD_PID);
    publish(lock + '.reclaim', DEAD_PID);
    let nested: Promise<boolean> | undefined;
    let observed = false;
    hooks.read = (file) => {
      if (file !== lock + '.reclaim' || observed) return;
      observed = true;
      nested = acquireLock(resource, 0);
    };
    await expect(acquireLock(resource, 0)).resolves.toBe(false);
    await expect(nested).resolves.toBe(false);
    expect(observed).toBe(true);
    expect(removed).toEqual([]);
    expect(JSON.parse(files.get(lock)!.text).pid).toBe(DEAD_PID);
    expect(JSON.parse(files.get(lock + '.reclaim')!.text).pid).toBe(DEAD_PID);
    expect(now).toBe(0);
  });
});
