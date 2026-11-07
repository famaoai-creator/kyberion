import { describe, expect, it } from 'vitest';
import {
  getUsageAttribution,
  normalizeUsageCause,
  USAGE_CAUSES,
  withUsageAttribution,
  resolveUsageCostAccounting,
  hasUsageCostEvidence,
} from './usage-accounting.js';

describe('usage accounting', () => {
  it('distinguishes observed usage/cost metadata from unrelated operational metrics', () => {
    expect(hasUsageCostEvidence({})).toBe(false);
    for (const evidence of [
      { usage: {} },
      { input_tokens: 0 },
      { reference_cost_usd: 0 },
      { billing_mode: 'unknown' },
      { type: 'resource_usage' },
    ])
      expect(hasUsageCostEvidence(evidence)).toBe(true);
  });
  it('preserves reported zero and prefers provider reports over token estimates', () => {
    expect(
      resolveUsageCostAccounting({ reported_cost_usd: 0, sdk_cost_usd: 3, cost_usd: 4 })
    ).toMatchObject({ cost_usd: 0, cost_status: 'actual', cost_source: 'provider_report' });
    expect(resolveUsageCostAccounting({ sdk_cost_usd: 0, cost_usd: 4 }).cost_usd).toBe(0);
    expect(
      resolveUsageCostAccounting({ reported_cost_usd: 2, cost_usd: 4, cost_status: 'estimated' })
    ).toMatchObject({ cost_usd: 2, cost_status: 'actual' });
  });

  it('keeps included cash separate from reference estimates and usage provenance', () => {
    for (const billing_mode of ['unknown', 'subscription_included'] as const)
      expect(
        resolveUsageCostAccounting({
          billing_mode,
          reference_cost_usd: 0.02,
          cost_source: 'provider_report',
        })
      ).toMatchObject({
        cost_usd: billing_mode === 'unknown' ? null : 0,
        reference_cost_usd: 0.02,
        cost_source: 'provider_report',
      });
    expect(
      resolveUsageCostAccounting({
        billing_mode: 'subscription_included',
        cost_usd: 4,
        reference_cost_usd: 3,
        usage_source: 'provider',
        cost_source: 'model_registry',
      })
    ).toMatchObject({
      cost_usd: 0,
      cost_status: 'included',
      billing_mode: 'subscription_included',
      reference_cost_usd: 3,
      usage_source: 'provider',
    });
    expect(
      resolveUsageCostAccounting({
        billing_mode: 'unknown',
        cost_usd: 4,
        reference_cost_usd: 4,
        cost_source: 'model_registry',
        usage_source: 'provider',
      })
    ).toMatchObject({
      cost_usd: null,
      cost_status: 'unknown',
      reference_cost_usd: 4,
      usage_source: 'provider',
    });
  });

  it('does not turn missing, invalid, or direct-CLI placeholder evidence into free calls', () => {
    for (const cost of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1])
      expect(resolveUsageCostAccounting({ cost_usd: cost })).toMatchObject({
        cost_usd: null,
        cost_status: 'unknown',
      });
    expect(
      resolveUsageCostAccounting({ source: 'direct_cli', cost_usd: 0, status: 'estimated' })
    ).toMatchObject({ cost_usd: null, cost_status: 'unknown' });
    expect(resolveUsageCostAccounting({ cost_usd: 0, cost_status: 'unknown' }).cost_usd).toBeNull();
    expect(resolveUsageCostAccounting({ cost_usd: 0, reference_cost_usd: 0 })).toMatchObject({
      cost_usd: 0,
      reference_cost_usd: 0,
      cost_status: 'actual',
    });
  });
  it('normalizes unknown or missing causes to the compatible assistant bucket', () => {
    expect(normalizeUsageCause(undefined)).toBe('assistant');
    expect(normalizeUsageCause('future-cause')).toBe('assistant');
    expect(normalizeUsageCause('compaction')).toBe('compaction');
  });

  it('exposes a closed cause vocabulary for reports and ledgers', () => {
    expect(USAGE_CAUSES).toContain('judge');
    expect(new Set(USAGE_CAUSES).size).toBe(USAGE_CAUSES.length);
  });

  it('restores nested attribution after asynchronous failures and freezes labels', async () => {
    const outer = {
      actor_id: 'dot:a',
      scope: { tier: 'confidential' as const, tenant_slug: 'acme', organization_id: 'o1' },
    };
    await withUsageAttribution(outer, async () => {
      const before = getUsageAttribution();
      expect(Object.isFrozen(before)).toBe(true);
      expect(Object.isFrozen(before?.scope)).toBe(true);
      await expect(
        withUsageAttribution({ actor_id: 'dot:b', scope: { tier: 'public' } }, async () => {
          await Promise.resolve();
          expect(getUsageAttribution()?.actor_id).toBe('dot:b');
          throw new Error('failed call');
        })
      ).rejects.toThrow('failed call');
      expect(getUsageAttribution()).toBe(before);
    });
    expect(getUsageAttribution()).toBeUndefined();
  });

  it('isolates concurrently metered dots across awaits', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = withUsageAttribution(
      { actor_id: 'dot:a', scope: { tier: 'confidential', tenant_slug: 'acme' } },
      async () => {
        await barrier;
        return getUsageAttribution();
      }
    );
    const b = withUsageAttribution(
      { actor_id: 'dot:b', scope: { tier: 'confidential', tenant_slug: 'other' } },
      async () => {
        release();
        await Promise.resolve();
        return getUsageAttribution();
      }
    );
    const [first, second] = await Promise.all([a, b]);
    expect(first).toMatchObject({ actor_id: 'dot:a', scope: { tenant_slug: 'acme' } });
    expect(second).toMatchObject({ actor_id: 'dot:b', scope: { tenant_slug: 'other' } });
    expect(getUsageAttribution()).toBeUndefined();
  });
});
