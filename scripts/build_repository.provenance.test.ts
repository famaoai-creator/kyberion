import { describe, expect, it, vi } from 'vitest';
import {
  buildRepository,
  type BuildDependencies,
  type BuildInputSnapshot,
} from './build_repository.js';
import type { BuildGenerationReceipt } from '@agent/core/build-generation';

/**
 * R12 provenance: a completed-generation receipt is published only when the
 * existing readiness checks pass AND the compiler input set stayed stable
 * across the build. Mixed generations are never recorded as fresh.
 */
function provenanceDeps(overrides: Partial<BuildDependencies> = {}) {
  const records: unknown[] = [];
  const receipts: BuildGenerationReceipt[] = [];
  const deps: BuildDependencies = {
    run: vi.fn(async () => {}),
    clean: vi.fn(),
    readiness: async () => true,
    record: vi.fn((attempt) => {
      records.push(attempt);
    }),
    lock: async (build) => build(),
    snapshotInputs: vi.fn(async () => snapshot('src-a', 'cfg-a')),
    publishReceipt: vi.fn((receipt) => {
      receipts.push(receipt);
    }),
    ...overrides,
  };
  return { deps, records, receipts };
}

function snapshot(sourceHash: string, configHash: string): BuildInputSnapshot {
  return { sourceHash, configHash, fileCount: 1, takenAt: '2026-10-31T00:00:00.000Z' };
}

function seq(...snapshots: BuildInputSnapshot[]): () => Promise<BuildInputSnapshot> {
  const queue = [...snapshots];
  return async () => {
    const next = queue.shift();
    if (!next) throw new Error('snapshot sequence exhausted');
    return next;
  };
}

describe('build generation provenance', () => {
  it('publishes a completed-generation receipt when readiness passes and inputs are stable', async () => {
    const { deps, records, receipts } = provenanceDeps();
    await buildRepository('repo', deps);

    expect(deps.snapshotInputs).toHaveBeenCalledTimes(2);
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      mode: 'repo',
      result: 'completed',
      inputFingerprint: 'src-a',
      configFingerprint: 'cfg-a',
      inputStability: 'stable_observed',
    });
    expect(receipt.toolVersions.node).toBe(process.version);
    // The receipt names the same generation the recovery record does.
    expect(receipt.generationId).toBe((records[0] as { id: string }).id);
    expect(records[0]).toMatchObject({ passed: true, restored: true });
  });

  it('never publishes a receipt for a build whose inputs changed mid-run', async () => {
    const { deps, records, receipts } = provenanceDeps({
      snapshotInputs: vi.fn(seq(snapshot('src-a', 'cfg-a'), snapshot('src-b', 'cfg-a'))),
    });
    await buildRepository('repo', deps);

    expect(receipts).toEqual([]);
    expect(records[0]).toMatchObject({
      passed: true,
      restored: false,
      reason: expect.stringContaining('changed during the build'),
    });
  });

  it('treats a config/lockfile change during the build as a generation change', async () => {
    const { deps, receipts } = provenanceDeps({
      snapshotInputs: vi.fn(seq(snapshot('src-a', 'cfg-a'), snapshot('src-a', 'cfg-b'))),
    });
    await buildRepository('repo', deps);
    expect(receipts).toEqual([]);
  });

  it('does not publish when readiness fails even with stable inputs', async () => {
    const { deps, records, receipts } = provenanceDeps({ readiness: async () => false });
    await buildRepository('packages', deps);

    expect(receipts).toEqual([]);
    expect(records[0]).toMatchObject({ passed: true, restored: false });
  });

  it('keeps the last good receipt when input stability is unverifiable', async () => {
    const { deps, records, receipts } = provenanceDeps({
      snapshotInputs: vi.fn(async () => {
        throw new Error('walk failed');
      }),
    });
    await buildRepository('repo', deps);

    expect(receipts).toEqual([]);
    // Readiness still passed, so the L2 verdict is not downgraded — only the
    // freshness *evidence* is withheld.
    expect(records[0]).toMatchObject({ passed: true, restored: true });
  });

  it('never publishes a receipt for a failed or aborted build', async () => {
    const { deps, records, receipts } = provenanceDeps({
      run: vi.fn(async () => {
        throw new Error('tsc failure');
      }),
    });
    await expect(buildRepository('packages', deps)).rejects.toThrow('tsc failure');

    expect(receipts).toEqual([]);
    expect(records[0]).toMatchObject({ passed: false, reason: 'tsc failure' });
  });

  it('does not fail the build when receipt publication fails', async () => {
    const { deps, records } = provenanceDeps({
      publishReceipt: () => {
        throw new Error('disk full');
      },
    });
    await buildRepository('repo', deps);
    expect(records[0]).toMatchObject({ passed: true, restored: true });
  });
});
