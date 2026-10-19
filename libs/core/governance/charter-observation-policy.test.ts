import { describe, expect, it } from 'vitest';
import { compileSchema } from '../foundation/ajv.js';
import { pathResolver } from '../path-resolver.js';
import { loadCharterObservationPolicy } from './charter-decision-vocabulary.js';
import { shouldSampleCharterAudit } from './approval-gate-charter.js';

describe('charter observation policy', () => {
  const validate = compileSchema(
    pathResolver.knowledge('product/schemas/charter-observation-policy.schema.json')
  );

  it('loads the governed defaults and uses them for deterministic sampling', () => {
    const policy = loadCharterObservationPolicy();
    expect(policy.audit_sample_rate).toBe(0.05);
    expect(validate(policy)).toBe(true);
    for (const id of ['one', 'two', 'three']) {
      expect(shouldSampleCharterAudit(id)).toBe(
        shouldSampleCharterAudit(id, policy.audit_sample_rate)
      );
    }
  });

  it.each([
    { audit_sample_rate: -1 },
    { audit_sample_rate: 2 },
    { repeated_denial_threshold: 0 },
    { repeated_denial_threshold: 1.5 },
    { frequent_denial_threshold: 0 },
    { grants_authority: true },
  ])('rejects invalid observation settings %j', (override) => {
    expect(validate({ ...loadCharterObservationPolicy(), ...override })).toBe(false);
  });
});
