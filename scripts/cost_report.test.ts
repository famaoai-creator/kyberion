import { afterEach, describe, expect, it, vi } from 'vitest';
import { metrics } from '@agent/core/metrics';
import { formatCostReport } from '@agent/core/cost-report';
import { main } from './cost_report.js';

afterEach(() => vi.restoreAllMocks());

describe('cost report entrypoint', () => {
  it('returns the report without writing or setting an exit code', () => {
    process.exitCode = undefined;

    const report = main(['node', 'cost_report.ts', '--last-days', '1', '--json']);

    expect(report).toMatchObject({
      since: expect.anything(),
      until: null,
      by_mission: expect.any(Array),
      by_cause: expect.any(Array),
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps unknown-only CLI calls and API-equivalent estimates in scoped reports', () => {
    const history = vi.spyOn(metrics, 'loadHistory').mockReturnValue([
      {
        timestamp: '2026-10-28T00:00:00Z',
        mission_id: 'MSN-CLI-COST',
        component: 'codex-cli',
        model: 'unknown-model',
        status: 'actual',
        cost_status: 'unknown',
        billing_mode: 'unknown',
        reference_cost_usd: 0.75,
        usage: { prompt_tokens: 30, completion_tokens: 20 },
        scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
      },
    ] as never);
    vi.spyOn(metrics, 'loadResourceUsageHistory').mockReturnValue([]);
    const report = main(['node', 'cost_report.ts', '--tenant', 'tenant-a', '--json']);
    expect(report).toMatchObject({
      total_usd: 0,
      calls: 1,
      unknown_cost_calls: 1,
      cost_complete: false,
      reference_usd: 0.75,
    });
    expect(history).toHaveBeenCalledWith(
      expect.objectContaining({ read: { tenants: ['tenant-a'], includeSystem: true } })
    );
    const text = formatCostReport(report).join('\n');
    expect(text).toContain('1 unknown');
    expect(text).toContain('known incremental subtotal');
    expect(text).toContain('0.7500');
  });
});
