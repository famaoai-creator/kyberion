import { describe, expect, it } from 'vitest';
import { pipelinePayloadTrainingUse } from './pipeline-execution-part-results.js';

describe('pipeline payload training_use', () => {
  it('declares a posture for every mission tier instead of an implied local_only', () => {
    // Confidential mission material may reach a tenant-attested no-training provider;
    // the egress gate still requires that attestation.
    expect(pipelinePayloadTrainingUse('confidential')).toBe('no_training');
    // Personal material never leaves this host.
    expect(pipelinePayloadTrainingUse('personal')).toBe('local_only');
    expect(pipelinePayloadTrainingUse('public')).toBe('training_eligible');
  });
});
