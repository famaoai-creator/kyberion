import { describe, expect, it } from 'vitest';
import { parseMissionHistoryResponse } from './mission-history-response';

const mission = {
  missionId: 'M-1',
  status: 'active',
  tier: 'confidential',
  tenantSlug: 'acme',
  artifactKinds: ['markdown'],
  artifactCount: 1,
};

describe('mission history response boundary', () => {
  it('accepts a typed mission history response', () => {
    expect(parseMissionHistoryResponse({ missions: [mission] })).toEqual({ missions: [mission] });
  });

  it.each([
    { missions: [{ ...mission, status: 'unknown' }] },
    { missions: [{ ...mission, tier: [] }] },
    { missions: [{ ...mission, artifactKinds: ['markdown', 42] }] },
    { missions: [{ ...mission, artifactCount: -1 }] },
    { missions: [{ ...mission, tenantSlug: 42 }] },
    JSON.parse(
      '{"missions":[{"missionId":"M-1","status":"active","tier":"confidential","artifactKinds":[],"artifactCount":0,"__proto__":{}}]}'
    ),
    [],
  ])('rejects malformed mission history response: %p', (value) => {
    expect(parseMissionHistoryResponse(value)).toBeUndefined();
  });
});
