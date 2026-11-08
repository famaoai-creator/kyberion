import { describe, expect, it } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { validateReadPermission, validateWritePermission } from '@agent/core/tier-guard';
import { safeMoveSync, safeRmSync, safeWriteFile } from '@agent/core/secure-io';

const root = 'active/shared/runtime/asset-derivations';
describe('derivation receipt authority', () => {
  it('rejects direct worker forgery before broad runtime policy can allow it', () => {
    withExecutionContext('worker', () => {
      for (const operation of ['write', 'append', 'mkdir'] as const) {
        expect(validateWritePermission(`${root}/system/forged.jsonl`, operation)).toMatchObject({
          allowed: false,
          reason: expect.stringContaining('DERIVATION_RECEIPT_AUTHORITY'),
        });
      }
      expect(() => safeWriteFile(`${root}/system/forged.jsonl`, '{}')).toThrow(
        'DERIVATION_RECEIPT_AUTHORITY'
      );
      expect(validateReadPermission(`${root}/system/derivations.jsonl`)).toMatchObject({
        allowed: false,
        reason: expect.stringContaining('DERIVATION_RECEIPT_AUTHORITY'),
      });
    });
  });
  it('rejects aggregate removal or replacement even when the directory is absent', () => {
    withExecutionContext('worker', () => {
      const absolute = pathResolver.rootResolve(root);
      expect(() => safeRmSync(absolute, { recursive: true, force: true })).toThrow(
        'DERIVATION_RECEIPT_AUTHORITY'
      );
      expect(() => safeMoveSync(absolute, `${absolute}-replacement`)).toThrow();
    });
  });
});
