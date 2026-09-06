import { describe, expect, it } from 'vitest';
import { findIntentOutcomePattern, loadIntentOutcomePatterns } from './intent-outcome-patterns.js';

describe('intent-outcome-patterns', () => {
  it('loads and validates the complete governed catalog', () => {
    const patterns = loadIntentOutcomePatterns();

    expect(patterns).toHaveLength(34);
    expect(patterns.every((pattern) => pattern.intent_id.length > 0)).toBe(true);
  });

  it('resolves a canonical outcome pattern by intent id', () => {
    expect(findIntentOutcomePattern('generate-presentation')).toMatchObject({
      intent_id: 'generate-presentation',
      primary_outcome_ids: ['artifact:pptx'],
    });
    expect(findIntentOutcomePattern('missing-intent')).toBeNull();
  });
});
