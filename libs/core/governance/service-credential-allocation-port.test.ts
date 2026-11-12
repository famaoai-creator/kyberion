import { describe, expect, it, vi } from 'vitest';
import {
  assertServiceCredentialAllocation,
  registerServiceCredentialAllocationVerifier,
} from './service-credential-allocation.js';
import type { ServiceBindingRecord } from '../service/service-binding-registry.js';
import type { GrantRecord } from './grant-store.js';
const binding = { binding_id: 'synthetic' } as ServiceBindingRecord;
const scope = { tenant_slug: 'acme' };
describe('service allocation composition port', () => {
  it('denies until trusted runtime composes a verifier and after cleanup', () => {
    expect(() => assertServiceCredentialAllocation(binding, scope)).toThrow(
      'bootstrap is required'
    );
    const grant = { grant_id: 'verified-synthetic' } as GrantRecord;
    const verify = vi.fn(() => grant);
    const dispose = registerServiceCredentialAllocationVerifier(verify);
    try {
      expect(assertServiceCredentialAllocation(binding, scope, { action: 'read' })).toBe(grant);
      expect(verify).toHaveBeenCalledWith(binding, scope, { action: 'read' });
      verify.mockImplementation(() => {
        throw new Error('revoked');
      });
      expect(() => assertServiceCredentialAllocation(binding, scope)).toThrow('revoked');
    } finally {
      dispose();
    }
    expect(() => assertServiceCredentialAllocation(binding, scope)).toThrow(
      'bootstrap is required'
    );
  });
});
