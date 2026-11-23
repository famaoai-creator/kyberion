import { describe, expect, it } from 'vitest';
import { assertStartMissionTypeMatches } from './mission-creation.js';

describe('assertStartMissionTypeMatches', () => {
  it('rejects an explicit type that differs from the saved mission type', () => {
    expect(() =>
      assertStartMissionTypeMatches('MSN-X-20261123', 'development', 'reverse_spec')
    ).toThrow(/MISSION_TYPE_MISMATCH.*created as 'development', not 'reverse_spec'/);
  });

  it('allows a matching type, no requested type, or a mission not created yet', () => {
    expect(() =>
      assertStartMissionTypeMatches('MSN-X-20261123', 'reverse_spec', 'reverse_spec')
    ).not.toThrow();
    expect(() =>
      assertStartMissionTypeMatches('MSN-X-20261123', 'development', undefined)
    ).not.toThrow();
    expect(() =>
      assertStartMissionTypeMatches('MSN-X-20261123', undefined, 'reverse_spec')
    ).not.toThrow();
  });
});
