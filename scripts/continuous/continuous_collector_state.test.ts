import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync } from '@agent/core/secure-io';
import { continuousProcessContainment } from './continuous_owner_platform.js';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import {
  CollectorNotStarted,
  readCollectorAttempt,
  reconcileCollectorAttempt,
  readCollectorSnapshot,
  recordCollectorStop,
  withCollectorAttempt,
} from './continuous_collector_state.js';

const charter = { scope: { tier: 'public', organization_id: 'org' } } satisfies Pick<
  DotCharter,
  'scope'
>;
const ref = 'pipelines/collector.json';
let root: string;
beforeEach(() => {
  root = pathResolver.sharedTmp('collector-test-' + randomUUID());
  safeMkdir(root, { recursive: true });
});
afterEach(() => safeRmSync(root, { recursive: true, force: true }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('continuous collector attempts', () => {
  it('shares an execution fence between concurrent invocations', async () => {
    const release = deferred();
    const started = deferred();
    const first = withCollectorAttempt(
      root,
      charter,
      ref,
      () => {},
      async () => {
        expect(readCollectorAttempt(root, charter, ref)?.status).toBe('unconfirmed');
        started.resolve();
        await release.promise;
      }
    );
    await started.promise;
    const duplicate = vi.fn(async () => {});
    const second = withCollectorAttempt(root, charter, ref, () => {}, duplicate);
    const settled = Promise.allSettled([first, second]);
    release.resolve();
    expect((await settled).map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(duplicate).not.toHaveBeenCalled();
    expect(readCollectorAttempt(root, charter, ref)?.status).toBe('completed');
  });

  it('captures the snapshot while excluding another attempt and reserves the journal ID before launch', async () => {
    const capture = vi.fn();
    let overlapping: Promise<unknown> | undefined;
    const other = vi.fn(async () => {});
    await withCollectorAttempt(
      root,
      charter,
      ref,
      () => {},
      async (id) => {
        expect(readCollectorAttempt(root, charter, ref)).toMatchObject({
          attempt_id: id,
          pipeline_run_id: id,
        });
      },
      () => {
        overlapping = withCollectorAttempt(root, charter, ref, () => {}, other);
        capture();
      }
    );
    await overlapping;
    expect(other).toHaveBeenCalledOnce();
    expect(capture.mock.invocationCallOrder[0]).toBeLessThan(other.mock.invocationCallOrder[0]);
    const preview = vi.fn();
    await readCollectorSnapshot(root, charter, ref, preview);
    expect(preview).toHaveBeenCalledOnce();
  });

  it('retries a proven pre-effect failure without reconciliation', async () => {
    await expect(
      withCollectorAttempt(
        root,
        charter,
        ref,
        () => {},
        async () => {
          throw new CollectorNotStarted('worker_missing');
        }
      )
    ).rejects.toThrow('check the collector worker');
    const previous = readCollectorAttempt(root, charter, ref);
    expect(previous).toMatchObject({ status: 'not_started', reason_code: 'worker_missing' });
    const run = vi.fn(async () => {});
    await withCollectorAttempt(root, charter, ref, () => {}, run);
    expect(run).toHaveBeenCalledOnce();
    expect(readCollectorAttempt(root, charter, ref)?.attempt_id).not.toBe(previous?.attempt_id);
  });

  it('persists completion even if authority is revoked before observation capture', async () => {
    let active = true;
    const capture = vi.fn();
    await expect(
      withCollectorAttempt(
        root,
        charter,
        ref,
        () => {
          if (!active) throw new Error('authorization withdrawn');
        },
        async () => {
          active = false;
        },
        capture
      )
    ).rejects.toThrow('authorization withdrawn');
    expect(readCollectorAttempt(root, charter, ref)?.status).toBe('completed');
    expect(capture).not.toHaveBeenCalled();
  });

  it('does not re-probe a stopped process when its numeric identity becomes live again', async () => {
    const group = continuousProcessContainment(2468, true);
    const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -group.pid && signal === 0)
        throw Object.assign(new Error('group absent'), { code: 'ESRCH' });
      return true;
    });
    try {
      await withCollectorAttempt(
        root,
        charter,
        ref,
        () => {},
        async (_id, register) => register(group)
      );
      expect(readCollectorAttempt(root, charter, ref)).toMatchObject({
        status: 'completed',
        stop_confirmed_at: expect.any(String),
      });
      probe.mockClear().mockReturnValue(true);
      const capture = vi.fn();
      await readCollectorSnapshot(root, charter, ref, capture);
      const run = vi.fn(async () => {});
      await withCollectorAttempt(root, charter, ref, () => {}, run);
      expect(probe).not.toHaveBeenCalledWith(-group.pid, 0);
      expect(capture).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledOnce();
    } finally {
      probe.mockRestore();
    }
  });

  it('keeps an orphaned process group held until a same-host probe confirms it stopped', async () => {
    const group = continuousProcessContainment(2468, true);
    await expect(
      withCollectorAttempt(
        root,
        charter,
        ref,
        () => {},
        async (_id, register) => {
          register(group);
          throw new Error('parent stopped waiting');
        }
      )
    ).rejects.toThrow('no confirmed result');
    const attempt = readCollectorAttempt(root, charter, ref)!;
    expect(attempt.containment).toEqual(group);
    const approve = vi.fn((commit: () => void) => commit());
    const probe = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const reconcile = () =>
        reconcileCollectorAttempt(
          root,
          charter,
          ref,
          attempt.attempt_id,
          'receipt',
          'approval',
          approve
        );
      await expect(reconcile()).rejects.toThrow('Cannot confirm');
      expect(probe).toHaveBeenCalledWith(-group.pid, 0);
      expect(approve).not.toHaveBeenCalled();
      probe.mockImplementation((pid, signal) => {
        if (pid === -group.pid && signal === 0)
          throw Object.assign(new Error('group absent'), { code: 'ESRCH' });
        return true;
      });
      await recordCollectorStop(root, charter, ref, attempt.attempt_id);
      const stopped = readCollectorAttempt(root, charter, ref);
      expect(stopped).toMatchObject({
        status: 'unconfirmed',
        stop_confirmed_at: expect.any(String),
      });
      expect(approve).not.toHaveBeenCalled();
      await expect(
        withCollectorAttempt(
          root,
          charter,
          ref,
          () => {},
          async () => {}
        )
      ).rejects.toThrow('requires reconciliation');
      probe.mockClear().mockReturnValue(true);
      await reconcile();
      expect(probe).not.toHaveBeenCalledWith(-group.pid, 0);
      expect(approve).toHaveBeenCalledOnce();
      expect(readCollectorAttempt(root, charter, ref)).toMatchObject({
        status: 'reconciled',
        stop_confirmed_at: expect.any(String),
      });
      probe.mockClear().mockReturnValue(true);
      await withCollectorAttempt(
        root,
        charter,
        ref,
        () => {},
        async () => {}
      );
      expect(probe).not.toHaveBeenCalledWith(-group.pid, 0);
    } finally {
      probe.mockRestore();
    }
  });

  it('holds failed effects until the exact attempt is reconciled under approval', async () => {
    const failed = vi.fn(async () => {
      throw new Error('failure after effects');
    });
    await expect(withCollectorAttempt(root, charter, ref, () => {}, failed)).rejects.toThrow(
      'no confirmed result'
    );
    const attempt = readCollectorAttempt(root, charter, ref)!;
    expect(attempt.status).toBe('unconfirmed');
    await expect(withCollectorAttempt(root, charter, ref, () => {}, failed)).rejects.toThrow(
      'requires reconciliation'
    );
    expect(failed).toHaveBeenCalledTimes(1);
    const approve = vi.fn((commit: () => void) => commit());
    await expect(
      reconcileCollectorAttempt(root, charter, ref, 'wrong-attempt', 'receipt', 'approval', approve)
    ).rejects.toThrow('no longer awaiting reconciliation');
    expect(approve).not.toHaveBeenCalled();
    await expect(
      reconcileCollectorAttempt(
        root,
        charter,
        ref,
        attempt.attempt_id,
        'receipt',
        'approval',
        () => {
          throw new Error('denied');
        }
      )
    ).rejects.toThrow('denied');
    expect(readCollectorAttempt(root, charter, ref)?.status).toBe('unconfirmed');
    await reconcileCollectorAttempt(
      root,
      charter,
      ref,
      attempt.attempt_id,
      'receipt',
      'approval',
      approve
    );
    expect(readCollectorAttempt(root, charter, ref)).toMatchObject({
      status: 'reconciled',
      reconciliation: { evidence: 'receipt', approval_id: 'approval' },
    });
    await withCollectorAttempt(
      root,
      charter,
      ref,
      () => {},
      async () => {}
    );
    expect(readCollectorAttempt(root, charter, ref)).toMatchObject({ status: 'completed' });
    expect(readCollectorAttempt(root, charter, ref)?.attempt_id).not.toBe(attempt.attempt_id);
  });
});
