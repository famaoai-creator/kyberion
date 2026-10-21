import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runtimeStatePath } from './runtime-state-roots.js';

describe('runtime state registry', () => {
  it('preserves the global Dot ledgers and refuses invented tenant placement', () => {
    expect(runtimeStatePath('dot.wakeLedger')).toEqual({
      logicalPath: 'active/shared/runtime/dot-wake-ledger.jsonl',
      physicalPath: 'active/shared/runtime/dot-wake-ledger.jsonl',
    });
    expect(() => runtimeStatePath('dot.lifecycleAudit', { tenant_slug: 'acme' })).toThrow(
      'SCOPE_UNSUPPORTED'
    );
  });
  it('single-sources global and tenant memory queue layouts', () => {
    expect(runtimeStatePath('memory.promotionQueue').physicalPath).toBe(
      'active/shared/runtime/memory/promotion-queue.jsonl'
    );
    expect(
      runtimeStatePath('memory.promotionQueue', { tenant_slug: 'acme', tier: 'confidential' })
        .physicalPath
    ).toBe('active/shared/runtime/tenants/acme/memory/promotion-queue.jsonl');
    expect(() => runtimeStatePath('memory.promotionQueue', { tenant_slug: '../other' })).toThrow(
      'TENANT_INVALID'
    );
    expect(() => runtimeStatePath('memory.promotionQueue', { tenant_slug: 'public' })).toThrow(
      'TENANT_INVALID'
    );
  });
  it('keeps personal owner queues separate and never interpolates an NHI into paths', () => {
    const owner = 'nhi:person/example';
    const hash = createHash('sha256').update(owner).digest('hex');
    expect(
      runtimeStatePath('memory.promotionQueue', { tier: 'personal', owner_nhi: owner }).physicalPath
    ).toBe(`active/personal/owners/${hash}/memory/promotion-queue.jsonl`);
    expect(() => runtimeStatePath('memory.promotionQueue', { tier: 'personal' })).toThrow(
      'MEMORY_SCOPE_UNSUPPORTED'
    );
    expect(
      runtimeStatePath('memory.promotionQueue', {
        tier: 'confidential',
        tenant_slug: 'acme',
        owner_nhi: owner,
      }).physicalPath
    ).toBe('active/shared/runtime/tenants/acme/memory/promotion-queue.jsonl');
  });
  it('rejects invalid scopes before selecting any global or personal layout', () => {
    expect(() => runtimeStatePath('__proto__' as never)).toThrow('KEY_INVALID');
    expect(() => runtimeStatePath('memory.promotionQueue', { tier: 'confidential' })).toThrow(
      'TENANT_REQUIRED'
    );
    expect(() => runtimeStatePath('memory.promotionQueue', { tier: 'unknown' as never })).toThrow(
      'TIER_INVALID'
    );
    for (const tenant_slug of ['public', '../other', '']) {
      expect(() =>
        runtimeStatePath('memory.promotionQueue', {
          tier: 'personal',
          owner_nhi: 'owner',
          tenant_slug,
        })
      ).toThrow('TENANT_INVALID');
    }
  });
});
