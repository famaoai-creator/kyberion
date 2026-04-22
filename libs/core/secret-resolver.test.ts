import { afterEach, describe, expect, it } from 'vitest';
import {
  ChainSecretResolver,
  getSecretResolver,
  registerSecretResolver,
  resetSecretResolver,
  resolveSecretAsync,
  resolveSecretSync,
  type SecretResolver,
} from './secret-resolver.js';

describe('secret-resolver', () => {
  afterEach(() => resetSecretResolver());

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
