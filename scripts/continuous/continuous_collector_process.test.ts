import { describe, expect, it, vi } from 'vitest';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import { COLLECTOR_NOT_STARTED_EXIT, CollectorNotStarted } from './continuous_collector_state.js';
import { runContinuousCollectorProcess } from './continuous_collector_process.js';

describe('continuous collector process', () => {
  it.each([COLLECTOR_NOT_STARTED_EXIT, 1])('classifies worker exit %s', async (status) => {
    const charter = { scope: { tier: 'public', organization_id: 'org' } } as DotCharter;
    const execution = runContinuousCollectorProcess(
      'pipelines/collector.json',
      charter,
      Date.now() + 2_000,
      '/repo',
      async () => ({ status, stdout: '', stderr: '' }),
      undefined,
      '00000000-0000-4000-8000-000000000001'
    );
    const error: unknown = await execution.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof CollectorNotStarted).toBe(status === COLLECTOR_NOT_STARTED_EXIT);
  });

  it('recognizes a failed OS spawn without treating an unknown process exit as safe', async () => {
    const charter = { scope: { tier: 'public', organization_id: 'org' } } as DotCharter;
    const stopped = { status: null, stdout: '', stderr: '', error: new Error('spawn denied') };
    const launch = (notSpawned?: true) =>
      runContinuousCollectorProcess(
        'pipelines/collector.json',
        charter,
        Date.now() + 2_000,
        '/repo',
        async () => ({ ...stopped, notSpawned }),
        undefined,
        '00000000-0000-4000-8000-000000000001'
      );
    await expect(launch(true)).rejects.toBeInstanceOf(CollectorNotStarted);
    await expect(launch()).rejects.not.toBeInstanceOf(CollectorNotStarted);
  });

  it('aborts the managed process after execution authority is withdrawn', async () => {
    vi.useFakeTimers();
    try {
      let revoked = false;
      const charter = { scope: { tier: 'public', organization_id: 'org' } } as DotCharter;
      const execution = runContinuousCollectorProcess(
        'pipelines/collector.json',
        charter,
        Date.now() + 2_000,
        '/repo',
        (_command, _args, options) =>
          new Promise((resolve) => {
            options.signal?.addEventListener('abort', () =>
              resolve({ stdout: '', stderr: '', status: null })
            );
          }),
        () => {
          if (revoked) throw new Error('charter revoked');
        },
        '00000000-0000-4000-8000-000000000001'
      );
      const outcome = expect(execution).rejects.toThrow('interrupted');
      revoked = true;
      await vi.advanceTimersByTimeAsync(500);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });
});
