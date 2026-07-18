import { describe, expect, it, vi } from 'vitest';
import { cancelJob, isTerminalJobStatus, waitForJob } from './job-lifecycle.js';

describe('job-lifecycle', () => {
  it('recognizes the shared terminal status vocabulary', () => {
    expect(isTerminalJobStatus('succeeded')).toBe(true);
    expect(isTerminalJobStatus('cancelled')).toBe(true);
    expect(isTerminalJobStatus('running')).toBe(false);
  });

  it('polls until a job reaches a terminal state', async () => {
    let attempts = 0;
    const result = await waitForJob({
      getStatus: async () => ({ status: ++attempts > 1 ? 'completed' : 'running' }),
      timeoutMs: 100,
      pollIntervalMs: 1,
    });
    expect(result.status).toBe('completed');
    expect(result.value.status).toBe('completed');
  });

  it('treats not_found as terminal and supports cancellation polling', async () => {
    expect(isTerminalJobStatus('not_found')).toBe(true);
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ status: 'cancelled' });
    const cancel = vi.fn().mockResolvedValue(undefined);

    const result = await cancelJob({
      cancel,
      getStatus,
      timeoutMs: 100,
      pollIntervalMs: 1,
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(result.value).toEqual({ status: 'cancelled' });
    expect(result.status).toBe('completed');
  });
});
