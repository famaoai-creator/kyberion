import { describe, expect, it } from 'vitest';
import {
  personalApprovalIoAllowed,
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
