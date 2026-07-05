import { describe, expect, it, vi } from 'vitest';

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual<typeof import('@agent/core')>('@agent/core');
  return {
    ...actual,
    auditChain: {
      record: vi.fn(),
    },
  };
});
import { recordTenantDriftAudit } from './watch_tenant_drift.js';

describe('watch_tenant_drift audit metadata', () => {
  it('records only summary metadata and omits raw confidential paths', async () => {
    const { auditChain } = await import('@agent/core');
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
