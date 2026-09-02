import { describe, expect, it } from 'vitest';
import { parseOnboardingState } from './onboarding-state.js';

describe('onboarding state loader', () => {
  const valid = {
    version: '1.0.0' as const,
    status: 'draft' as const,
    current_phase: 'identity' as const,
    completed_phases: [],
    created_at: '2026-09-03T00:00:00.000Z',
    updated_at: '2026-09-03T00:00:00.000Z',
  };

  it('parses schema-valid state and preserves legacy persona compatibility', () => {
    const state = parseOnboardingState({
      ...valid,
      identity: {
        name: 'Operator',
        language: 'ja',
        interaction_style: 'Senior Partner',
        primary_domain: 'operations',
        vision: 'ship safely',
        agent_id: 'operator',
      },
    });
    expect(state.identity?.persona).toBe('sovereign');
  });

  it('rejects unknown fields and malformed timestamps', () => {
    expect(() => parseOnboardingState({ ...valid, unexpected: true })).toThrow(
      'must NOT have additional properties'
    );
    expect(() => parseOnboardingState({ ...valid, created_at: 'not-a-timestamp' })).toThrow(
      'must match format "date-time"'
    );
  });

  it('rejects dangerous nested JSON keys before schema access', () => {
    expect(() =>
      parseOnboardingState(
        JSON.parse(
          '{"version":"1.0.0","status":"draft","current_phase":"identity","completed_phases":[],"created_at":"2026-09-03T00:00:00.000Z","updated_at":"2026-09-03T00:00:00.000Z","identity":{"__proto__":{}}}'
        )
      )
    ).toThrow('dangerous JSON key');
  });
});
