import { describe, expect, it, vi } from 'vitest';

vi.mock('@agent/core/governance/audit-chain', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/governance/audit-chain')>(
    '@agent/core/governance/audit-chain'
  );
  return {
    ...actual,
    auditChain: { record: vi.fn() },
  };
});
import { recordTenantDriftAudit } from './watch_tenant_drift.js';

describe('watch_tenant_drift audit metadata', () => {
  it('records only summary metadata and omits raw confidential paths', async () => {
    const { auditChain } = await import('@agent/core/governance/audit-chain');
    const report = {
      timestamp: '2026-07-05T00:00:00.000Z',
      scanned_paths: 4,
      findings: [
        {
          path: 'active/missions/confidential/sbiss/demo',
          expected_tenant: 'sbiss',
          declared_tenant: 'other',
          mission_id: 'mission-1',
          reason: 'mismatch',
        },
      ],
    };

    recordTenantDriftAudit(report);

    expect(auditChain.record).toHaveBeenCalledTimes(1);
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          finding_count: 1,
          scanned_paths: 4,
        },
      })
    );
    expect(JSON.stringify((auditChain.record as any).mock.calls[0][0])).not.toContain(
      'active/missions/confidential/sbiss/demo'
    );
  });
});

describe('watch_tenant_drift tier-root walk', () => {
  it('under a bound tenant, probes only the bound partition — never the protected tier root', async () => {
    vi.resetModules();
    const getAllFilesMock = vi.fn((_dir: string) => [] as string[]);
    vi.doMock('@agent/core/fs-utils', () => ({ getAllFiles: getAllFilesMock }));
    vi.doMock('@agent/core/secure-io', async () => {
      const actual =
        await vi.importActual<typeof import('@agent/core/secure-io')>('@agent/core/secure-io');
      return { ...actual, safeExistsSync: vi.fn(() => true) };
    });
    process.env.KYBERION_TENANT = 'acme-tenant';
    try {
      const { scanTenantDrift } = await import('./watch_tenant_drift.js');
      const report = scanTenantDrift();
      expect(report.scanned_paths).toBe(0);
      expect(getAllFilesMock).toHaveBeenCalledTimes(1);
      const walked = String(getAllFilesMock.mock.calls[0]?.[0] || '');
      expect(walked).toMatch(/missions[/\\]confidential[/\\]acme-tenant$/);
      expect(walked).not.toMatch(/missions[/\\]confidential$/);
    } finally {
      delete process.env.KYBERION_TENANT;
      vi.doUnmock('@agent/core/fs-utils');
      vi.doUnmock('@agent/core/secure-io');
      vi.resetModules();
    }
  });
});
