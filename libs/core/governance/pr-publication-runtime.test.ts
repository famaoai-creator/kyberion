import { describe, expect, it, vi } from 'vitest';
import {
  currentPrPublicationScope,
  withPrPublicationRuntime,
  withPrPublicationStoreAccess,
} from './pr-publication-runtime.js';
import { prPublicationResourceAllowed } from '../foundation/pr-publication-store-capability.js';

const invocation = 'a'.repeat(64);
describe('PR publication store capability', () => {
  it('rejects invalid tenants and missing host bindings', () => {
    expect(() =>
      withPrPublicationRuntime(
        { kind: 'organization', tenant_slug: '../other' },
        invocation,
        () => {}
      )
    ).toThrow('Valid publication scope');
    expect(() =>
      withPrPublicationRuntime(
        { kind: 'organization', tenant_slug: 'personal' },
        invocation,
        () => {}
      )
    ).toThrow('Valid publication scope');
    expect(() =>
      withPrPublicationStoreAccess('charter-read', ['knowledge/personal/charters'], [], () => {})
    ).toThrow('Trusted publication host');
    expect(prPublicationResourceAllowed('knowledge/personal/charters', 'read')).toBe(false);
  });
  it('bounds role IO to exact resources and never grants charter acceptance writes', () => {
    withPrPublicationRuntime({ kind: 'person' }, invocation, () => {
      const snapshot = currentPrPublicationScope()!;
      snapshot.kind = 'organization';
      expect(currentPrPublicationScope()).toEqual({ kind: 'person' });
      withPrPublicationStoreAccess(
        'charter-read',
        ['knowledge/personal/charters/chr-one.json'],
        [],
        () => {
          expect(
            prPublicationResourceAllowed('knowledge/personal/charters/chr-one.json', 'read')
          ).toBe(true);
          expect(
            prPublicationResourceAllowed('knowledge/personal/charters/chr-other.json', 'read')
          ).toBe(false);
          expect(
            prPublicationResourceAllowed('knowledge/personal/charters/chr-one.json', 'write')
          ).toBe(false);
        }
      );
      expect(() =>
        withPrPublicationStoreAccess(
          'charter-read',
          [],
          ['knowledge/personal/charters/chr-one.json'],
          () => {}
        )
      ).toThrow('outside publication store');
      expect(() =>
        withPrPublicationStoreAccess(
          'charter-ledger-write',
          [],
          ['knowledge/personal/charters/chr-one.ledger.jsonl'],
          () => {}
        )
      ).toThrow('outside publication store');
    });
  });
  it('binds organization ledger writes to the runtime tenant and rejects charter JSON writes', () => {
    withPrPublicationRuntime({ kind: 'organization', tenant_slug: 'acme' }, invocation, () => {
      expect(() =>
        withPrPublicationStoreAccess(
          'charter-ledger-write',
          [],
          ['knowledge/confidential/other/charters/chr-one.ledger.jsonl'],
          () => {}
        )
      ).toThrow('outside publication store');
      expect(() =>
        withPrPublicationStoreAccess(
          'charter-ledger-write',
          [],
          ['knowledge/confidential/acme/charters/chr-one.json'],
          () => {}
        )
      ).toThrow('outside publication store');
      withPrPublicationStoreAccess(
        'charter-ledger-write',
        [],
        ['knowledge/confidential/acme/charters/chr-one.ledger.jsonl'],
        () => {
          expect(
            prPublicationResourceAllowed(
              'knowledge/confidential/acme/charters/chr-one.ledger.jsonl',
              'write'
            )
          ).toBe(true);
        }
      );
    });
  });

  const ledger = 'knowledge/confidential/acme/charters/chr-one.ledger.jsonl';
  const acme = { kind: 'organization' as const, tenant_slug: 'acme' };
  const openLedger = (check: () => void) =>
    withPrPublicationRuntime(acme, invocation, () =>
      withPrPublicationStoreAccess('charter-ledger-write', [ledger], [ledger], check)
    );

  it('authorizes nothing to a continuation captured inside the grant (escape)', async () => {
    let escaped: (() => boolean) | undefined;
    let escapedBinding: (() => unknown) | undefined;
    openLedger(() => {
      escaped = () => prPublicationResourceAllowed(ledger, 'write');
      escapedBinding = () => currentPrPublicationScope();
      expect(escaped()).toBe(true);
    });
    expect(escaped!()).toBe(false);
    expect(escapedBinding!()).toBeUndefined();
    const later = await new Promise<boolean>((resolve) =>
      openLedger(() => {
        setTimeout(() => resolve(prPublicationResourceAllowed(ledger, 'write')), 0);
      })
    );
    expect(later).toBe(false);
  });

  it('is synchronous: a thenable result is refused and its continuation is denied', async () => {
    let continuation: Promise<boolean> | undefined;
    expect(() =>
      openLedger(() => {
        continuation = Promise.resolve().then(() => prPublicationResourceAllowed(ledger, 'write'));
        return continuation as unknown as void;
      })
    ).toThrow('synchronous only');
    await expect(continuation).resolves.toBe(false);
  });

  it('ends the publication binding when an async host run settles', async () => {
    let afterSettle: (() => unknown) | undefined;
    await withPrPublicationRuntime(acme, invocation, async () => {
      await Promise.resolve();
      expect(currentPrPublicationScope()).toEqual(acme);
      afterSettle = () => currentPrPublicationScope();
      withPrPublicationStoreAccess('charter-ledger-write', [], [ledger], () =>
        expect(prPublicationResourceAllowed(ledger, 'append')).toBe(true)
      );
    });
    expect(afterSettle!()).toBeUndefined();
    expect(() =>
      withPrPublicationRuntime(acme, invocation, () => {
        throw new Error('host failed');
      })
    ).toThrow('host failed');
  });

  it('cannot be forged: the binding is frozen and lookalike scopes resolve nothing', () => {
    withPrPublicationRuntime(acme, invocation, () => {
      const forged = currentPrPublicationScope() as { tenant_slug: string };
      forged.tenant_slug = 'other';
      expect(currentPrPublicationScope()).toEqual(acme);
      expect(() =>
        withPrPublicationStoreAccess(
          'charter-ledger-write',
          [],
          ['knowledge/confidential/other/charters/chr-one.ledger.jsonl'],
          () => {}
        )
      ).toThrow('outside publication store');
      // A binding alone (no store grant) authorizes no resource.
      expect(prPublicationResourceAllowed(ledger, 'write')).toBe(false);
      expect(prPublicationResourceAllowed('knowledge/product/governance', 'read')).toBe(false);
    });
    expect(() =>
      withPrPublicationStoreAccess('charter-ledger-write', [], [ledger], () => {})
    ).toThrow('Trusted publication host');
    expect(() =>
      withPrPublicationRuntime(acme, invocation, () => {}, 'vcs:delete' as never)
    ).toThrow('Typed VCS mutation');
  });

  it('is not honoured by a second module instance, in either direction (counterfeit)', async () => {
    vi.resetModules();
    const second = {
      ...(await import('./pr-publication-runtime.js')),
      ...(await import('../foundation/pr-publication-store-capability.js')),
    };
    expect(second.prPublicationResourceAllowed).not.toBe(prPublicationResourceAllowed);
    second.withPrPublicationRuntime(acme, invocation, () =>
      second.withPrPublicationStoreAccess('charter-ledger-write', [], [ledger], () => {
        expect(second.prPublicationResourceAllowed(ledger, 'write')).toBe(true);
        expect(prPublicationResourceAllowed(ledger, 'write')).toBe(false);
        expect(currentPrPublicationScope()).toBeUndefined();
        expect(() =>
          withPrPublicationStoreAccess('charter-ledger-write', [], [ledger], () => {})
        ).toThrow('Trusted publication host');
      })
    );
    openLedger(() => {
      expect(prPublicationResourceAllowed(ledger, 'write')).toBe(true);
      expect(second.prPublicationResourceAllowed(ledger, 'write')).toBe(false);
      expect(second.currentPrPublicationScope()).toBeUndefined();
    });
  });
});
