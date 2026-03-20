import { describe, expect, it } from 'vitest';
import {
  validateCapabilityInput,
  validateCapabilityOutput,
  validateInput,
  validateOutput,
} from '@agent/core/validate';

describe('Capability schema contract', () => {
  it('accepts capability-first envelopes', () => {
    expect(validateCapabilityInput({ capability: 'file-actuator', action: 'read' }).valid).toBe(true);
    expect(validateCapabilityOutput({ capability: 'file-actuator', status: 'success' }).valid).toBe(true);
  });

  it('keeps legacy skill aliases valid for backward compatibility', () => {
    expect(validateInput({ skill: 'legacy-skill', action: 'run' }).valid).toBe(true);
    expect(validateOutput({ skill: 'legacy-skill', status: 'success' }).valid).toBe(true);
  });

  it('rejects envelopes missing both capability and skill identifiers', () => {
    expect(validateCapabilityInput({ action: 'read' }).valid).toBe(false);
    expect(validateCapabilityOutput({ status: 'success' }).valid).toBe(false);
  });
});
