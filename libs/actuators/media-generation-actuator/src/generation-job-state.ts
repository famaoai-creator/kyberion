import type { GenerationJob } from '@agent/core';

export type GenerationJobStatus = GenerationJob['status'];

const ALLOWED_TRANSITIONS: Record<GenerationJobStatus, readonly GenerationJobStatus[]> = {
  submitted: ['running', 'succeeded', 'failed', 'canceled'],
  running: ['succeeded', 'failed', 'canceled'],
  succeeded: [],
  failed: ['retrying'],
  retrying: ['submitted', 'canceled'],
  canceled: [],
  timed_out: [],
};

export function canTransitionGenerationJob(
  from: GenerationJobStatus,
  to: GenerationJobStatus
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionGenerationJob(
  job: GenerationJob,
  status: GenerationJobStatus,
  fields: Partial<GenerationJob> = {}
): GenerationJob {
  if (!canTransitionGenerationJob(job.status, status)) {
    throw new Error(`Invalid generation job transition: ${job.status} -> ${status}`);
  }
  return { ...job, ...fields, status };
}

export { ALLOWED_TRANSITIONS };
