import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  auditVerify: vi.fn(),
  auditVerifyTenantMirrors: vi.fn(),
  ledgerVerify: vi.fn(),
  allLedgerVerify: vi.fn(),
  safeExistsSync: vi.fn(),
}));

// LE-03: collectAuditVerifyReport moved into @agent/core report-ops, which
// imports its collaborators via relative module paths — mock the resolved
// modules via package subpaths (relative imports into libs/core are forbidden
// by the package-boundary contract).
vi.mock('@agent/core/governance/audit-chain', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    auditChain: {
      verify: mocks.auditVerify,
      verifyTenantMirrors: mocks.auditVerifyTenantMirrors,
    },
  };
});

vi.mock('@agent/core/ledger', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    GLOBAL_LEDGER_PATH: 'active/audit/system-ledger.jsonl',
    verifyLedgerIntegrityDetailed: mocks.ledgerVerify,
    verifyAllLedgerIntegrity: mocks.allLedgerVerify,
  };
});

vi.mock('@agent/core/secure-io', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    safeExistsSync: mocks.safeExistsSync,
  };
});

describe('audit_verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auditVerify.mockReturnValue({
      valid: 1,
      corrupted: [],
      total: 1,
      checkedFiles: ['audit-2026-07-04.jsonl'],
      boundaryLimited: false,
    });
    mocks.ledgerVerify.mockReturnValue({
      ok: true,
      total: 1,
      corrupted: [],
      missingKey: false,
    });
    mocks.auditVerifyTenantMirrors.mockReturnValue({ ok: true, findings: [] });
    mocks.allLedgerVerify.mockReturnValue({
      ok: true,
      ledgers: [
        {
          path: 'active/audit/system-ledger.jsonl',
          ok: true,
          total: 1,
          corrupted: [],
          missingKey: false,
        },
      ],
      withheld: 0,
    });
    mocks.safeExistsSync.mockImplementation((filePath?: string) => {
      // The production queue discovers tenant shards below this root. Keep
      // the fixture's global ledger/audit paths present while making absent
      // tenant queue files and the optional global queue behave like the real
      // filesystem. The runtime directories are intentionally gitignored, so
      // this test must not depend on a developer's local queue state.
      const resolved = String(filePath || '');
      return (
        // Match the sub-path, not '/active/…': under Vitest these resolve
        // into the vitest-live sandbox (path-resolver).
        !resolved.includes('/shared/runtime/tenants') &&
        !resolved.endsWith('/shared/runtime/memory/promotion-queue.jsonl')
      );
    });
  });

  it('returns ok when audit chain and ledgers verify', async () => {
    const { collectAuditVerifyReport } = await import('./audit_verify.js');

    const report = collectAuditVerifyReport();

    expect(report.ok).toBe(true);
    expect(mocks.auditVerify).toHaveBeenCalledWith({ since: undefined, requireKeyed: true });
    expect(mocks.ledgerVerify).toHaveBeenCalledWith('active/audit/system-ledger.jsonl', {
      requireKeyed: true,
    });
  });

  it('returns failed when the audit chain reports corruption', async () => {
    mocks.auditVerify.mockReturnValue({
      valid: 0,
      corrupted: ['AUD-1'],
      total: 1,
      checkedFiles: ['audit-2026-07-04.jsonl'],
      boundaryLimited: false,
    });
    const { collectAuditVerifyReport } = await import('./audit_verify.js');

    const report = collectAuditVerifyReport();

    expect(report.ok).toBe(false);
    expect(report.audit.corrupted).toContain('AUD-1');
  });

  it('returns failed when tenant mirrors diverge from the master chain', async () => {
    mocks.auditVerifyTenantMirrors.mockReturnValue({
      ok: false,
      findings: ['tenant acme: mirror count 2 != master count 3'],
    });
    const { collectAuditVerifyReport } = await import('./audit_verify.js');

    const report = collectAuditVerifyReport();

    expect(report.ok).toBe(false);
    expect(report.tenantMirrors.findings).toHaveLength(1);
  });

  it('passes since and extra ledger paths through to the verifiers', async () => {
    const { collectAuditVerifyReport } = await import('./audit_verify.js');

    const report = collectAuditVerifyReport({
      since: '2026-07-04',
      ledgers: ['active/missions/demo/evidence/ledger.jsonl'],
    });

    expect(report.ok).toBe(true);
    expect(mocks.auditVerify).toHaveBeenCalledWith({ since: '2026-07-04', requireKeyed: true });
    expect(mocks.ledgerVerify).toHaveBeenCalledWith('active/missions/demo/evidence/ledger.jsonl', {
      requireKeyed: true,
    });
  });

  it('verifies tenant ledger partitions (D9) and fails on a broken tenant chain', async () => {
    const tenantPath = 'active/shared/runtime/tenant-ledger/confidential/acme/ledger.jsonl';
    mocks.allLedgerVerify.mockReturnValue({
      ok: false,
      ledgers: [
        {
          path: 'active/audit/system-ledger.jsonl',
          ok: true,
          total: 1,
          corrupted: [],
          missingKey: false,
        },
        {
          path: tenantPath,
          ok: false,
          total: 2,
          corrupted: ['line:2:parent_hash_mismatch'],
          missingKey: false,
          tier: 'confidential',
          tenant_slug: 'acme',
        },
      ],
      withheld: 1,
    });
    const { collectAuditVerifyReport, formatAuditVerifyReport } = await import('./audit_verify.js');

    const report = collectAuditVerifyReport();

    expect(report.ok).toBe(false);
    // The system ledger is reported once (from the explicit path list).
    expect(report.ledgers.map((ledger) => ledger.path)).toEqual([
      'active/audit/system-ledger.jsonl',
      tenantPath,
    ]);
    expect(report.ledgers[1]).toMatchObject({ tenant_slug: 'acme', tier: 'confidential' });
    expect(report.tenantLedgersWithheld).toBe(1);
    const text = formatAuditVerifyReport(report).join('\n');
    expect(text).toContain('tenant=acme');
    expect(text).toContain('tenant ledgers withheld: 1');
  });

  it('accepts an unkeyed legacy prefix only when explicitly allowed, and reports it', async () => {
    mocks.auditVerify.mockReturnValue({
      valid: 1,
      corrupted: [],
      total: 1,
      checkedFiles: ['audit-2026-07-04.jsonl'],
      boundaryLimited: false,
      unkeyed: 3,
    });
    mocks.ledgerVerify.mockReturnValue({
      ok: true,
      total: 2,
      corrupted: [],
      missingKey: false,
      unkeyed: 1,
    });
    const { collectAuditVerifyReport, formatAuditVerifyReport } = await import('./audit_verify.js');

    const report = collectAuditVerifyReport({ allowLegacyUnkeyed: true });

    expect(mocks.auditVerify).toHaveBeenCalledWith({ since: undefined, requireKeyed: false });
    expect(mocks.ledgerVerify).toHaveBeenCalledWith('active/audit/system-ledger.jsonl', {
      requireKeyed: false,
    });
    expect(report.ok).toBe(true);
    expect(report.ledgers[0]).toMatchObject({ unkeyed: 1 });
    const text = formatAuditVerifyReport(report).join('\n');
    expect(text).toContain('unkeyed legacy entries: 3');
    expect(text).toContain('unkeyed legacy entries: 1');
  });
});
