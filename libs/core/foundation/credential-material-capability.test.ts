import { describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { validateReadPermission } from '../tier-guard.js';
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

// G2: the live material grant is the authority; the caller keeps a role that holds no
// connections grant of its own (persona worker, bound to the allocation's tenant).
const asCaller = <T>(fn: () => T): T =>
  withExecutionContext('chronos_gateway', fn, 'worker', 'alpha');
const file = 'knowledge/personal/connections/anthropic.json';

describe('allocated material read ceiling', () => {
  it('revokes queued reads even when the synchronous callback returns undefined', async () => {
    let queued: Promise<void> | undefined;
    asCaller(() =>
      withCredentialMaterialCapability('alpha', file, () => {
        expect(validateReadPermission(file).allowed).toBe(true);
        queued = Promise.resolve().then(() => {
          expect(currentResourceAccessScope()?.readExact).toEqual([file]);
          expect(isCredentialMaterialCapability(currentResourceAccessScope())).toBe(false);
          expect(validateReadPermission(file).allowed).toBe(false);
        });
      })
    );
    await queued;
  });

  it('rejects cloned scopes and counterfeit issuers even with the same label', () => {
    asCaller(() => {
      withCredentialMaterialCapability('alpha', file, () => {
        const scope = currentResourceAccessScope()!;
        expect(
          isCredentialMaterialCapability({ ...scope, opaqueStoreToken: scope.opaqueStoreToken })
        ).toBe(false);
        runInResourceAccessScope({ ...scope, opaqueStoreToken: scope.opaqueStoreToken }, () => {
          expect(isCredentialMaterialCapability(currentResourceAccessScope())).toBe(false);
          expect(validateReadPermission(file).allowed).toBe(false);
        });
      });
      const counterfeit = createSynchronousResourceGrantIssuer('CREDENTIAL_CAPABILITY');
      counterfeit.run(
        Object.freeze({ tenant: 'alpha', file }),
        { tenantSlug: 'alpha', readExact: [file], writeExact: [], mkdirExact: [] },
        () => {
          expect(isCredentialMaterialCapability(currentResourceAccessScope())).toBe(false);
          expect(validateReadPermission(file).allowed).toBe(false);
        }
      );
    });
  });

  it('rejects returned promises, thenables and capability escapes and revokes after exceptions', () => {
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
    asCaller(() =>
      runInResourceAccessScope(captured!, () => {
        expect(isCredentialMaterialCapability(currentResourceAccessScope())).toBe(false);
        expect(validateReadPermission(file).allowed).toBe(false);
      })
    );
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

  it('authorizes only its exact file read; the former reader role grants nothing', () => {
    expect(() =>
      withExecutionContext('credential_material_reader', () => {}, undefined, 'alpha')
    ).toThrow('ROLE_ASSUMPTION_DENIED');
    let captured: ResourceAccessScope | undefined;
    asCaller(() => {
      expect(validateReadPermission(file).allowed).toBe(false);
      withCredentialMaterialCapability('alpha', file, () => {
        captured = currentResourceAccessScope();
        expect(isCredentialMaterialCapability(captured)).toBe(true);
        expect(resourceAccessDenial(file, 'read')).toBeNull();
        expect(validateReadPermission(file).allowed).toBe(true);
        expect(validateReadPermission('knowledge/personal/connections', 'metadata').allowed).toBe(
          true
        );
        expect(validateReadPermission('knowledge/personal/connections/openai.json').allowed).toBe(
          false
        );
        expect(resourceAccessDenial('knowledge/personal/connections', 'metadata')).toBeNull();
        expect(resourceAccessDenial('knowledge/product/example.md', 'read')).toBeNull();
        expect(resourceAccessDenial(file, 'write')?.allowed).toBe(false);
        expect(
          resourceAccessDenial('knowledge/personal/connections/openai.json', 'read')?.allowed
        ).toBe(false);
      });
      expect(validateReadPermission(file).allowed).toBe(false);
    });
    expect(isCredentialMaterialCapability(captured)).toBe(false);
  });
});
