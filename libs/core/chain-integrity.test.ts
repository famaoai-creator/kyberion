import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeAuditEntryHash,
  computeLedgerEntryHash,
  verifyAuditEntryHash,
  verifyLedgerEntryHash,
} from './chain-integrity.js';

describe('chain-integrity', () => {
  it('preserves the legacy audit SHA-256 formula', () => {
    const entry = {
      id: 'AUD-1',
      previousHash: '0'.repeat(64),
      currentHash: '',
      action: 'test',
    };
    const expected = createHash('sha256')
      .update(entry.previousHash + JSON.stringify({ ...entry, currentHash: undefined }))
      .digest('hex');

    expect(computeAuditEntryHash(entry, entry.previousHash)).toBe(expected);
  });

  it('uses keyed HMAC for new audit entries', () => {
    const entry = {
      id: 'AUD-2',
      previousHash: '0'.repeat(64),
      currentHash: '',
      action: 'test',
      chain_alg: 'hmac-sha256',
    };
    const first = computeAuditEntryHash(entry, entry.previousHash, {
      alg: 'hmac-sha256',
      key: 'key-a',
    });
    const second = computeAuditEntryHash(entry, entry.previousHash, {
      alg: 'hmac-sha256',
      key: 'key-b',
    });

    expect(first).not.toBe(second);
    expect(
      verifyAuditEntryHash({ ...entry, currentHash: first }, entry.previousHash, {
        alg: 'hmac-sha256',
        key: 'key-a',
      }).ok
    ).toBe(true);
    expect(
      verifyAuditEntryHash({ ...entry, currentHash: first }, entry.previousHash, {
        alg: 'hmac-sha256',
        key: 'key-b',
      }).ok
    ).toBe(false);
  });

  it('verifies ledger entries with legacy SHA and keyed HMAC', () => {
    const legacy = {
      timestamp: '2026-07-04T00:00:00.000Z',
      type: 'LEGACY',
      parent_hash: '0'.repeat(64),
    };
    const legacyHash = computeLedgerEntryHash(legacy);
    expect(verifyLedgerEntryHash({ ...legacy, hash: legacyHash }, legacy.parent_hash).ok).toBe(
      true
    );

    const keyed = {
      timestamp: '2026-07-04T00:00:01.000Z',
      type: 'KEYED',
      parent_hash: legacyHash,
      chain_alg: 'hmac-sha256',
    };
    const keyedHash = computeLedgerEntryHash(keyed, { alg: 'hmac-sha256', key: 'secret-a' });
    expect(
      verifyLedgerEntryHash({ ...keyed, hash: keyedHash }, legacyHash, {
        alg: 'hmac-sha256',
        key: 'secret-a',
      }).ok
    ).toBe(true);
    expect(
      verifyLedgerEntryHash({ ...keyed, hash: keyedHash }, legacyHash, {
        alg: 'hmac-sha256',
        key: 'secret-b',
      }).ok
    ).toBe(false);
  });
});
