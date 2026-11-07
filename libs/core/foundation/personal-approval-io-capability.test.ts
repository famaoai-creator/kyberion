import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { validateReadPermission, validateWritePermission } from '../tier-guard.js';
import {
  personalApprovalGrantAuthorizes,
  personalApprovalIoAllowed,
  personalApprovalIoNarrowing,
  withPersonalApprovalCapability,
} from './personal-approval-io-capability.js';

const owner = 'a'.repeat(64);
const file = `active/shared/runtime/tenant-approvals/personal/shared/owners/${owner}/terminal/r.json`;

describe('personal approval owner IO window (G2: module-private, synchronous)', () => {
  it('admits only its exact file while live and current', () => {
    expect(personalApprovalIoAllowed(file, 'read')).toBe(false);
    withPersonalApprovalCapability(
      owner,
      file,
      true,
      () => true,
      () => {
        expect(personalApprovalIoAllowed(file, 'write')).toBe(true);
        expect(personalApprovalIoAllowed(file + '.other', 'write')).toBe(false);
        expect(personalApprovalIoAllowed('knowledge/product/x.json', 'read')).toBe(true);
      }
    );
    expect(personalApprovalIoAllowed(file, 'read')).toBe(false);
    let current = true;
    withPersonalApprovalCapability(
      owner,
      file,
      false,
      () => current,
      () => {
        expect(personalApprovalIoAllowed(file, 'write')).toBe(false);
        current = false;
        expect(personalApprovalIoAllowed(file, 'read')).toBe(false);
      }
    );
  });

  it('refuses thenables and gives a captured continuation no window', async () => {
    expect(() =>
      withPersonalApprovalCapability(
        owner,
        file,
        true,
        () => true,
        () => Promise.resolve(1)
      )
    ).toThrow('synchronous only');
    let later: Promise<boolean> | undefined;
    withPersonalApprovalCapability(
      owner,
      file,
      true,
      () => true,
      () => {
        later = new Promise((resolve) =>
          setTimeout(() => resolve(personalApprovalIoAllowed(file, 'write')), 0)
        );
      }
    );
    await expect(later).resolves.toBe(false);
  });

  it('keeps no globalThis registry', () => {
    expect(Object.getOwnPropertySymbols(globalThis).map(String)).not.toContain(
      'Symbol(kyberion.core.personal-approval-io.v1)'
    );
  });
});

describe('personal approval owner window authority (G2: no store role)', () => {
  // The exact repository path the window names (rootResolve would redirect Vitest runtime state).
  const abs = (relative: string) => path.join(pathResolver.rootDir(), relative);
  // The issuer (governance/personal-approval-runtime.ts) names the former role's write roots.
  const roots = [
    'active/shared/runtime/tenant-approvals/personal/shared',
    'active/shared/runtime/vitest-approvals',
  ];
  const open = <T>(writing: boolean, run: () => T, current = () => true) =>
    withPersonalApprovalCapability(owner, file, writing, current, run, roots);

  it('authorizes its exact file for a role-less caller only while live', () => {
    withExecutionContext('chronos_operator', () => {
      expect(validateWritePermission(abs(file)).allowed).toBe(false);
      expect(validateReadPermission(abs(file)).allowed).toBe(false);
      open(true, () => {
        expect(personalApprovalGrantAuthorizes(file, 'write')).toBe(true);
        expect(validateWritePermission(abs(file))).toMatchObject({ allowed: true });
        expect(validateReadPermission(abs(file))).toMatchObject({ allowed: true });
        expect(validateWritePermission(abs(file.replace(/r\.json$/u, 'q.json'))).reason).toContain(
          'PERSONAL_APPROVAL_SCOPE_REQUIRED'
        );
      });
      open(false, () => {
        expect(personalApprovalGrantAuthorizes(file, 'write')).toBe(false);
        expect(validateWritePermission(abs(file)).allowed).toBe(false);
        expect(validateReadPermission(abs(file))).toMatchObject({ allowed: true });
      });
      expect(validateWritePermission(abs(file)).allowed).toBe(false);
    });
  });

  it('narrows writes to where the former role was authorized, whatever the caller policy', () => {
    withExecutionContext('mission_controller', () => {
      // Outside a window the runtime default allow admits these for the caller.
      expect(validateWritePermission(abs('active/shared/runtime/x.json')).allowed).toBe(true);
      expect(
        validateWritePermission(abs('active/shared/runtime/tenant-approvals/personal'), 'mkdir')
          .allowed
      ).toBe(true);
      open(true, () => {
        expect(validateWritePermission(abs('active/shared/runtime/x.json')).allowed).toBe(false);
        // The role routed ancestor mkdir to its own grant: above personal/shared it was refused.
        expect(
          validateWritePermission(abs('active/shared/runtime/tenant-approvals/personal'), 'mkdir')
            .reason
        ).toContain('PERSONAL_APPROVAL_SCOPE_REQUIRED');
        expect(
          validateWritePermission(
            abs('active/shared/runtime/tenant-approvals/personal/shared'),
            'mkdir'
          ).allowed
        ).toBe(true);
        expect(personalApprovalIoNarrowing('knowledge/personal/x.json', 'read')).toBe(false);
      });
    });
  });

  it('admits nothing once the owner scope is not current or in a captured continuation', async () => {
    let current = true;
    let later: Promise<[boolean, boolean]> | undefined;
    withExecutionContext('mission_controller', () =>
      open(
        true,
        () => {
          current = false;
          expect(validateWritePermission(abs(file)).allowed).toBe(false);
          expect(validateWritePermission(abs('active/shared/runtime/x.json')).allowed).toBe(false);
          current = true;
          later = new Promise((resolve) =>
            setTimeout(
              () =>
                resolve([
                  validateWritePermission(abs(file)).allowed,
                  validateWritePermission(abs('active/shared/runtime/x.json')).allowed,
                ]),
              0
            )
          );
        },
        () => current
      )
    );
    // The window was revoked when the callback returned: the continuation it captured gets no
    // grant and stays narrowed (the former role held there admitted nothing either).
    await expect(later).resolves.toEqual([false, false]);
  });

  it('authorizes no write when the issuer names no write roots', () => {
    withExecutionContext('chronos_operator', () =>
      withPersonalApprovalCapability(
        owner,
        file,
        true,
        () => true,
        () => {
          expect(personalApprovalGrantAuthorizes(file, 'write')).toBe(false);
          expect(validateWritePermission(abs(file)).allowed).toBe(false);
        }
      )
    );
  });

  it('refuses the former role name and a lookalike window', () => {
    expect(() =>
      withExecutionContext('personal_approval_store', () => undefined, 'worker')
    ).toThrow('ROLE_ASSUMPTION_DENIED');
    const counterfeit = Object.freeze({
      path: file,
      writing: true,
      ownerHash: owner,
      isCurrent: () => true,
    });
    expect(Object.isFrozen(counterfeit)).toBe(true);
    // No API accepts a window object: possession of a lookalike authorizes nothing.
    expect(personalApprovalGrantAuthorizes(file, 'write')).toBe(false);
    expect(personalApprovalIoNarrowing(file, 'write')).toBe(true);
  });
});
