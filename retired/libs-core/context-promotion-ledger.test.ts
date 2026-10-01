import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { recordContextPromotion, validateContextPromotion } from './context-promotion-ledger.js';

const ledgerPath = pathResolver.sharedTmp('context-promotion-ledger.test.jsonl');
const scope = {
  tenant_id: 'tenant-a',
  project_id: 'project-x',
  mission_id: 'MSN-123',
  read_tiers: ['public', 'confidential'] as const,
  write_tier: 'confidential' as const,
  purpose: 'approved-summary',
};

afterEach(() => {
  if (safeExistsSync(ledgerPath)) safeRmSync(ledgerPath);
});

describe('context promotion ledger', () => {
  it('records and validates an exact approved downflow', () => {
    const authorization = recordContextPromotion({
      source_tier: 'confidential',
      target_tier: 'public',
      security_scope: { ...scope, read_tiers: [...scope.read_tiers] },
      approved_by: 'operator-1',
      approved_at: '2026-07-12T00:00:00.000Z',
      expires_at: '2026-07-13T00:00:00.000Z',
      reason: 'Approved sanitized public summary',
      content: 'sanitized summary',
      ledger_path: ledgerPath,
    });

    expect(path.basename(ledgerPath)).toBe('context-promotion-ledger.test.jsonl');
    expect(safeReadFile(ledgerPath, { encoding: 'utf8' })).toContain(
      authorization.authorization_id
    );
    expect(
      validateContextPromotion({
        authorization,
        source_tier: 'confidential',
        target_tier: 'public',
        security_scope: { ...scope, read_tiers: [...scope.read_tiers] },
        content: 'sanitized summary',
        now: '2026-07-12T12:00:00.000Z',
      })
    ).toEqual({ allowed: true });
  });

  it('rejects content or scope reuse and expired approvals', () => {
    const authorization = recordContextPromotion({
      source_tier: 'confidential',
      target_tier: 'public',
      security_scope: { ...scope, read_tiers: [...scope.read_tiers] },
      approved_by: 'operator-1',
      approved_at: '2026-07-12T00:00:00.000Z',
      expires_at: '2026-07-13T00:00:00.000Z',
      reason: 'Approved sanitized public summary',
      content: 'sanitized summary',
      ledger_path: ledgerPath,
    });
    expect(
      validateContextPromotion({
        authorization,
        source_tier: 'confidential',
        target_tier: 'public',
        security_scope: { ...scope, tenant_id: 'tenant-b', read_tiers: [...scope.read_tiers] },
        content: 'changed summary',
        now: '2026-07-14T00:00:00.000Z',
      }).allowed
    ).toBe(false);
  });
});
