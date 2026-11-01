import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendOnlyStoreLockId } from './append-only-store.js';
import {
  planCompactionCopyRecovery,
  recoverCompactionCopies,
  resolveRecoveryStorePath,
  STALE_COMPACTION_COPY_MS,
  WRITER_COMPACTION_LOCKS,
} from './compaction-copy-recovery.js';
import { withLockSync } from './foundation/lock-utils.js';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';

const ROOT_REL = `active/shared/tmp/compaction-copy-recovery-${process.pid}`;
const STORE_REL = `${ROOT_REL}/queue/items.jsonl`;
const location = { roots: [ROOT_REL] };
const store = pathResolver.rootResolve(STORE_REL);
const copyA = `${STORE_REL}.compacting-t000000000000001-000000-1-initial`;
const copyB = `${STORE_REL}.compacting-t000000000000002-000000-1-merge-0`;
const later = (): Date => new Date(Date.now() + STALE_COMPACTION_COPY_MS + 60_000);

let audits: Array<Record<string, unknown>> = [];

function write(rel: string, lines: string[]): void {
  safeWriteFile(pathResolver.rootResolve(rel), lines.map((line) => `${line}\n`).join(''));
}

function read(rel: string): string[] {
  const file = pathResolver.rootResolve(rel);
  if (!safeExistsSync(file)) return [];
  return String(safeReadFile(file, { encoding: 'utf8' }))
    .split('\n')
    .filter(Boolean);
}

function copiesOnDisk(): string[] {
  return safeReaddir(path.dirname(store)).filter((name) => name.includes('.compacting-'));
}

beforeEach(() => {
  audits = [];
  safeRmSync(pathResolver.rootResolve(ROOT_REL), { recursive: true, force: true });
  safeMkdir(path.dirname(store), { recursive: true });
});

afterEach(() => {
  safeRmSync(pathResolver.rootResolve(ROOT_REL), { recursive: true, force: true });
});

describe('compaction-copy recovery', () => {
  it('dry-run plans each store with its copies (park order), sizes and the action', () => {
    write(copyB, ['{"id":"b"}']);
    write(copyA, ['{"id":"a"}', '{"id":"a2"}']);
    write(STORE_REL, ['{"id":"live"}']);
    const now = later();
    const [plan, ...rest] = planCompactionCopyRecovery({ ...location, now });
    expect(rest).toEqual([]);
    expect(plan).toMatchObject({
      store: STORE_REL,
      live_bytes: '{"id":"live"}\n'.length,
      action: 'merge',
    });
    expect(plan!.copies.map((copy) => [copy.path, copy.size_bytes, copy.stale])).toEqual([
      [copyA, '{"id":"a"}\n{"id":"a2"}\n'.length, true],
      [copyB, '{"id":"b"}\n'.length, true],
    ]);
    expect(plan!.detail).toContain('merge 2 copy(ies)');
    // A dry run changes nothing.
    expect(copiesOnDisk()).toHaveLength(2);
    expect(read(STORE_REL)).toEqual(['{"id":"live"}']);
    // --path narrows to one store.
    expect(planCompactionCopyRecovery({ ...location, storePath: STORE_REL, now })).toEqual([plan]);
  });

  it('merges copies then the live file in order, drops cross-file duplicates and removes the copies', () => {
    write(copyA, ['{"id":1}', '{"id":2}', '{"id":2}']);
    // The failed rewrite published a result overlapping the copies.
    write(copyB, ['{"id":2}', '{"id":3}']);
    write(STORE_REL, ['{"id":1}', '{"id":3}', '{"id":4}']);
    const result = recoverCompactionCopies(STORE_REL, [copyB, copyA], {
      ...location,
      now: later(),
      audit: (record) => audits.push(record),
    });
    expect(result).toMatchObject({ outcome: 'merged', duplicates_dropped: 3, after_lines: 5 });
    // Repeats inside one file stay; a line identical to one from an earlier file goes.
    expect(read(STORE_REL)).toEqual(['{"id":1}', '{"id":2}', '{"id":2}', '{"id":3}', '{"id":4}']);
    expect(copiesOnDisk()).toEqual([]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      event: 'RETENTION_RECOVER',
      path: STORE_REL,
      copies: [copyA, copyB],
      duplicates_dropped: 3,
      published: true,
    });
  });

  it('recreates the live store from the copies when it is missing', () => {
    write(copyA, ['{"id":"a"}']);
    const result = recoverCompactionCopies(STORE_REL, [copyA], {
      ...location,
      now: later(),
      audit: (record) => audits.push(record),
    });
    expect(result.outcome).toBe('merged');
    expect(read(STORE_REL)).toEqual(['{"id":"a"}']);
    expect(copiesOnDisk()).toEqual([]);
  });

  it('refuses a store with a copy younger than the stale threshold', () => {
    write(copyA, ['{"id":"a"}']);
    write(STORE_REL, ['{"id":"live"}']);
    const [plan] = planCompactionCopyRecovery({ ...location });
    expect(plan).toMatchObject({ action: 'refuse' });
    expect(plan!.detail).toMatch(/younger than 60 minutes/);
    const result = recoverCompactionCopies(STORE_REL, [copyA], {
      ...location,
      audit: (record) => audits.push(record),
    });
    expect(result.outcome).toBe('refused');
    expect(copiesOnDisk()).toHaveLength(1);
    expect(read(STORE_REL)).toEqual(['{"id":"live"}']);
    expect(audits).toEqual([]);
  });

  it('refuses when the copy set differs from the approved one', () => {
    write(copyA, ['{"id":"a"}']);
    write(copyB, ['{"id":"b"}']);
    const result = recoverCompactionCopies(STORE_REL, [copyA], {
      ...location,
      now: later(),
      audit: (record) => audits.push(record),
    });
    expect(result.outcome).toBe('changed');
    expect(copiesOnDisk()).toHaveLength(2);
    expect(audits).toEqual([]);
  });

  it('waits for the store lock write-time maintenance takes', () => {
    write(copyA, ['{"id":"a"}']);
    write(STORE_REL, ['{"id":"live"}']);
    withLockSync(appendOnlyStoreLockId(store), () => {
      expect(() =>
        recoverCompactionCopies(STORE_REL, [copyA], {
          ...location,
          now: later(),
          lockTimeoutMs: 1,
          audit: (record) => audits.push(record),
        })
      ).toThrow(/LOCK_TIMEOUT/);
    });
    expect(copiesOnDisk()).toHaveLength(1);
    expect(read(STORE_REL)).toEqual(['{"id":"live"}']);
  });

  it("waits for the dot wake ledger's own compaction lock", () => {
    const fixture = { rootDir: pathResolver.rootResolve(`${ROOT_REL}/fixture`) };
    const dotRel = 'active/shared/runtime/dot-wake-ledger.jsonl';
    const fixtureLocation = { ...fixture, roots: ['active/shared/runtime'] };
    const dotCopy = `${dotRel}.compacting-t000000000000001-000000-1-initial`;
    const inFixture = (rel: string) => `${ROOT_REL}/fixture/${rel}`;
    safeMkdir(path.dirname(pathResolver.rootResolve(inFixture(dotRel))), { recursive: true });
    write(inFixture(dotCopy), ['{"id":"old"}']);
    write(inFixture(dotRel), ['{"id":"live"}']);
    expect(WRITER_COMPACTION_LOCKS[dotRel]).toBe('dot-wake-ledger-compact');
    withLockSync('dot-wake-ledger-compact', () => {
      expect(() =>
        recoverCompactionCopies(dotRel, [dotCopy], {
          ...fixtureLocation,
          now: later(),
          lockTimeoutMs: 1,
          audit: (record) => audits.push(record),
        })
      ).toThrow(/LOCK_TIMEOUT.*dot-wake-ledger-compact/);
    });
    expect(read(inFixture(dotCopy))).toEqual(['{"id":"old"}']);
    // Released: the merge runs.
    expect(
      recoverCompactionCopies(dotRel, [dotCopy], {
        ...fixtureLocation,
        now: later(),
        audit: (record) => audits.push(record),
      }).outcome
    ).toBe('merged');
    expect(read(inFixture(dotRel))).toEqual(['{"id":"old"}', '{"id":"live"}']);
  });

  it('refuses --path outside the store roots or naming a copy', () => {
    for (const bad of [
      'knowledge/product/governance/ci-gates.json',
      `${ROOT_REL}/queue/items.json`,
      copyA,
      'active/shared/other/items.jsonl',
      `${ROOT_REL}/../escape.jsonl`,
    ]) {
      expect(() => resolveRecoveryStorePath(bad, location), bad).toThrow(
        /--path must be a \.jsonl store/
      );
    }
    expect(resolveRecoveryStorePath(STORE_REL, location)).toBe(store);
  });
});
