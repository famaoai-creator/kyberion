import { describe, expect, it } from 'vitest';
import { normalizePersistedAuditEntry } from './audit-chain.js';

const validEntry = {
  id: 'AUD-1',
  timestamp: '2026-09-01T00:00:00.000Z',
  agentId: 'agent-1',
  action: 'approval_gate',
  operation: 'approval_gate',
  result: 'allowed',
  reason: null,
  metadata: { correlationId: 'corr-1' },
  previousHash: 'genesis',
  currentHash: 'hash-1',
};

describe('persisted audit entry parser', () => {
  it('normalizes the persisted audit shape without changing evidence fields', () => {
    expect(normalizePersistedAuditEntry(validEntry)).toMatchObject({
      id: 'AUD-1',
      result: 'allowed',
      currentHash: 'hash-1',
      metadata: { correlationId: 'corr-1' },
    });
  });

  it.each([
    ['primitive root', null],
    ['missing id', { ...validEntry, id: undefined }],
    ['invalid result', { ...validEntry, result: 'pending' }],
    ['metadata array', { ...validEntry, metadata: [] }],
    ['invalid hash', { ...validEntry, currentHash: 42 }],
    ['invalid chain algorithm', { ...validEntry, chain_alg: 'md5' }],
  ])('rejects %s', (_label, value) => {
    expect(() => normalizePersistedAuditEntry(value)).toThrow();
  });
});
