import * as path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MetricsCollector } from './metrics.js';
import { pathResolver } from './path-resolver.js';
import { physicalScopedPath } from './physical-namespace.js';
import { normalizeEventScope } from './event-scope.js';
import { tenantRuntimePartitionOf } from './storage-layout.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  GENERATION_COST_SETTLEMENT_ROOT,
  generationCostSettlementRelativePath,
  listGenerationCostSettlements,
  loadGenerationCostSettlementAtPath,
  settleGenerationProviderCost,
} from './generation-cost-settlement.js';

const testRoot = pathResolver.sharedTmp('generation-cost-settlement-tests');
const metricsDir = pathResolver.sharedTmp('generation-cost-settlement-tests/metrics');
const tenantScope = {
  scope_kind: 'tenant' as const,
  tier: 'confidential' as const,
  tenant_slug: 'tenant-a',
};

describe('generation cost settlement', () => {
  beforeEach(() => {
    safeRmSync(testRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    safeRmSync(testRoot, { recursive: true, force: true });
  });

  it('records provider actual cost once and preserves its tenant scope', () => {
    const collector = new MetricsCollector({ metricsDir });
    const job = {
      job_id: 'generation-job-1',
      action: 'generate_video',
      status: 'succeeded',
      scope: tenantScope,
      provider: { engine: 'runway' },
      result: { backend_id: 'runway-video', provider_metadata: { actual_cost_usd: 1.25 } },
    };

    const first = settleGenerationProviderCost(job, {
      rootDir: testRoot,
      metricsCollector: collector,
      now: new Date('2026-08-16T00:00:00.000Z'),
    });
    const second = settleGenerationProviderCost(job, {
      rootDir: testRoot,
      metricsCollector: collector,
      now: new Date('2026-08-16T00:01:00.000Z'),
    });

    expect(first.status).toBe('settled');
    expect(first.actual_cost_usd).toBe(1.25);
    expect(second.settlement_id).toBe(first.settlement_id);
    // Tenant usage lands in the tenant partition, never the system ledger.
    expect(collector.loadResourceUsageHistory()).toHaveLength(0);
    expect(collector.loadResourceUsageHistory({ scope: tenantScope })).toHaveLength(1);
    expect(
      listGenerationCostSettlements({
        rootDir: testRoot,
        scopeFilter: { tenant_slugs: ['tenant-a'] },
      })
    ).toHaveLength(1);
    expect(
      listGenerationCostSettlements({
        rootDir: testRoot,
        scopeFilter: { tenant_slugs: ['tenant-b'] },
      })
    ).toHaveLength(0);
  });

  it('keeps a terminal job visible as awaiting actual cost until the provider reports one', () => {
    const unavailable = settleGenerationProviderCost(
      {
        job_id: 'generation-job-2',
        action: 'generate_music',
        status: 'failed',
        scope: tenantScope,
        provider: { engine: 'suno' },
        result: { estimated_cost_usd: 0.4 },
      },
      { rootDir: testRoot, metricsCollector: new MetricsCollector({ metricsDir }) }
    );
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.actual_cost_usd).toBeUndefined();

    const settled = settleGenerationProviderCost(
      {
        job_id: 'generation-job-2',
        action: 'generate_music',
        status: 'failed',
        scope: tenantScope,
        provider: { engine: 'suno' },
        result: { actual_cost_usd: 0.2 },
      },
      { rootDir: testRoot, metricsCollector: new MetricsCollector({ metricsDir }) }
    );
    expect(settled.status).toBe('settled');
    expect(settled.actual_cost_usd).toBe(0.2);
    expect(collectorEntries()).toHaveLength(1);
  });

  it('loads a settlement through schema, job, and physical scope bindings', () => {
    const jobId = 'generation-job-loader';
    const settlement = settleGenerationProviderCost(
      {
        job_id: jobId,
        action: 'generate_video',
        status: 'succeeded',
        scope: tenantScope,
        result: { actual_cost_usd: 0.75 },
      },
      { rootDir: testRoot, metricsCollector: new MetricsCollector({ metricsDir }) }
    );
    const filePath = path.join(
      testRoot,
      generationCostSettlementRelativePath(jobId, normalizeEventScope(tenantScope))
    );

    expect(
      loadGenerationCostSettlementAtPath(filePath, {
        jobId,
        scope: tenantScope,
        rootDir: testRoot,
      })
    ).toEqual(settlement);
    expect(() => loadGenerationCostSettlementAtPath(filePath, { jobId: 'other-job' })).toThrow(
      'job scope mismatch'
    );
  });

  it('rejects malformed and non-file settlement records before listing them', () => {
    const jobId = 'generation-job-invalid';
    const settlement = settleGenerationProviderCost(
      {
        job_id: jobId,
        action: 'generate_music',
        status: 'failed',
        scope: tenantScope,
        result: { actual_cost_usd: 0.25 },
      },
      { rootDir: testRoot, metricsCollector: new MetricsCollector({ metricsDir }) }
    );
    const filePath = path.join(
      testRoot,
      generationCostSettlementRelativePath(jobId, normalizeEventScope(tenantScope))
    );
    safeWriteFile(filePath, JSON.stringify({ ...settlement, unexpected: true }));
    expect(() => loadGenerationCostSettlementAtPath(filePath, { rootDir: testRoot })).toThrow(
      'Invalid catalog generation-cost-settlement'
    );
    expect(listGenerationCostSettlements({ rootDir: testRoot })).toHaveLength(0);

    const directoryPath = path.join(testRoot, 'settlement-directory.json');
    safeMkdir(directoryPath, { recursive: true });
    try {
      expect(() =>
        loadGenerationCostSettlementAtPath(directoryPath, { rootDir: testRoot })
      ).toThrow('settlement must be a regular file');
    } finally {
      safeRmSync(directoryPath, { recursive: true, force: true });
    }
  });

  it('writes tenant settlements into the registered <tier>/<tenant> partition (offboarding/backup visible)', () => {
    const jobId = 'generation-job-partitioned';
    const scope = { ...tenantScope, organization_id: 'org-a', project_id: 'proj-x' };
    settleGenerationProviderCost(
      {
        job_id: jobId,
        action: 'generate_video',
        status: 'succeeded',
        scope,
        result: { actual_cost_usd: 0.5 },
      },
      { rootDir: testRoot, metricsCollector: new MetricsCollector({ metricsDir }) }
    );
    const relative = generationCostSettlementRelativePath(jobId, normalizeEventScope(scope));
    expect(relative).toBe(
      `${GENERATION_COST_SETTLEMENT_ROOT}/confidential/tenant-a/organizations/org-a/projects/proj-x/${jobId}.json`
    );
    expect(safeExistsSync(path.join(testRoot, relative))).toBe(true);
    expect(tenantRuntimePartitionOf(relative)).toMatchObject({
      key: 'generation_cost_settlements',
      tier: 'confidential',
      tenant: 'tenant-a',
    });
    expect(
      generationCostSettlementRelativePath(
        'system-job',
        normalizeEventScope({ scope_kind: 'system', tier: 'public' })
      )
    ).toBe(`${GENERATION_COST_SETTLEMENT_ROOT}/system/system-job.json`);
  });

  it('reads a pre-migration settlement and moves it to the partition on the next write', () => {
    const jobId = 'generation-job-legacy';
    const legacyRelative = physicalScopedPath(
      GENERATION_COST_SETTLEMENT_ROOT,
      tenantScope,
      `${jobId}.json`
    );
    const legacy = {
      kind: 'generation-cost-settlement',
      settlement_id: `generation:${jobId}`,
      job_id: jobId,
      action: 'generate_video',
      status: 'unavailable',
      currency: 'USD',
      scope: normalizeEventScope(tenantScope),
      observed_at: '2026-08-01T00:00:00.000Z',
      source: 'provider-reported',
    };
    safeMkdir(path.dirname(path.join(testRoot, legacyRelative)), { recursive: true });
    safeWriteFile(path.join(testRoot, legacyRelative), JSON.stringify(legacy));

    // Still listed, and an unpriced re-settle returns it rather than a duplicate.
    expect(listGenerationCostSettlements({ rootDir: testRoot })).toEqual([legacy]);
    const job = {
      job_id: jobId,
      action: 'generate_video',
      status: 'succeeded',
      scope: tenantScope,
    };
    expect(settleGenerationProviderCost(job, { rootDir: testRoot })).toEqual(legacy);

    // A priced settle writes the partitioned copy and drops the legacy one.
    const settled = settleGenerationProviderCost(
      { ...job, result: { actual_cost_usd: 0.4 } },
      { rootDir: testRoot, metricsCollector: new MetricsCollector({ metricsDir }) }
    );
    expect(settled.status).toBe('settled');
    expect(safeExistsSync(path.join(testRoot, legacyRelative))).toBe(false);
    expect(
      safeExistsSync(
        path.join(
          testRoot,
          generationCostSettlementRelativePath(jobId, normalizeEventScope(tenantScope))
        )
      )
    ).toBe(true);
    expect(listGenerationCostSettlements({ rootDir: testRoot })).toEqual([settled]);
  });

  it('rejects an external settlement root before writing provider cost', () => {
    expect(() =>
      settleGenerationProviderCost(
        {
          job_id: 'generation-job-external',
          action: 'generate_video',
          status: 'succeeded',
          scope: tenantScope,
          result: { actual_cost_usd: 1 },
        },
        { rootDir: '/tmp' }
      )
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });
});

function collectorEntries() {
  return new MetricsCollector({ metricsDir }).loadResourceUsageHistory({ scope: tenantScope });
}

describe('generation cost settlement — default repository root', () => {
  it('lists from the repository root without a rootDir (Chronos /api/cost path)', () => {
    // Regression: the default root was itself passed to assertSafeRepositoryPath,
    // which only admits paths strictly inside the root, so every call threw
    // [RESOURCE_PATH_SCOPE] and /api/cost answered 500.
    expect(() =>
      listGenerationCostSettlements({
        scopeFilter: { tenant_slugs: ['tenant-default-root-probe'] },
      })
    ).not.toThrow();
  });

  it('still refuses a caller-chosen rootDir outside the repository', () => {
    expect(() => listGenerationCostSettlements({ rootDir: '/' })).toThrow(/RESOURCE_PATH_SCOPE/);
  });
});
