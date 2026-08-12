import { describe, expect, it } from 'vitest';
import { isReservedScopeName, isValidTenantSlug } from './entity-scope.js';

describe('entity scope tenant names', () => {
  it.each(['public', 'confidential', 'personal', 'shared', 'PUBLIC'])(
    'rejects reserved scope name %s as a tenant slug',
    (value) => {
      expect(isReservedScopeName(value)).toBe(true);
      expect(isValidTenantSlug(value)).toBe(false);
    }
  );

  it('accepts a syntactically valid non-reserved tenant slug', () => {
    expect(isValidTenantSlug('acme-corp')).toBe(true);
  });
});
