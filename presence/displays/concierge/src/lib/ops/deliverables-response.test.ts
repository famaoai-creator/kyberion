import { describe, expect, it } from 'vitest';
import { parseDeliverablesResponse } from './deliverables-response';

const item = {
  artifactId: 'artifact-1',
  kind: 'document',
  storageClass: 'mission',
  updatedAt: '2026-09-01T00:00:00.000Z',
  path: 'active/missions/M-1/result.md',
  missing: false,
};

describe('deliverables response boundary', () => {
  it('accepts a typed deliverable list and access role', () => {
    expect(parseDeliverablesResponse({ deliverables: [item], accessRole: 'readonly' })).toEqual({
      deliverables: [item],
      accessRole: 'readonly',
    });
  });

  it('rejects malformed artifact fields, role, and dangerous keys', () => {
    expect(
      parseDeliverablesResponse({
        deliverables: [{ ...item, sizeBytes: 'large' }],
        accessRole: 'readonly',
      })
    ).toBeUndefined();
    expect(
      parseDeliverablesResponse({ deliverables: [item], accessRole: 'admin' })
    ).toBeUndefined();
    expect(
      parseDeliverablesResponse(
        JSON.parse(
          '{"deliverables":[{"artifactId":"a","kind":"document","storageClass":"mission","updatedAt":"now","__proto__":{}}],"accessRole":"readonly"}'
        )
      )
    ).toBeUndefined();
  });

  it('carries the open-inbox flag that routes a decision to あなた待ち (review M1)', () => {
    const parsed = parseDeliverablesResponse({
      deliverables: [{ ...item, awaitingInboxDecision: true }, item],
      accessRole: 'localadmin',
    });
    expect(parsed?.deliverables[0].awaitingInboxDecision).toBe(true);
    expect(parsed?.deliverables[1]).not.toHaveProperty('awaitingInboxDecision');
    expect(
      parseDeliverablesResponse({
        deliverables: [{ ...item, awaitingInboxDecision: 'yes' }],
        accessRole: 'readonly',
      })
    ).toBeUndefined();
  });
});
