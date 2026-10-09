import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import * as pathResolver from './path-resolver.js';

// Capture the metrics logger only; tier-guard and secure-io stay REAL here.
const warnings = vi.hoisted(() => [] as string[]);
vi.mock('./logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logger.js')>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const real = actual.createLogger(name);
      if (name !== 'metrics') return real;
      return { ...real, warn: (message: string) => warnings.push(String(message)) };
    },
  };
});

import { MetricsCollector, RESOURCE_USAGE_LEDGER_ROOT } from './metrics.js';

const base = path.join(process.cwd(), 'active/shared/tmp/resource-usage-tenant-binding-test');
const metricsDir = path.join(base, 'metrics');
const RUN = `binding-${process.pid}`;

function legacyRow(usageId: string, tenant?: string): string {
  return JSON.stringify({
    type: 'resource_usage',
    usage_id: `${RUN}-${usageId}`,
    cost_usd: 0,
    scope: tenant
      ? { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenant }
      : { scope_kind: 'system', tier: 'public' },
  });
}

function ids(records: Array<{ usage_id: string }>): string[] {
  return records
    .map((record) => record.usage_id)
    .filter((id) => id.startsWith(`${RUN}-`))
    .map((id) => id.slice(RUN.length + 1))
    .sort();
}

describe('resource-usage ledger under a real tenant binding', () => {
  const saved = { tenant: process.env.KYBERION_TENANT };

  beforeEach(() => {
    warnings.length = 0;
    safeRmSync(base, { recursive: true, force: true });
    safeMkdir(metricsDir, { recursive: true });
  });

  afterEach(() => {
    if (saved.tenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = saved.tenant;
    safeRmSync(base, { recursive: true, force: true });
  });

  it("withholds another tenant's legacy rows in every read mode (real tier-guard)", () => {
    safeWriteFile(
      path.join(metricsDir, 'resource-usage.jsonl'),
      `${[legacyRow('legacy-a', 'tenant-a'), legacyRow('legacy-b', 'tenant-b'), legacyRow('sys')].join('\n')}\n`
    );
    // Partition paths resolve to the real, tenant-protected ledger root; this
    // test only reads (and nothing exists there for its run id).
    const mc = new MetricsCollector({
      metricsDir,
      resourceUsageRoot: path.join(pathResolver.rootDir(), RESOURCE_USAGE_LEDGER_ROOT),
      persist: false,
    });

    // Unbound operator: every legacy row is visible (unchanged behavior).
    delete process.env.KYBERION_TENANT;
    expect(ids(mc.loadResourceUsageHistory({ tenants: ['tenant-b'] }))).toEqual(['legacy-b']);

    // Bound to tenant-a: tenant-b's legacy rows are withheld in every mode.
    process.env.KYBERION_TENANT = 'tenant-a';
    expect(ids(mc.loadResourceUsageHistory({ tenants: ['tenant-b'] }))).toEqual([]);
    expect(
      ids(mc.loadResourceUsageHistory({ scope: { tier: 'confidential', tenant_slug: 'tenant-b' } }))
    ).toEqual([]);
    expect(
      ids(mc.loadResourceUsageHistory({ scope: { tier: 'confidential', tenant_slug: 'tenant-a' } }))
    ).toEqual(['legacy-a']);
    expect(ids(mc.loadResourceUsageHistory({ all: true }))).toEqual(['legacy-a', 'sys']);
  });

  it('stamps the bound tenant onto a tenant-less personal/confidential row', () => {
    const usageRoot = path.join(base, 'usage-ledger');
    const mc = new MetricsCollector({ metricsDir, resourceUsageRoot: usageRoot });
    process.env.KYBERION_TENANT = 'tenant-a';
    const record = mc.recordResourceUsage({
      usage_id: `${RUN}-stamped`,
      resource_kind: 'other',
      quantity: 0,
      unit: 'task',
      status: 'estimated',
      source: 'binding-test',
      scope: { tier: 'confidential' },
    });
    expect(record.scope?.tenant_slug).toBe('tenant-a');
    const partition = path.join(usageRoot, 'confidential', 'tenant-a', 'resource-usage.jsonl');
    expect(String(safeReadFile(partition, { encoding: 'utf8' }))).toContain(`${RUN}-stamped`);
    expect(safeExistsSync(path.join(usageRoot, 'confidential', 'shared'))).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('warns in the diagnostic format instead of dropping a row silently', () => {
    const usageRoot = path.join(base, 'usage-ledger');
    // The partition ledger path is a directory, so the append must fail.
    safeMkdir(path.join(usageRoot, 'personal', 'shared', 'resource-usage.jsonl'), {
      recursive: true,
    });
    delete process.env.KYBERION_TENANT;
    new MetricsCollector({ metricsDir, resourceUsageRoot: usageRoot }).recordResourceUsage({
      usage_id: `${RUN}-dropped`,
      resource_kind: 'other',
      quantity: 0,
      unit: 'task',
      status: 'estimated',
      source: 'binding-test',
      scope: { tier: 'personal' },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      new RegExp(
        `^resource usage row dropped — .+ \\| next: .+ \\| evidence: usage_id=${RUN}-dropped$`
      )
    );
  });

  it('says "row dropped" with evidence when an execution row cannot be appended', () => {
    const executionRoot = path.join(base, 'execution-ledger');
    safeMkdir(path.join(executionRoot, 'personal', 'shared', 'execution-metrics.jsonl'), {
      recursive: true,
    });
    delete process.env.KYBERION_TENANT;
    new MetricsCollector({ metricsDir, executionMetricsRoot: executionRoot }).record(
      `${RUN}-exec-dropped`,
      1,
      'success',
      { scope: { tier: 'personal' } }
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      new RegExp(
        `^execution metrics row dropped — .+ \\| next: .+ \\| evidence: component=${RUN}-exec-dropped timestamp=\\d{4}-`
      )
    );
  });
});
