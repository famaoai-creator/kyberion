import { describe, expect, it } from 'vitest';
import { normalizeEventScope } from './event-scope.js';
import { resolveScopeForRecord } from './scope-migration.js';

describe('scope migration reader', () => {
  it('keeps canonical scope unchanged', () => {
    const scope = normalizeEventScope({ tier: 'confidential', tenant_slug: 'client-a' });
    expect(resolveScopeForRecord({ mission_id: 'MSN-A', scope })).toEqual({
      disposition: 'canonical',
      scope,
    });
  });

  it('fails closed for malformed or conflicting scope metadata', () => {
    expect(resolveScopeForRecord({ scope: null })).toEqual({ disposition: 'invalid' });
    expect(
      resolveScopeForRecord({
        scope: normalizeEventScope({
          tier: 'confidential',
          tenant_slug: 'client-a',
          mission_id: 'MSN-A',
        }),
        mission_id: 'MSN-B',
      })
    ).toEqual({ disposition: 'invalid' });
  });

  it('does not infer tenant ownership from an unscoped legacy record', () => {
    expect(resolveScopeForRecord({ tenant_slug: 'client-a', mission_id: 'MSN-UNKNOWN' })).toEqual({
      disposition: 'unscoped-legacy',
    });
  });

  it('derives a legacy mission record only from an authoritative mission scope', () => {
    const scope = normalizeEventScope({
      tier: 'confidential',
      tenant_slug: 'client-a',
      mission_id: 'MSN-A',
    });
    expect(
      resolveScopeForRecord(
        { mission_id: 'MSN-A', tenant_slug: 'client-a' },
        { resolveMissionScope: () => scope }
      )
    ).toEqual({ disposition: 'mission-derived', scope });
    expect(
      resolveScopeForRecord(
        { mission_id: 'MSN-A', tenant_slug: 'client-b' },
        { resolveMissionScope: () => scope }
      )
    ).toEqual({ disposition: 'invalid' });
  });

  it('rejects canonical nested scope when a legacy flat hint conflicts', () => {
    const result = resolveScopeForRecord({
      scope: {
        scope_kind: 'mission',
        tier: 'confidential',
        tenant_slug: 'client-a',
        mission_id: 'MSN-A',
      },
      tenant_slug: 'client-b',
    });

    expect(result.disposition).toBe('invalid');
  });
});
