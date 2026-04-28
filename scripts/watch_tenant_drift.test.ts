import { describe, expect, it } from 'vitest';
import { scanTenantDrift } from './watch_tenant_drift.js';

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
});
