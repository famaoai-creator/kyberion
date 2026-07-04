import { describe, expect, it } from 'vitest';
import { buildTenantDriftAlert, scanTenantDrift } from './watch_tenant_drift.js';

describe('watch_tenant_drift (IP-6)', () => {
  it('returns a structured report shape (no missions to scan in dev)', () => {
    const r = scanTenantDrift();
    expect(r).toHaveProperty('timestamp');
    expect(r).toHaveProperty('scanned_paths');
    expect(r).toHaveProperty('findings');
    expect(typeof r.scanned_paths).toBe('number');
    expect(Array.isArray(r.findings)).toBe(true);
  });

  it('returns no findings when only legacy non-tenant-prefixed confidential missions exist', () => {
    const r = scanTenantDrift();
    // In the dev tree, missions live under confidential/{MSN-...}/ (legacy
    // single-tenant). No slug match → no expected tenant → no findings.
    // This documents the intentional skip behavior.
    expect(r.findings).toEqual([]);
  });

  it('builds an ops alert without embedding confidential finding paths', () => {
    const alert = buildTenantDriftAlert({
      timestamp: '2026-07-04T00:00:00.000Z',
      scanned_paths: 1,
      findings: [
        {
          path: 'active/missions/confidential/acme/MSN-1',
          expected_tenant: 'acme',
          declared_tenant: 'other',
          mission_id: 'MSN-1',
          reason: 'path prefix says acme but mission-state declares other',
        },
      ],
    });

    expect(alert.severity).toBe('critical');
    expect(alert.context).toEqual({
      finding_count: 1,
      scanned_paths: 1,
      timestamp: '2026-07-04T00:00:00.000Z',
    });
    expect(JSON.stringify(alert)).not.toContain('active/missions/confidential/acme/MSN-1');
  });
});
