import { createHash } from 'node:crypto';
import { validateReadPermission, validateWritePermission } from '../tier-guard.js';
import { storeGrantRule } from './store-grant-registry.js';
import { describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { withPersonalTaskCredentialBinding } from './credential-binding.js';
import {
  withPersonalCredentialUseCapability,
  assertPersonalCredentialUseRead,
} from './personal-credential-use-capability.js';
import {
  currentResourceAccessScope,
  runInResourceAccessScope,
  resourceAccessDenial,
} from './resource-access-scope.js';
const claim = {
  ownerId: 'user:alice',
  actorId: 'kyberion://agent/_/_/personal',
  workItemId: 'WI-PERSONAL',
  attemptId: 'attempt',
  leaseId: 'lease',
};
const admission = { ...claim, grantId: 'GRT-20261114-123456789abc' };
const claimed = <T>(run: () => T) =>
  withExecutionContext(
    'infrastructure_sentinel',
    () => withPersonalTaskCredentialBinding(claim, () => {}, run),
    undefined,
    '',
    undefined,
    { missionId: 'MSN-PERSONAL', taskId: 'task' }
  );
describe('personal exact read capability', () => {
  it('opens only the addressed approval read, never an owner directory or sibling', async () => {
    const hash = createHash('sha256').update(claim.actorId).digest('hex');
    const directory = `active/shared/runtime/tenant-approvals/personal/shared/owners/${hash}/grant-standing/requests`;
    const approvalPath = `${directory}/APR-personal.json`;
    const proof = { ...admission, approvalId: 'APR-personal', approvalPath };
    const allowed = (
      target: string,
      operation: 'read' | 'metadata' | 'write' | 'append' | 'mkdir'
    ) => storeGrantRule('personal-credential-use')?.pathAllowed?.(target, operation);
    let late: Promise<void> | undefined;
    claimed(() => {
      expect(validateReadPermission(approvalPath).allowed).toBe(false);
      withPersonalCredentialUseCapability(proof, () => {
        expect(allowed(approvalPath, 'read')).toBe(true);
        expect(validateReadPermission(approvalPath).allowed).toBe(true);
        expect(allowed(directory, 'metadata')).toBe(true);
        expect(allowed(directory, 'read')).toBe(false);
        expect(validateReadPermission(directory).allowed).toBe(false);
        expect(validateReadPermission(`${directory}/APR-sibling.json`).allowed).toBe(false);
        expect(validateReadPermission(approvalPath.replace(hash, 'b'.repeat(64))).allowed).toBe(
          false
        );
        for (const operation of ['write', 'append', 'mkdir'] as const)
          expect(allowed(approvalPath, operation)).toBe(false);
        expect(validateWritePermission(approvalPath).allowed).toBe(false);
        const scope = currentResourceAccessScope()!;
        runInResourceAccessScope({ ...scope }, () =>
          expect(allowed(approvalPath, 'read')).toBe(false)
        );
        late = Promise.resolve().then(() => expect(allowed(approvalPath, 'read')).toBe(false));
      });
      expect(allowed(approvalPath, 'read')).toBe(false);
    });
    await late;
  });
  it('requires claimed owner and denies copied and expired scope', async () => {
    expect(() => withPersonalCredentialUseCapability(admission, () => {})).toThrow();
    let later: Promise<void> | undefined;
    claimed(() =>
      withPersonalCredentialUseCapability(admission, () => {
        assertPersonalCredentialUseRead('grant', admission.grantId);
        expect(currentResourceAccessScope()?.custody).toEqual({ kind: 'person', ref: 'alice' });
        expect(
          resourceAccessDenial('active/shared/runtime/grants/personal/shared/other.json', 'read')
        ).not.toBeNull();
        expect(() => assertPersonalCredentialUseRead('approval', 'other')).toThrow();
        const scope = currentResourceAccessScope()!;
        runInResourceAccessScope({ ...scope }, () =>
          expect(() => assertPersonalCredentialUseRead('grant', admission.grantId)).toThrow()
        );
        later = Promise.resolve().then(() =>
          expect(() => assertPersonalCredentialUseRead('grant', admission.grantId)).toThrow()
        );
      })
    );
    await later;
    expect(() =>
      claimed(() => withPersonalCredentialUseCapability(admission, () => Promise.resolve()))
    ).toThrow('ASYNC');
  });
});
