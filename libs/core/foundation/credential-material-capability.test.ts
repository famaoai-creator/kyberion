import { describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { validateReadPermission } from '../tier-guard.js';
import { currentExecutionScope } from './execution-scope.js';
import {
  withCredentialMaterialCapability,
  isCredentialMaterialCapability,
} from './credential-material-capability.js';
import {
  createSynchronousResourceGrantIssuer,
  runInResourceAccessScope,
  currentResourceAccessScope,
  resourceAccessDenial,
  type ResourceAccessScope,
} from './resource-access-scope.js';
describe('allocated material read ceiling', () => {
  it('revokes queued reads even when the synchronous callback returns undefined', async () => {
    const file = 'knowledge/personal/connections/anthropic.json';
    let queued: Promise<void> | undefined;
    withCredentialMaterialCapability('alpha', file, () => {
      withExecutionContext(
        'credential_material_reader',
        () => {
          queued = Promise.resolve().then(() => {
            expect(currentExecutionScope()?.assumedRole).toBe('credential_material_reader');
            expect(currentResourceAccessScope()?.readExact).toEqual([file]);
            expect(isCredentialMaterialCapability(currentResourceAccessScope())).toBe(false);
            expect(validateReadPermission(file)).toMatchObject({
              allowed: false,
              reason: expect.stringContaining('CREDENTIAL_CAPABILITY_REQUIRED'),
            });
          });
        },
        undefined,
        'alpha'
      );
    });
    await queued;
  });
  it('rejects cloned scopes and counterfeit issuers even with the same label', () => {
    const file = 'knowledge/personal/connections/anthropic.json';
    withCredentialMaterialCapability('alpha', file, () => {
      const scope = currentResourceAccessScope()!;
      expect(
        isCredentialMaterialCapability({ ...scope, opaqueStoreToken: scope.opaqueStoreToken })
      ).toBe(false);
      runInResourceAccessScope({ ...scope, opaqueStoreToken: scope.opaqueStoreToken }, () => {
        expect(isCredentialMaterialCapability(currentResourceAccessScope())).toBe(false);
        expect(() =>
          withExecutionContext('credential_material_reader', () => {}, undefined, 'alpha')
        ).toThrow('CREDENTIAL_CAPABILITY_REQUIRED');
      });
    });
    const counterfeit = createSynchronousResourceGrantIssuer('CREDENTIAL_CAPABILITY');
    counterfeit.run(
      Object.freeze({ tenant: 'alpha', file }),
      {
        tenantSlug: 'alpha',
        readExact: [file],
        writeExact: [],
        mkdirExact: [],
      },
      () => {
        expect(isCredentialMaterialCapability(currentResourceAccessScope())).toBe(false);
        expect(() =>
          withExecutionContext('credential_material_reader', () => {}, undefined, 'alpha')
        ).toThrow('CREDENTIAL_CAPABILITY_REQUIRED');
      }
    );
  });

  it('rejects returned promises, thenables and capability escapes and revokes after exceptions', () => {
    const file = 'knowledge/personal/connections/anthropic.json';
    let captured: ResourceAccessScope | undefined;
    const capture = () => {
      captured = currentResourceAccessScope();
    };
    expect(() =>
      withCredentialMaterialCapability('alpha', file, () => {
        capture();
        return Promise.resolve();
      })
    ).toThrow('CREDENTIAL_CAPABILITY_ASYNC');
    expect(isCredentialMaterialCapability(captured)).toBe(false);
    expect(() => withCredentialMaterialCapability('alpha', file, () => ({ then() {} }))).toThrow(
      'CREDENTIAL_CAPABILITY_ASYNC'
    );
    expect(() =>
      withCredentialMaterialCapability('alpha', file, () => currentResourceAccessScope())
    ).toThrow('CREDENTIAL_CAPABILITY_ESCAPE');
    expect(() =>
      withCredentialMaterialCapability(
        'alpha',
        file,
        () => currentResourceAccessScope()!.opaqueStoreToken
      )
    ).toThrow('CREDENTIAL_CAPABILITY_ESCAPE');
    expect(() =>
      withCredentialMaterialCapability('alpha', file, () => {
        capture();
        throw new Error('owned failure');
      })
    ).toThrow('owned failure');
    runInResourceAccessScope(captured!, () => {
      expect(isCredentialMaterialCapability(currentResourceAccessScope())).toBe(false);
      expect(() =>
        withExecutionContext('credential_material_reader', () => {}, undefined, 'alpha')
      ).toThrow('CREDENTIAL_CAPABILITY_REQUIRED');
    });
  });

  it('preserves canonical path and tenant validation', () => {
    expect(() =>
      withCredentialMaterialCapability(
        'alpha',
        'knowledge/personal/connections/../anthropic.json',
        () => {}
      )
    ).toThrow('CREDENTIAL_CAPABILITY_INVALID');
    expect(() =>
      withCredentialMaterialCapability(
        '../alpha',
        'knowledge/personal/connections/anthropic.json',
        () => {}
      )
    ).toThrow();
  });

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
          expect(validateReadPermission('knowledge/personal/connections/openai.json').allowed).toBe(
            false
          );
          expect(() =>
            withExecutionContext('credential_material_reader', () => {}, undefined, 'beta')
          ).toThrow();
          expect(resourceAccessDenial('knowledge/personal/connections', 'metadata')).toBeNull();
          expect(resourceAccessDenial('knowledge/product/example.md', 'read')).toBeNull();
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
