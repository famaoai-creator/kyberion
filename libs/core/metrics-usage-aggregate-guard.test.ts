import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MetricsCollector } from './metrics.js';

// Simulate a process bound to tenant-a: tier-guard denies every tenant-b path.
vi.mock('./tier-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tier-guard.js')>();
  return {
    ...actual,
    validateReadPermission: (filePath: string) =>
      /[\\/]tenant-b[\\/]/u.test(filePath)
        ? { allowed: false, reason: '[POLICY_VIOLATION] tenant.scope_violation (test)' }
        : actual.validateReadPermission(filePath),
  };
});

describe('resource-usage operator aggregate under a tenant binding', () => {
  const base = path.join(process.cwd(), 'active/shared/tmp/resource-usage-aggregate-guard-test');
  const metricsDir = path.join(base, 'metrics');
  const usageRoot = path.join(base, 'usage-ledger');
  const collector = () => new MetricsCollector({ metricsDir, resourceUsageRoot: usageRoot });

  beforeEach(() => fs.rmSync(base, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it("withholds another tenant's partition and legacy rows from { all: true }", () => {
    const mc = collector();
    for (const [usageId, tenant] of [
      ['a-1', 'tenant-a'],
      ['sys-1', undefined],
    ] as const) {
      mc.recordResourceUsage({
        usage_id: usageId,
        resource_kind: 'other',
        quantity: 0,
        unit: 'task',
        status: 'estimated',
        source: 'aggregate-guard-test',
        scope: tenant ? { tier: 'confidential', tenant_slug: tenant } : { tier: 'public' },
      });
    }
    // tenant-b data from an unbound writer: its partition plus a pre-partition legacy row.
    const tenantB = path.join(usageRoot, 'confidential', 'tenant-b');
    fs.mkdirSync(tenantB, { recursive: true });
    const row = (usageId: string, tenant: string) =>
      `${JSON.stringify({
        type: 'resource_usage',
        usage_id: usageId,
        cost_usd: 0,
        scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenant },
      })}\n`;
    fs.writeFileSync(path.join(tenantB, 'resource-usage.jsonl'), row('b-1', 'tenant-b'));
    fs.appendFileSync(path.join(metricsDir, 'resource-usage.jsonl'), row('legacy-b', 'tenant-b'));
    fs.appendFileSync(path.join(metricsDir, 'resource-usage.jsonl'), row('legacy-a', 'tenant-a'));

    const seen = mc
      .loadResourceUsageHistory({ all: true })
      .map((record) => record.usage_id)
      .sort();
    expect(seen).toEqual(['a-1', 'legacy-a', 'sys-1']);
  });
});
