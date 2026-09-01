import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MetricsCollector } from './metrics.js';
import { pathResolver } from './path-resolver.js';
import { safeRmSync } from './secure-io.js';
import {
  listGenerationCostSettlements,
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
    expect(collector.loadResourceUsageHistory()).toHaveLength(1);
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
  return new MetricsCollector({ metricsDir }).loadResourceUsageHistory();
}
