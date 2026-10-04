import { describe, expect, it } from 'vitest';
import {
  getUsageAttribution,
  normalizeUsageCause,
  USAGE_CAUSES,
  withUsageAttribution,
} from './usage-accounting.js';

describe('usage accounting', () => {
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
