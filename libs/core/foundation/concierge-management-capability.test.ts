import { describe, expect, it } from 'vitest';
import { withExecutionContext, withExecutionContextAsync } from '../authority.js';
import {
  conciergeManagementGrantKind,
  withConciergeManagementGrant,
  withConciergeManagementGrantAsync,
} from './concierge-management-capability.js';

const inRole = <T>(fn: () => T) => withExecutionContext('chronos_operator', fn);

describe('Concierge management grant (G2: module-private, bound to its scope and lifetime)', () => {
  it('lives only inside its synchronous call and refuses thenables', () => {
    expect(conciergeManagementGrantKind()).toBeUndefined();
    inRole(() => {
      withConciergeManagementGrant('writer', () => {
        expect(conciergeManagementGrantKind()).toBe('writer');
      });
      expect(conciergeManagementGrantKind()).toBeUndefined();
      expect(() => withConciergeManagementGrant('reader', () => Promise.resolve(1))).toThrow(
        'cannot span awaits'
      );
      expect(() => withConciergeManagementGrant('admin' as never, () => undefined)).toThrow(
        'RESOURCE_SCOPE_REQUIRED'
      );
    });
  });

  it('needs the execution scope it is bound to; a nested assumption sees none', () => {
    expect(() => withConciergeManagementGrant('reader', () => undefined)).toThrow(
      'needs its execution scope'
    );
    inRole(() =>
      withConciergeManagementGrant('reader', () => {
        expect(withExecutionContext('chronos_operator', () => conciergeManagementGrantKind())).toBe(
          undefined
        );
        expect(conciergeManagementGrantKind()).toBe('reader');
      })
    );
  });

  it('spans awaits until the body settles; post-revocation continuations see none', async () => {
    let afterSettle: Promise<string | undefined> | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await withExecutionContextAsync('chronos_operator', async () => {
      await withConciergeManagementGrantAsync('reader', async () => {
        await Promise.resolve();
        expect(conciergeManagementGrantKind()).toBe('reader');
        // Scheduled inside, runs only after the body settled and the grant was revoked.
        afterSettle = gate.then(() => conciergeManagementGrantKind());
      });
      expect(conciergeManagementGrantKind()).toBeUndefined();
    });
    release();
    await expect(afterSettle).resolves.toBeUndefined();
    // A rejected body revokes too.
    let captured: (() => string | undefined) | undefined;
    await expect(
      withExecutionContextAsync('chronos_operator', () =>
        withConciergeManagementGrantAsync('writer', async () => {
          captured = () => conciergeManagementGrantKind();
          expect(captured()).toBe('writer');
          throw new Error('body failed');
        })
      )
    ).rejects.toThrow('body failed');
    expect(captured?.()).toBeUndefined();
  });

  it('keeps no globalThis registry (a lookalike grant authorizes nothing)', () => {
    expect(
      Object.getOwnPropertySymbols(globalThis)
        .map(String)
        .filter((name) => name.includes('concierge-management'))
    ).toEqual([]);
    const lookalike = Object.freeze({ kind: 'writer', scope: {} });
    expect(lookalike.kind).toBe('writer');
    inRole(() => expect(conciergeManagementGrantKind()).toBeUndefined());
  });
});
