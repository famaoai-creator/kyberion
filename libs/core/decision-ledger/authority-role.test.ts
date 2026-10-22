import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateReadPermission, validateWritePermission } from '../tier-guard.js';
import * as pathResolver from '../path-resolver.js';
import { DECISION_LEDGER_ROLES } from './model.js';
// Install the full identity resolver the production write path uses.
import '../authority.js';

vi.mock('../governance/audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));

const ROOT = pathResolver.rootDir();
const ENV_KEYS = ['KYBERION_TENANT', 'KYBERION_PERSONA', 'MISSION_ROLE', 'SYSTEM_ROLE'] as const;

const ledgerFile = (tenant: string) =>
  path.join(ROOT, `knowledge/confidential/${tenant}/decisions/case-1/decisions.jsonl`);
const actorsFile = (tenant: string) =>
  path.join(ROOT, `knowledge/confidential/${tenant}/customers/acme/actors.json`);

describe('decision_ledger authority role', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.MISSION_ROLE = DECISION_LEDGER_ROLES.write;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('is the ledger write role', () => {
    expect(DECISION_LEDGER_ROLES.write).toBe('decision_ledger');
  });

  it('writes its own tenant ledger and customer actors', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    expect(validateWritePermission(ledgerFile('acme-corp'))).toEqual({ allowed: true });
    expect(validateWritePermission(actorsFile('acme-corp'))).toEqual({ allowed: true });
  });

  it("reads its own tenant ledger but not another tenant's", () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    expect(validateReadPermission(ledgerFile('acme-corp'))).toEqual({ allowed: true });
    expect(validateReadPermission(ledgerFile('other-corp')).allowed).toBe(false);
  });

  it('cannot write another tenant, other tenant files, or outside knowledge/confidential', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    expect(validateWritePermission(ledgerFile('other-corp')).allowed).toBe(false);
    expect(
      validateWritePermission(path.join(ROOT, 'knowledge/confidential/acme-corp/notes.md')).allowed
    ).toBe(false);
    expect(validateWritePermission(path.join(ROOT, 'knowledge/product/x.md')).allowed).toBe(false);
  });

  it('gets no grant at all without a tenant', () => {
    expect(validateWritePermission(ledgerFile('acme-corp')).allowed).toBe(false);
  });
});
