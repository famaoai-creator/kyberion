import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import type { EventScopeInput } from './event-scope.js';
import {
  EXECUTION_METRICS_LEDGER_ROOT,
  MetricsCollector,
  executionMetricsProtectedPrefixes,
} from './metrics.js';

/**
 * W1: execution metrics (`MetricsCollector.record`) are partitioned by tier
 * and tenant exactly like the resource-usage ledger.
 */
describe('execution-metrics ledger partitioning', () => {
  const base = path.join(process.cwd(), 'active/shared/tmp/execution-metrics-partition-test');
  const metricsDir = path.join(base, 'metrics');
  const executionRoot = path.join(base, 'execution-ledger');
  const systemFile = path.join(metricsDir, 'execution-metrics.jsonl');
  const partitionFile = (...segments: string[]) =>
    path.join(executionRoot, ...segments, 'execution-metrics.jsonl');
  const collector = () =>
    new MetricsCollector({ metricsDir, executionMetricsRoot: executionRoot, costRegistry: REG });
  const REG = { models: {}, aliases: {}, default: { prompt: 0, completion: 0 } };
  const read = (file: string) =>
    safeExistsSync(file) ? String(safeReadFile(file, { encoding: 'utf8' })) : '';
  const record = (mc: MetricsCollector, component: string, scope?: EventScopeInput) =>
    mc.record(component, 10, 'success', {
      mission_id: 'MSN-EXEC-PARTITION-1',
      ...(scope ? { scope } : {}),
    });
  const components = (rows: Array<Record<string, unknown>>) =>
    rows.map((row) => String(row.component)).sort();
  const legacyRow = (component: string, tenant: string, timestamp = '2026-10-01T00:00:00.000Z') =>
    `${JSON.stringify({
      component,
      duration_ms: 1,
      status: 'success',
      timestamp,
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenant },
    })}\n`;

  beforeEach(() => safeRmSync(base, { recursive: true, force: true }));
  afterEach(() => safeRmSync(base, { recursive: true, force: true }));

  it('lands a confidential tenant row in its tenant partition, never in the shared file', () => {
    record(collector(), 'tenant-a-call', {
      tier: 'confidential',
      tenant_slug: 'tenant-a',
    });
    expect(read(systemFile)).not.toContain('tenant-a-call');
    expect(read(partitionFile('confidential', 'tenant-a'))).toContain('tenant-a-call');
  });

  it('lands an untenanted personal row in the <tier>/shared partition', () => {
    record(collector(), 'personal-call', { tier: 'personal' });
    expect(read(systemFile)).toBe('');
    expect(read(partitionFile('personal', 'shared'))).toContain('personal-call');
  });

  it('keeps unscoped, public and intervention rows in the system file and the default reader', () => {
    const mc = collector();
    record(mc, 'unscoped-call');
    record(mc, 'public-call', { tier: 'public' });
    mc.recordIntervention('ctx', 'decision-1');
    expect(read(systemFile)).toContain('unscoped-call');
    expect(read(systemFile)).toContain('public-call');
    expect(read(systemFile)).toContain('decision-1');
    expect(safeExistsSync(executionRoot)).toBe(false);
    expect(components(mc.loadHistory().filter((row) => row.component))).toEqual([
      'public-call',
      'unscoped-call',
    ]);
  });

  it("never shows tenant A's reader tenant B's rows (partitioned or legacy)", () => {
    const mc = collector();
    record(mc, 'a-1', { tier: 'confidential', tenant_slug: 'tenant-a' });
    record(mc, 'b-1', { tier: 'confidential', tenant_slug: 'tenant-b' });
    record(mc, 'sys-1');
    // Pre-partition mixed rows stay readable as legacy, filtered by their own scope.
    safeAppendFileSync(systemFile, legacyRow('legacy-a', 'tenant-a'));
    safeAppendFileSync(systemFile, legacyRow('legacy-b', 'tenant-b'));

    const tenantA = { scope: { tier: 'confidential', tenant_slug: 'tenant-a' } };
    expect(components(mc.loadHistory({ read: tenantA }))).toEqual(['a-1', 'legacy-a']);
    expect(components(mc.loadHistory({ read: { tenants: ['tenant-b'] } }))).toEqual([
      'b-1',
      'legacy-b',
    ]);
    expect(
      components(mc.loadHistory({ read: { tenants: ['tenant-b'], includeSystem: true } }))
    ).toEqual(['b-1', 'legacy-b', 'sys-1']);
    // The system reader sees neither tenant, even the legacy rows in its own file.
    expect(components(mc.loadHistory())).toEqual(['sys-1']);
    expect(components(mc.loadHistory({ read: { ...tenantA, includeSystem: true } }))).toEqual([
      'a-1',
      'legacy-a',
      'sys-1',
    ]);
    // The operator aggregate sees every partition.
    expect(components(mc.loadHistory({ read: { all: true } }))).toEqual([
      'a-1',
      'b-1',
      'legacy-a',
      'legacy-b',
      'sys-1',
    ]);
  });

  it('numbers malformed lines through the system file and partitions as one file', () => {
    safeMkdir(metricsDir, { recursive: true });
    safeWriteFile(systemFile, '{"component":"s1","timestamp":"t1"}\n{torn\n');
    safeMkdir(path.dirname(partitionFile('confidential', 'tenant-a')), { recursive: true });
    safeWriteFile(
      partitionFile('confidential', 'tenant-a'),
      `{"component":"p1","timestamp":"t2","scope":{"tier":"confidential","tenant_slug":"tenant-a"}}\n{torn2\n`
    );
    const malformed: Array<[number, string]> = [];
    const rows = collector().loadHistory({
      strict: true,
      read: { all: true },
      onMalformed: (line, raw) => malformed.push([line, raw]),
    });
    expect(components(rows)).toEqual(['p1', 's1']);
    expect(malformed).toEqual([
      [2, '{torn'],
      [4, '{torn2'],
    ]);
  });

  it('reports and detects regressions across partitions only when asked, in time order', () => {
    const mc = collector();
    safeMkdir(metricsDir, { recursive: true });
    const row = (ms: number, timestamp: string, tenant?: string) =>
      `${JSON.stringify({
        skill: 'slow-skill',
        component: 'slow-skill',
        duration_ms: ms,
        status: 'success',
        timestamp,
        ...(tenant ? { scope: { tier: 'confidential', tenant_slug: tenant } } : {}),
      })}\n`;
    // System rows are old and fast; the tenant partition holds the latest, slow run.
    for (let i = 0; i < 5; i++)
      safeAppendFileSync(systemFile, row(100, `2026-10-0${i + 1}T00:00:00Z`));
    safeMkdir(path.dirname(partitionFile('confidential', 'tenant-a')), { recursive: true });
    safeWriteFile(
      partitionFile('confidential', 'tenant-a'),
      row(1000, '2026-10-07T00:00:00Z', 'tenant-a')
    );
    expect(mc.detectRegressions(1.5)).toEqual([]);
    expect(mc.detectRegressions(1.5, { all: true })).toMatchObject([
      { skill: 'slow-skill', lastDuration: 1000 },
    ]);
    expect(mc.reportFromHistory().totalEntries).toBe(5);
    const all = mc.reportFromHistory({ all: true });
    expect(all.totalEntries).toBe(6);
    expect(all.dateRange?.to).toBe('2026-10-07T00:00:00Z');
  });

  it('keeps the protected partition prefixes in security-policy tenant_scope', () => {
    const policy = JSON.parse(
      String(
        safeReadFile(
          path.join(process.cwd(), 'knowledge/product/governance/security-policy.json'),
          { encoding: 'utf8' }
        )
      )
    ) as { tenant_scope: { protected_prefixes: string[] } };
    expect(executionMetricsProtectedPrefixes()).toEqual([
      `${EXECUTION_METRICS_LEDGER_ROOT}/personal/`,
      `${EXECUTION_METRICS_LEDGER_ROOT}/confidential/`,
    ]);
    for (const prefix of executionMetricsProtectedPrefixes()) {
      expect(policy.tenant_scope.protected_prefixes).toContain(prefix);
    }
  });

  it('has a review_required retention-catalog entry for the partition root', () => {
    const catalog = JSON.parse(
      String(
        safeReadFile(
          path.join(process.cwd(), 'knowledge/product/governance/storage-retention-catalog.json'),
          { encoding: 'utf8' }
        )
      )
    ) as { entries?: Array<{ path: string; action: string }> };
    const entries = Object.values(catalog).flatMap((value) => (Array.isArray(value) ? value : []));
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: EXECUTION_METRICS_LEDGER_ROOT,
          action: 'review_required',
        }),
      ])
    );
  });

  it('defaults the partition root into the Vitest live sandbox', () => {
    const root = pathResolver.shared('runtime/execution-metrics');
    expect(
      root.startsWith(path.join(pathResolver.rootDir(), pathResolver.VITEST_LIVE_SANDBOX_ROOT))
    ).toBe(true);
  });
});
