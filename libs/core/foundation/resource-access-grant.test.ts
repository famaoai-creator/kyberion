import { describe, expect, it } from 'vitest';
import {
  createSynchronousResourceGrantIssuer,
  currentResourceAccessScope,
  resourceAccessDenial,
  runInResourceAccessScope,
  type ResourceAccessScope,
} from './resource-access-scope.js';

const target = 'active/shared/runtime/example/confidential/acme/record.jsonl';
const ceiling = (): ResourceAccessScope => ({
  tenantSlug: 'acme',
  readExact: [],
  writeExact: [],
  appendExact: [target],
  mkdirExact: [],
  metadataExact: [target],
});
const binding = Object.freeze({ store: 'example', operation: 'append' });

describe('synchronous resource grant issuer', () => {
  it('authenticates by private issuer identity, never a diagnostic label or payload', () => {
    const issuer = createSynchronousResourceGrantIssuer<typeof binding>('SAME_STORE');
    const other = createSynchronousResourceGrantIssuer<typeof binding>('SAME_STORE');
    issuer.run(binding, ceiling(), () => {
      const scope = currentResourceAccessScope()!;
      expect(issuer.resolve(scope)?.binding).toBe(binding);
      expect(other.resolve(scope)).toBeUndefined();
      expect(
        issuer.resolve({ ...scope, opaqueStoreToken: scope.opaqueStoreToken })
      ).toBeUndefined();
      expect(issuer.resolve({ ...scope, opaqueStoreToken: {} })).toBeUndefined();
      expect(Object.isFrozen(scope)).toBe(true);
      expect(Object.isFrozen(scope.appendExact)).toBe(true);
      expect(resourceAccessDenial(target, 'append')).toBeNull();
      expect(resourceAccessDenial(target, 'write')).toMatchObject({ allowed: false });
    });
  });

  it('copies caller arrays and refuses supplied tokens', () => {
    const issuer = createSynchronousResourceGrantIssuer();
    const paths = [target];
    issuer.run(binding, { ...ceiling(), appendExact: paths }, () => {
      paths.push('active/shared/tmp/extra');
      expect(currentResourceAccessScope()!.appendExact).toEqual([target]);
    });
    expect(() =>
      issuer.run(binding, { ...ceiling(), opaqueStoreToken: {} }, () => undefined)
    ).toThrow(/INVALID/);
  });

  it('revokes on normal return, throw, and replay in a new scope', () => {
    const issuer = createSynchronousResourceGrantIssuer();
    let captured: ResourceAccessScope | undefined;
    expect(
      issuer.run(binding, ceiling(), () => {
        captured = currentResourceAccessScope();
        return 7;
      })
    ).toBe(7);
    expect(issuer.resolve(captured)).toBeUndefined();
    runInResourceAccessScope(captured!, () =>
      expect(issuer.resolve(currentResourceAccessScope())).toBeUndefined()
    );
    expect(() =>
      issuer.run(binding, ceiling(), () => {
        captured = currentResourceAccessScope();
        throw new Error('failed callback');
      })
    ).toThrow('failed callback');
    expect(issuer.resolve(captured)).toBeUndefined();
  });

  it('intersects enclosing ceilings and refuses tenant/org changes', () => {
    const issuer = createSynchronousResourceGrantIssuer();
    runInResourceAccessScope({ ...ceiling(), appendExact: [] }, () => {
      issuer.run(binding, ceiling(), () => {
        expect(resourceAccessDenial(target, 'append')).toMatchObject({ allowed: false });
      });
      expect(() =>
        issuer.run(binding, { ...ceiling(), tenantSlug: 'other-tenant' }, () => undefined)
      ).toThrow(/bindings/);
    });
    runInResourceAccessScope({ ...ceiling(), organizationId: 'org-a' }, () =>
      expect(() =>
        issuer.run(binding, { ...ceiling(), organizationId: 'org-b' }, () => undefined)
      ).toThrow(/bindings/)
    );
  });

  it('preserves independent nested lifetimes and restores the outer grant', () => {
    const issuer = createSynchronousResourceGrantIssuer();
    issuer.run(binding, ceiling(), () => {
      const outer = currentResourceAccessScope();
      issuer.run(binding, ceiling(), () => {
        expect(issuer.resolve(currentResourceAccessScope())).toBeDefined();
        expect(issuer.resolve(outer)).toBeUndefined();
      });
      expect(issuer.resolve(outer)).toBeDefined();
    });
  });

  it('rejects Promises and hostile thenables and revokes queued work', async () => {
    const issuer = createSynchronousResourceGrantIssuer();
    let queued: Promise<boolean> | undefined;
    expect(() =>
      issuer.run(binding, ceiling(), () => {
        queued = Promise.resolve().then(() =>
          Boolean(issuer.resolve(currentResourceAccessScope()))
        );
        return Promise.reject(new Error('rejected async callback'));
      })
    ).toThrow(/ASYNC/);
    expect(await queued).toBe(false);
    expect(() =>
      issuer.run(binding, ceiling(), () => ({
        then(_resolve: unknown, reject: (reason: Error) => void) {
          reject(new Error('hostile'));
        },
      }))
    ).toThrow(/ASYNC/);
    await Promise.resolve();
    await Promise.resolve();
  });

  it('rejects direct, nested, non-enumerable and container-based token escape', () => {
    const issuer = createSynchronousResourceGrantIssuer();
    for (const result of [
      () => currentResourceAccessScope(),
      () => ({ nested: [currentResourceAccessScope()!.opaqueStoreToken] }),
      () =>
        Object.defineProperty({}, 'hidden', {
          value: currentResourceAccessScope()!.opaqueStoreToken,
        }),
      () => new Map([[1, currentResourceAccessScope()!.opaqueStoreToken]]),
      () => new Set([currentResourceAccessScope()!.opaqueStoreToken]),
      () => ({ [Symbol('hidden')]: currentResourceAccessScope()!.opaqueStoreToken }),
    ])
      expect(() => issuer.run(binding, ceiling(), result)).toThrow(/ESCAPE/);
  });

  it('does not invoke overridden container iterators or let them hide token values', () => {
    const issuer = createSynchronousResourceGrantIssuer();
    let reads = 0;
    for (const container of [new Map([[1, 'safe']]), new Set(['safe'])]) {
      const method = container instanceof Map ? 'entries' : 'values';
      Object.defineProperty(container, method, {
        get: () => {
          reads += 1;
          throw new Error('accessor executed');
        },
      });
      expect(issuer.run(binding, ceiling(), () => container)).toBe(container);
    }
    for (const makeContainer of [
      () =>
        Object.defineProperty(
          new Map([[1, currentResourceAccessScope()!.opaqueStoreToken]]),
          'entries',
          {
            get: () => {
              reads += 1;
              return () => [];
            },
          }
        ),
      () =>
        Object.defineProperty(new Set([currentResourceAccessScope()!.opaqueStoreToken]), 'values', {
          get: () => {
            reads += 1;
            return () => [];
          },
        }),
    ])
      expect(() => issuer.run(binding, ceiling(), makeContainer)).toThrow(/ESCAPE/);
    expect(reads).toBe(0);
  });

  it('does not execute result accessors and revokes their retained grant before return', () => {
    const issuer = createSynchronousResourceGrantIssuer();
    let reads = 0;
    let captured: ResourceAccessScope | undefined;
    const result = issuer.run(binding, ceiling(), () => {
      captured = currentResourceAccessScope();
      return Object.defineProperty({}, 'retained', {
        get: () => {
          reads += 1;
          return captured;
        },
      }) as { retained: ResourceAccessScope };
    });
    expect(reads).toBe(0);
    expect(issuer.resolve(result.retained)).toBeUndefined();
    expect(reads).toBe(1);
  });

  it('permits ordinary cyclic data and restores ambient scope', () => {
    const issuer = createSynchronousResourceGrantIssuer();
    const result: { self?: unknown; value: string } = { value: 'safe' };
    result.self = result;
    expect(issuer.run(binding, ceiling(), () => result)).toBe(result);
    expect(currentResourceAccessScope()).toBeUndefined();
  });
});
