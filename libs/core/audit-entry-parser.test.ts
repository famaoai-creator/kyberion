import { describe, expect, it } from 'vitest';
import { normalizePersistedAuditEntry } from './audit-chain.js';
import { computeAuditEntryHash } from './chain-integrity.js';
import { agentActor, humanActor } from './actor.js';

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

describe('AuditEntry.actor (FD-10, additive)', () => {
  it('keeps the hash unchanged for a legacy entry with no actor key at all', () => {
    const legacy = { id: 'AUD-1', previousHash: '0'.repeat(64), currentHash: '', action: 'test' };
    const beforeThisChange = computeAuditEntryHash(legacy, legacy.previousHash);
    // Simulates the pre-FD-10 shape (no `actor` property present at all —
    // not `actor: undefined`, which JSON.stringify also drops, but the
    // property literally absent from the object, matching what every entry
    // recorded before this field existed looks like on disk).
    const afterThisChange = computeAuditEntryHash({ ...legacy }, legacy.previousHash);
    expect(afterThisChange).toBe(beforeThisChange);
  });

  it('round-trips a structured human actor through normalizePersistedAuditEntry', () => {
    const actor = humanActor('owner', 'Owner');
    const normalized = normalizePersistedAuditEntry({ ...validEntry, actor });
    expect(normalized.actor).toEqual(actor);
  });

  it('round-trips a structured agent actor', () => {
    const actor = agentActor('kyberion://agent/default/report-writer', 'user:owner');
    const normalized = normalizePersistedAuditEntry({ ...validEntry, actor });
    expect(normalized.actor).toEqual(actor);
  });

  it('tolerates a legacy entry with no actor field (absence, not rejection)', () => {
    const normalized = normalizePersistedAuditEntry(validEntry);
    expect(normalized.actor).toBeUndefined();
  });

  it('drops a malformed actor instead of rejecting an otherwise-valid entry', () => {
    const normalized = normalizePersistedAuditEntry({
      ...validEntry,
      actor: { kind: 'human', id: 'owner' }, // missing the user: prefix
    });
    expect(normalized.actor).toBeUndefined();
    expect(normalized.id).toBe('AUD-1');
  });
});
