import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  ChainSecretResolver,
  describeSecretResolver,
  getSecretResolver,
  installSecretResolverIfAvailable,
  registerSecretResolver,
  resetSecretResolver,
  resolveSecretAsync,
  resolveSecretReferenceAsync,
  resolveSecretReferenceSync,
  resolveSecretSync,
  type SecretResolver,
} from './secret-resolver.js';

describe('secret-resolver', () => {
  afterEach(() => resetSecretResolver());

  it('routes resolver environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/secret-resolver.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });

  it('installs from an injected environment without consulting ambient state', () => {
    expect(
      installSecretResolverIfAvailable({
        KYBERION_SECRET_RESOLVER_COMMAND: 'printf injected-secret',
        KYBERION_SECRET_RESOLVER_TIMEOUT_MS: '2500',
      })
    ).toBe(true);
    expect(getSecretResolver()?.name).toBe('shell');
    expect(describeSecretResolver()).toEqual({ configured: true, writable: false });
  });

  it('returns null when no resolver is registered', () => {
    expect(resolveSecretSync({ key: 'X' })).toBeNull();
    expect(getSecretResolver()).toBeNull();
  });

  it('honors a sync resolver', () => {
    registerSecretResolver({
      name: 'mem',
      resolve: ({ key }) => (key === 'FOO' ? 'bar' : null),
    });
    expect(resolveSecretSync({ key: 'FOO' })).toBe('bar');
    expect(resolveSecretSync({ key: 'MISS' })).toBeNull();
  });

  it('passes an operation-scoped env reference and does not cache rotation', async () => {
    const seen: string[] = [];
    let value = 'before-rotation';
    registerSecretResolver({
      name: 'rotating',
      resolve: (input) => {
        seen.push(`${input.key}:${input.operation}`);
        return value;
      },
      describe: () => ({ configured: true, writable: false }),
    });
    expect(resolveSecretReferenceSync({ env: 'SERVICE_TOKEN', operation: 'browser.login' })).toBe(
      'before-rotation'
    );
    value = 'after-rotation';
    await expect(
      resolveSecretReferenceAsync({ env: 'SERVICE_TOKEN', operation: 'browser.login' })
    ).resolves.toBe('after-rotation');
    expect(seen).toEqual(['SERVICE_TOKEN:browser.login', 'SERVICE_TOKEN:browser.login']);
    expect(describeSecretResolver()).toEqual({ configured: true, writable: false });
  });

  it('rejects references that are not env-name identifiers', () => {
    registerSecretResolver({ name: 'mem', resolve: () => 'secret' });
    expect(() => resolveSecretReferenceSync({ env: 'op://vault/item' })).toThrow(
      'SECRET_REFERENCE_INVALID'
    );
  });

  it('rejects a second sole resolver instead of silently replacing the first', () => {
    registerSecretResolver({ name: 'first', resolve: () => 'first' });
    expect(() => registerSecretResolver({ name: 'second', resolve: () => 'second' })).toThrow(
      /already has provider first/
    );
  });

  it('sync path returns null for async resolvers (async path handles them)', async () => {
    const fake: SecretResolver = {
      name: 'async',
      resolve: async ({ key }) => (key === 'BAZ' ? 'qux' : null),
    };
    registerSecretResolver(fake);
    expect(resolveSecretSync({ key: 'BAZ' })).toBeNull();
    expect(await resolveSecretAsync({ key: 'BAZ' })).toBe('qux');
  });

  it('swallows resolver errors and returns null', () => {
    registerSecretResolver({
      name: 'broken',
      resolve: () => {
        throw new Error('boom');
      },
    });
    expect(resolveSecretSync({ key: 'X' })).toBeNull();
  });

  describe('ChainSecretResolver', () => {
    it('returns the first non-null result', async () => {
      const chain = new ChainSecretResolver([
        { name: 'a', resolve: () => null },
        { name: 'b', resolve: () => 'from-b' },
        { name: 'c', resolve: () => 'from-c' },
      ]);
      expect(await chain.resolve({ key: 'X' })).toBe('from-b');
    });

    it('skips throwing resolvers and continues', async () => {
      const chain = new ChainSecretResolver([
        {
          name: 'broken',
          resolve: () => {
            throw new Error('x');
          },
        },
        { name: 'ok', resolve: () => 'value' },
      ]);
      expect(await chain.resolve({ key: 'X' })).toBe('value');
    });

    it('returns null when no resolver hits', async () => {
      const chain = new ChainSecretResolver([
        { name: 'a', resolve: () => null },
        { name: 'b', resolve: () => null },
      ]);
      expect(await chain.resolve({ key: 'X' })).toBeNull();
    });
  });
});
