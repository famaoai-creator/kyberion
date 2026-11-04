import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerComputeDriver,
  resolveDefaultComputeProvider,
  resolveDriverForJob,
  type ComputeDriver,
  type ComputeJobState,
} from './compute-driver.js';
import { handleAction } from './compute-actuator-helpers.js';
import './local-compute-driver.js';
import './colab-compute-driver.js';

function fakeDriver(providerId: string): ComputeDriver {
  const state = (jobId: string, status: ComputeJobState['status']): ComputeJobState => ({
    job_id: jobId,
    provider: providerId,
    status,
  });
  return {
    providerId,
    ownsJob: () => false,
    submitJob: async (spec) => state(spec.job_id, 'completed'),
    pollStatus: async (jobId) => state(jobId, 'completed'),
    collectArtifact: async (_jobId, destination) => ({ collected: [], destination }),
    cancelJob: async (jobId) => state(jobId, 'cancelled'),
  };
}

describe('compute-execution-provider saved default', () => {
  const unregister: Array<() => void> = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    while (unregister.length > 0) unregister.pop()!();
  });

  it('defaults to the policy provider (local) when nothing is saved', () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', '');
    expect(resolveDefaultComputeProvider()).toBe('local');
    expect(resolveDriverForJob('unowned-job').providerId).toBe('local');
  });

  it('routes a submit without provider to the saved default', async () => {
    unregister.push(registerComputeDriver(fakeDriver('fakesaved')));
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'compute-execution-provider=fakesaved');
    expect(resolveDefaultComputeProvider()).toBe('fakesaved');
    const result = (await handleAction('submit_job', {
      job_id: 'saved-default-job-01',
    })) as ComputeJobState;
    expect(result.provider).toBe('fakesaved');
  });

  it('keeps an explicit provider over the saved default', async () => {
    unregister.push(registerComputeDriver(fakeDriver('fakesaved')));
    unregister.push(registerComputeDriver(fakeDriver('fakeexplicit')));
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'compute-execution-provider=fakesaved');
    const result = (await handleAction('submit_job', {
      job_id: 'saved-default-job-02',
      provider: 'fakeexplicit',
    })) as ComputeJobState;
    expect(result.provider).toBe('fakeexplicit');
  });

  it('falls back to the policy default when the saved provider is not registered', () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'compute-execution-provider=notregistered');
    expect(resolveDefaultComputeProvider()).toBe('local');
    expect(resolveDriverForJob('unowned-job').providerId).toBe('local');
  });
});
