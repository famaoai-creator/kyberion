import { describe, expect, it } from 'vitest';
import {
  currentPrPublicationScope,
  prPublicationResourceAllowed,
  withPrPublicationRuntime,
  withPrPublicationStoreAccess,
} from './pr-publication-runtime.js';

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
});
