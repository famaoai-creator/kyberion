import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  auditVerify: vi.fn(),
  auditVerifyTenantMirrors: vi.fn(),
  ledgerVerify: vi.fn(),
  safeExistsSync: vi.fn(),
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    safeExistsSync: mocks.safeExistsSync,
    auditChain: {
      verify: mocks.auditVerify,
      verifyTenantMirrors: mocks.auditVerifyTenantMirrors,
    },
    GLOBAL_LEDGER_PATH: 'active/audit/system-ledger.jsonl',
    verifyLedgerIntegrityDetailed: mocks.ledgerVerify,
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
    mocks.safeExistsSync.mockReturnValue(true);
  });

  it('returns ok when audit chain and ledgers verify', async () => {
    const { collectAuditVerifyReport } = await import('./audit_verify.js');

    const report = collectAuditVerifyReport();

    expect(report.ok).toBe(true);
    expect(mocks.auditVerify).toHaveBeenCalledWith({ since: undefined });
    expect(mocks.ledgerVerify).toHaveBeenCalledWith('active/audit/system-ledger.jsonl');
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
    expect(mocks.auditVerify).toHaveBeenCalledWith({ since: '2026-07-04' });
    expect(mocks.ledgerVerify).toHaveBeenCalledWith('active/missions/demo/evidence/ledger.jsonl');
  });
});
