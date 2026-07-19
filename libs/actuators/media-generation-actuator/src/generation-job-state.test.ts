import { describe, expect, it } from 'vitest';
import type { GenerationJob } from '@agent/core';
import { canTransitionGenerationJob, transitionGenerationJob } from './generation-job-state.js';

const job: GenerationJob = {
  kind: 'generation-job',
  job_id: 'genjob-state-test',
  action: 'generate_image',
  status: 'submitted',
  request: { prompt: 'test' },
  created_at: '2026-07-20T00:00:00.000Z',
};

describe('generation job state machine', () => {
  it('allows governed lifecycle transitions', () => {
    expect(canTransitionGenerationJob('submitted', 'running')).toBe(true);
    expect(canTransitionGenerationJob('running', 'succeeded')).toBe(true);
    expect(canTransitionGenerationJob('failed', 'retrying')).toBe(true);
    expect(canTransitionGenerationJob('retrying', 'submitted')).toBe(true);
  });

  it('rejects transitions out of terminal states', () => {
    expect(() => transitionGenerationJob({ ...job, status: 'succeeded' }, 'running')).toThrow(
      'Invalid generation job transition'
    );
    expect(() => transitionGenerationJob({ ...job, status: 'timed_out' }, 'running')).toThrow(
      'Invalid generation job transition'
    );
  });
});
