import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { validateReadPermission, validateWritePermission } from '../tier-guard.js';
import { withStoreGrant } from '../authority.js';
import * as pathResolver from '../path-resolver.js';
import { DECISION_LEDGER_ROLES } from './model.js';

vi.mock('../governance/audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));

const ROOT = pathResolver.rootDir();
const TENANT = 'acme-corp';

const ledgerFile = (tenant: string) =>
  path.join(ROOT, `knowledge/confidential/${tenant}/decisions/case-1/decisions.jsonl`);
const actorsFile = (tenant: string) =>
  path.join(ROOT, `knowledge/confidential/${tenant}/customers/acme/actors.json`);

const inGrant = <T>(fn: () => T): T =>
  withStoreGrant(DECISION_LEDGER_ROLES.write, fn, { tenantSlug: TENANT });

describe('decision_ledger_store grant', () => {
  it('names the ledger store grant', () => {
    expect(DECISION_LEDGER_ROLES.write).toBe('decision_ledger_store');
    expect(DECISION_LEDGER_ROLES.read).toBe('decision_ledger_store');
  });

  it('writes its own tenant ledger and customer actors', () => {
    inGrant(() => {
      expect(validateWritePermission(ledgerFile(TENANT))).toEqual({ allowed: true });
      expect(validateWritePermission(actorsFile(TENANT))).toEqual({ allowed: true });
    });
  });

  it("reads its own tenant ledger but not another tenant's", () => {
    inGrant(() => {
      expect(validateReadPermission(ledgerFile(TENANT))).toEqual({ allowed: true });
      expect(validateReadPermission(ledgerFile('other-corp')).allowed).toBe(false);
    });
  });

  it('cannot write another tenant, other tenant files, or outside knowledge/confidential', () => {
    inGrant(() => {
      expect(validateWritePermission(ledgerFile('other-corp')).allowed).toBe(false);
      expect(
        validateWritePermission(path.join(ROOT, 'knowledge/confidential/acme-corp/notes.md'))
          .allowed
      ).toBe(false);
      expect(validateWritePermission(path.join(ROOT, 'knowledge/product/x.md')).allowed).toBe(
        false
      );
    });
  });

  it('may take the ledger lock it takes inside appendDecisions / applyPromotions', () => {
    inGrant(() => {
      expect(
        validateWritePermission(
          path.join(ROOT, 'active/shared/runtime/locks/decision-ledger-acme-corp-case-1.lock')
        )
      ).toEqual({ allowed: true });
    });
  });

  it('denies everything outside a grant scope', () => {
    expect(validateWritePermission(ledgerFile(TENANT)).allowed).toBe(false);
  });
});
