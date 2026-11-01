import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const moveFault = vi.hoisted(() => ({ on: false, failures: 0 }));

vi.mock('./secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secure-io.js')>();
  return {
    ...actual,
    safeMoveSync: (src: string, dest: string): void => {
      if (moveFault.on && src.includes('.rotate-')) {
        moveFault.failures++;
        throw new Error('injected rename failure');
      }
      actual.safeMoveSync(src, dest);
    },
  };
});

import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  safeStat,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';
import { TriggerRunner, resetTriggerStoreWindowFullState } from './trigger-runner.js';

/**
 * MSN-STORE-BOUNDS-20261101 review R2: inline rotation of the trigger journal
 * moves only the dropped records to the segment, scales its minimum gain with
 * the journal size, and remembers failed attempts.
 */
describe('trigger journal inline rotation', () => {
  const authority = { authority_role: 'chronos_gateway', level: 40, tenant_slug: 'common' };
  const day = 24 * 60 * 60 * 1000;
  const stores: string[] = [];

  afterEach(() => {
    moveFault.on = false;
    moveFault.failures = 0;
    for (const store of stores.splice(0)) {
      for (const file of siblings(store)) safeUnlinkSync(file);
      if (safeExistsSync(store)) safeUnlinkSync(store);
    }
  });

  function newStore(label: string): string {
    resetTriggerStoreWindowFullState();
    const store = pathResolver.sharedTmp(`qm02-${label}-${randomUUID()}.jsonl`);
    stores.push(store);
    return store;
  }

  /** Every file next to the store that shares its stem (segments and temp files). */
  function siblings(store: string): string[] {
    const stem = path.basename(store).replace(/\.jsonl$/u, '');
    return safeReaddir(path.dirname(store))
      .filter((name) => name.startsWith(stem) && name !== path.basename(store))
      .map((name) => path.join(path.dirname(store), name));
  }

  function segments(store: string): string[] {
    return siblings(store).filter((file) => /-\d{8}-\d{6}(-\d+)?\.jsonl$/u.test(file));
  }

  function journalLine(key: string, recordedAt: string, source = 'cron'): string {
    return JSON.stringify({
      idempotencyKey: key,
      source,
      status: 'delivered',
      deliveryId: key,
      createdBy: authority,
      requestedAuthority: authority,
      recordedAt,
    });
  }

  function lines(file: string): string[] {
    return String(safeReadFile(file, { encoding: 'utf8' }))
      .split('\n')
      .filter((line) => line.trim());
  }

  function runnerAt(store: string, now: Date): TriggerRunner {
    return new TriggerRunner({
      storePath: store,
      maxStoreBytes: 64 * 1024,
      authorityResolver: (snapshot) => snapshot,
      now: () => now,
    });
  }

  const wake = (key: string) => ({
    idempotencyKey: key,
    source: 'wake' as const,
    createdBy: authority,
  });

  it('writes only the dropped records to the segment: segment + live equals the old journal', async () => {
    const store = newStore('split');
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const original = [
      journalLine('cron:stale:2026-09-01T00:00', ago(30 * day)),
      journalLine('reflex:keep', ago(day), 'wake'),
      // Superseded by the later record of the same key.
      journalLine('wake:twice', ago(2 * day), 'wake'),
      ...Array.from({ length: 600 }, (_, i) =>
        journalLine(`cron:old-${i}:2026-09-01T00:00`, ago(20 * day))
      ),
      journalLine('wake:twice', ago(day), 'wake'),
    ];
    safeWriteFile(store, `${original.join('\n')}\n`);

    await runnerAt(store, now).run(wake('wake:rotate-now'), async () => 'd');

    const [segment] = segments(store);
    expect(segments(store)).toHaveLength(1);
    const segmentLines = lines(segment);
    const live = lines(store);
    // Lines appended by this run (claim + receipt) are not part of the old journal.
    const oldLive = live.filter((line) => !line.includes('wake:rotate-now'));
    expect([...segmentLines, ...oldLive].sort()).toEqual([...original].sort());
    expect(oldLive).toEqual([original[1], original[original.length - 1]]);
    expect(segmentLines).not.toContain(original[1]);
    // No temp file is left behind.
    expect(siblings(store).filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('skips a rotation that would free less than half of a large journal', async () => {
    const store = newStore('half');
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    // ~100KB of stable keys inside the window (window full at a 64KB threshold)
    // plus ~40KB of aged-out receipts: more than a quarter of the threshold is
    // freeable, but far less than half the journal.
    const window = Array.from({ length: 300 }, (_, i) =>
      journalLine(`continuous-owner:act-${i}`, ago(60_000), 'wake')
    );
    const aged = Array.from({ length: 160 }, (_, i) =>
      journalLine(`cron:aged-${i}:2026-09-01T00:00`, ago(30 * day))
    );
    safeWriteFile(store, `${[...aged, ...window].join('\n')}\n`);
    const before = safeStat(store).size;
    const agedBytes = aged.reduce((sum, line) => sum + line.length + 1, 0);
    expect(agedBytes).toBeGreaterThan(16 * 1024);
    expect(agedBytes).toBeLessThan(before / 2);

    const receipt = await runnerAt(store, now).run(wake('wake:append'), async () => 'd');
    expect(receipt.status).toBe('delivered');
    expect(segments(store)).toHaveLength(0);
    expect(lines(store)[0]).toBe(aged[0]);
  });

  it('records a failed rotation so the next append does not re-copy the journal', async () => {
    const store = newStore('fail');
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const original = Array.from({ length: 600 }, (_, i) =>
      journalLine(`cron:old-${i}:2026-09-01T00:00`, ago(20 * day))
    );
    safeWriteFile(store, `${original.join('\n')}\n`);
    moveFault.on = true;

    const first = await runnerAt(store, now).run(wake('wake:a'), async () => 'd');
    expect(first.status).toBe('delivered');
    expect(moveFault.failures).toBe(1);
    // Nothing was lost and no partial output was left behind.
    expect(lines(store).slice(0, original.length)).toEqual(original);
    expect(siblings(store)).toEqual([]);

    // Same size class, same hour: the failed attempt is remembered.
    await runnerAt(store, new Date(now.getTime() + 60_000)).run(wake('wake:b'), async () => 'd');
    expect(moveFault.failures).toBe(1);

    // An hour later it retries (and succeeds once the fault is gone).
    moveFault.on = false;
    await runnerAt(store, new Date(now.getTime() + 61 * 60_000)).run(
      wake('wake:c'),
      async () => 'd'
    );
    expect(segments(store)).toHaveLength(1);
  });
});
