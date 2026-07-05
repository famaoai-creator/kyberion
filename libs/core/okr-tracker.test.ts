import { afterEach, describe, expect, it } from 'vitest';
import {
  createOkrTracker,
  hydrateOkrTracker,
  resolveOkrTracker,
  summarizeOkrTracker,
} from './okr-tracker.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('okr-tracker', () => {
  const tmpRoot = pathResolver.sharedTmp('okr-tracker-test');

  afterEach(() => {
    if (safeExistsSync(tmpRoot)) {
      safeRmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('loads an OKR tracker from governance storage and summarizes it', () => {
    safeMkdir(`${tmpRoot}/knowledge/product/governance`, { recursive: true });
    safeWriteFile(
      `${tmpRoot}/knowledge/product/governance/okr.json`,
      JSON.stringify(
        {
          company_id: 'acme',
          tenant_slug: 'acme',
          source_kind: 'public',
          source_path: 'placeholder',
          period: { period_id: '2026-h2', label: 'H2 2026' },
          objectives: [
            {
              objective: 'Improve operator confidence',
              key_results: [
                { metric: 'completed_missions', target: 10, current: 4, owner_role: 'ceo' },
                {
                  metric: 'gross_profit_jpy',
                  target: 500000,
                  current: 450000,
                  owner_role: 'finance_controller',
                },
              ],
            },
          ],
        },
        null,
        2
      )
    );

    const tracker = resolveOkrTracker('acme', tmpRoot);
    const summary = summarizeOkrTracker(tracker);

    expect(tracker.source_kind).toBe('public');
    expect(tracker.objectives).toHaveLength(1);
    expect(summary?.objective_count).toBe(1);
    expect(summary?.key_result_count).toBe(2);
    expect(summary?.progress_percent).toBe(0);
  });

  it('hydrates key results from financial and operational sources', () => {
    const tracker = createOkrTracker({
      companyId: 'acme',
      tenantSlug: 'acme',
      objectives: [
        {
          objective: 'Grow revenue',
          key_results: [
            {
              metric: 'revenue_jpy',
              target: 1000000,
              current: null,
              owner_role: 'finance_controller',
            },
            { metric: 'blocked_missions', target: 2, current: null, owner_role: 'mission_owner' },
          ],
        },
      ],
    });

    const hydrated = hydrateOkrTracker(tracker, {
      financial: {
        company_id: 'acme',
        tenant_slug: 'acme',
        source_kind: 'confidential',
        source_path: '/tmp/financial-model.json',
        periods: [
          {
            period_id: 'latest',
            label: 'Latest',
            revenue_jpy: 1200000,
            operating_cost_jpy: 700000,
            gross_profit_jpy: 500000,
          },
        ],
      },
      missionCompletedCount: 5,
      missionBlockedCount: 1,
      operationalMetrics: { completed_missions: '5' },
    });

    expect(hydrated.objectives[0]?.key_results[0]?.current).toBe(1200000);
    expect(hydrated.objectives[0]?.key_results[0]?.source).toBe('financial');
    expect(hydrated.objectives[0]?.key_results[1]?.current).toBe(1);
    expect(hydrated.objectives[0]?.key_results[1]?.source).toBe('mission');
  });
});
