import { describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { validateReadPermission } from '../tier-guard.js';
import {
  withCredentialMaterialCapability,
  isCredentialMaterialCapability,
} from './credential-material-capability.js';
import {
  currentResourceAccessScope,
  resourceAccessDenial,
  type ResourceAccessScope,
} from './resource-access-scope.js';
describe('allocated material read ceiling', () => {
  it('requires a live exact-file capability and cannot broaden it to other credentials or writes', () => {
    expect(() =>
      withExecutionContext('credential_material_reader', () => {}, undefined, 'alpha')
    ).toThrow('CREDENTIAL_CAPABILITY_REQUIRED');
    let captured: ResourceAccessScope | undefined;
    const file = 'knowledge/personal/connections/anthropic.json';
    withCredentialMaterialCapability('alpha', file, () =>
      withExecutionContext(
        'credential_material_reader',
        () => {
          captured = currentResourceAccessScope();
          expect(isCredentialMaterialCapability(captured)).toBe(true);
          expect(resourceAccessDenial(file, 'read')).toBeNull();
          expect(validateReadPermission(file).allowed).toBe(true);
          expect(resourceAccessDenial(file, 'write')?.allowed).toBe(false);
          expect(
            resourceAccessDenial('knowledge/personal/connections/openai.json', 'read')?.allowed
          ).toBe(false);
        },
        undefined,
        'alpha'
      )
    );
    expect(isCredentialMaterialCapability(captured)).toBe(false);
  });
});
