import { describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { validateReadPermission, validateWritePermission } from '../tier-guard.js';
import { withPersonCharterRegistryAccess } from './person-charter-store-access.js';
import {
  currentInstalledPersonCharterRuntime,
  personCharterGrantAuthorizes,
  personCharterResourceAccessAllowed,
  withInstalledPersonCharterRuntime,
  withPersonCharterStoreAccess,
  withPersonExternalReservationAccess,
} from './person-charter-runtime.js';

const owner = { ownerActor: 'user:owner', agentId: 'kyberion://agent/local/installed-worker' };
const ledger = 'knowledge/personal/charters/chr-a.ledger.jsonl';
const reservation = `active/shared/runtime/external-operations/personal/shared/${'a'.repeat(64)}.json`;

describe('person charter store grant (G2: module-private, synchronous)', () => {
  it('needs the installed owner binding and allows only its exact resources', () => {
    expect(() => withPersonCharterStoreAccess([ledger], [ledger], true, () => undefined)).toThrow(
      'PERSON_CHARTER_IDENTITY_REQUIRED'
    );
    withInstalledPersonCharterRuntime(owner, () => {
      expect(personCharterResourceAccessAllowed(ledger, 'read')).toBe(false);
      withPersonCharterStoreAccess([ledger], [ledger], true, () => {
        expect(personCharterResourceAccessAllowed(ledger, 'append')).toBe(true);
        expect(personCharterResourceAccessAllowed('knowledge/personal/charters', 'mkdir')).toBe(
          true
        );
        expect(
          personCharterResourceAccessAllowed('knowledge/personal/charters/chr-b.json', 'read')
        ).toBe(false);
      });
      withPersonExternalReservationAccess(reservation, true, () => {
        expect(personCharterResourceAccessAllowed(reservation, 'write')).toBe(true);
        expect(personCharterResourceAccessAllowed(ledger, 'append')).toBe(false);
      });
      expect(personCharterResourceAccessAllowed(ledger, 'append')).toBe(false);
      // A grant does not survive into another owner binding opened inside it.
      withPersonCharterStoreAccess([ledger], [ledger], true, () =>
        withInstalledPersonCharterRuntime({ ...owner, ownerActor: 'user:other' }, () =>
          expect(personCharterResourceAccessAllowed(ledger, 'append')).toBe(false)
        )
      );
    });
    expect(currentInstalledPersonCharterRuntime()).toBeUndefined();
  });

  it('refuses outside-store resources, thenables and captured continuations', async () => {
    await withInstalledPersonCharterRuntime(owner, async () => {
      expect(() =>
        withPersonCharterStoreAccess(['knowledge/personal/x.json'], [], true, () => undefined)
      ).toThrow('PERSON_CHARTER_RESOURCE_DENIED');
      expect(() =>
        withPersonExternalReservationAccess('active/shared/runtime/x.json', true, () => undefined)
      ).toThrow('PERSON_CHARTER_RESOURCE_DENIED');
      expect(() =>
        withPersonCharterStoreAccess([ledger], [ledger], true, () => Promise.resolve(1))
      ).toThrow('synchronous only');
      let later: Promise<boolean> | undefined;
      withPersonCharterStoreAccess([ledger], [ledger], true, () => {
        later = new Promise((resolve) =>
          setTimeout(() => resolve(personCharterResourceAccessAllowed(ledger, 'append')), 0)
        );
      });
      await expect(later).resolves.toBe(false);
      // The binding spans awaits inside its run.
      await Promise.resolve();
      expect(currentInstalledPersonCharterRuntime()?.ownerActor).toBe('user:owner');
    });
    let captured: Promise<unknown> | undefined;
    await withInstalledPersonCharterRuntime(owner, async () => {
      captured = new Promise((resolve) =>
        setTimeout(() => resolve(currentInstalledPersonCharterRuntime()), 0)
      );
    });
    await expect(captured).resolves.toBeUndefined();
  });

  it('freezes the binding', () => {
    withInstalledPersonCharterRuntime(owner, () => {
      const live = currentInstalledPersonCharterRuntime() as { ownerActor: string };
      expect(() => {
        live.ownerActor = 'user:other';
      }).toThrow();
    });
  });
});

describe('person charter store grant authority (G2: no store role)', () => {
  it('authorizes its exact resources for a role-less caller, only while live and registered', () => {
    const abs = pathResolver.rootResolve(ledger);
    withExecutionContext('chronos_operator', () => {
      expect(() => withExecutionContext('person_charter_store', () => undefined, 'worker')).toThrow(
        'ROLE_ASSUMPTION_DENIED'
      );
      withInstalledPersonCharterRuntime(owner, () => {
        expect(validateWritePermission(abs, 'append').allowed).toBe(false);
        withPersonCharterRegistryAccess([ledger], [ledger], () => {
          expect(personCharterGrantAuthorizes(ledger, 'append')).toBe(true);
          expect(validateWritePermission(abs, 'append')).toMatchObject({ allowed: true });
          expect(validateReadPermission(abs)).toMatchObject({ allowed: true });
          expect(
            validateReadPermission(pathResolver.rootResolve('knowledge/personal/profile.json'))
              .reason
          ).toContain('PERSON_CHARTER_RESOURCE_DENIED');
        });
        // An installation that predates the store: the grant admits nothing.
        withPersonCharterStoreAccess([ledger], [ledger], false, () => {
          expect(personCharterGrantAuthorizes(ledger, 'append')).toBe(false);
          expect(validateWritePermission(abs, 'append').allowed).toBe(false);
        });
        expect(validateWritePermission(abs, 'append').allowed).toBe(false);
      });
    });
  });
});
