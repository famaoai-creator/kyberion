import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSeam,
  createSeamCatalog,
  createSeamLifecycle,
  defineSeam,
  resolveSeamAutoProvider,
  SeamError,
} from './seam.js';

describe('seam lifecycle contract', () => {
  it('honors reset requested by a synchronous registration observer', () => {
    const seam = createSeam<string>({ key: 'reentrant-reset', multiplicity: 'named' });
    const lifecycle = createSeamLifecycle(seam);
    const unsubscribe = seam.on('added', () => lifecycle.reset());
    const stale = lifecycle.register('provider', 'cancelled', { provenance: 'plugin' });
    expect(seam.list()).toEqual([]);
    unsubscribe();
    lifecycle.register('provider', 'replacement', { provenance: 'plugin' });
    stale();
    expect(seam.get('provider')).toBe('replacement');
    lifecycle.reset();
    expect(seam.list()).toEqual([]);
  });

  it('rolls back registration when a change listener throws, without orphaning the provider', () => {
    const seam = createSeam<string>({ key: 'register-failure', multiplicity: 'named' });
    const changed = vi.fn().mockImplementationOnce(() => {
      throw new Error('observer failed');
    });
    const lifecycle = createSeamLifecycle(seam, { onChange: changed });
    expect(() => lifecycle.register('provider', 'orphan', { provenance: 'plugin' })).toThrow(
      'observer failed'
    );
    expect(seam.list()).toEqual([]);
    const dispose = lifecycle.register('provider', 'valid', { provenance: 'plugin' });
    expect(seam.get('provider')).toBe('valid');
    dispose();
    expect(seam.list()).toEqual([]);
  });

  it('notifies on both mutations, resets owned providers, and ignores stale disposers', () => {
    const seam = createSeam<string>({ key: 'lifecycle', multiplicity: 'named' });
    const changed = vi.fn();
    const lifecycle = createSeamLifecycle(seam, { onChange: changed });
    const stale = lifecycle.register('provider', 'first', { provenance: 'plugin' });
    expect(changed).toHaveBeenCalledTimes(1);
    stale();
    expect(seam.getOptional('provider')).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
    lifecycle.register('provider', 'second', { provenance: 'plugin' });
    stale();
    expect(seam.get('provider')).toBe('second');
    expect(changed).toHaveBeenCalledTimes(3);
    lifecycle.reset();
    lifecycle.reset();
    expect(seam.list()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it('keeps independent owners isolated and preserves duplicate checks', () => {
    const seam = createSeam<string>({ key: 'ownership', multiplicity: 'named' });
    const left = createSeamLifecycle(seam);
    const right = createSeamLifecycle(seam);
    left.register('left', 'L', { provenance: 'builtin' });
    right.register('right', 'R', { provenance: 'plugin' });
    expect(() => right.register('left', 'duplicate', { provenance: 'plugin' })).toThrow(SeamError);
    left.reset();
    expect(seam.list().map((provider) => provider.id)).toEqual(['right']);
    right.reset();
  });

  it('attempts every removal before reporting a failing change listener', () => {
    const seam = createSeam<string>({ key: 'cleanup', multiplicity: 'named' });
    const lifecycle = createSeamLifecycle(seam);
    lifecycle.register('a', 'A', { provenance: 'plugin' });
    lifecycle.register('b', 'B', { provenance: 'plugin' });
    seam.on('removed', () => {
      throw new Error('observer failed');
    });
    const observed = vi.fn();
    seam.on('removed', observed);
    expect(() => lifecycle.reset()).toThrow(AggregateError);
    expect(seam.list()).toEqual([]);
    expect(observed).toHaveBeenCalledTimes(2);
    expect(() => lifecycle.reset()).not.toThrow();
  });

  it('keeps the registry clean when both added and rollback observers fail', () => {
    const seam = createSeam<string>({ key: 'rollback-failure', multiplicity: 'named' });
    const lifecycle = createSeamLifecycle(seam, {
      onChange: () => {
        throw new Error('observer failed');
      },
    });
    expect(() => lifecycle.register('provider', 'orphan', { provenance: 'plugin' })).toThrow(
      AggregateError
    );
    expect(seam.list()).toEqual([]);
    expect(() => lifecycle.reset()).not.toThrow();
  });
});

describe('seam auto selection contract', () => {
  const eligible = (value: { available: boolean }) => value.available;
  it('requires a declared eligible default when multiple candidates qualify', () => {
    const seam = createSeam<{ available: boolean }>({ key: 'auto', multiplicity: 'named' });
    seam.register('z-default', { available: true }, { provenance: 'builtin' });
    seam.register('a-extension', { available: true }, { provenance: 'plugin' });
    expect(() => resolveSeamAutoProvider(seam, { eligible })).toThrowError(
      expect.objectContaining({ code: 'SEAM_PROVIDER_AMBIGUOUS' })
    );
    expect(resolveSeamAutoProvider(seam, { eligible, defaultProvider: 'z-default' })).toBe(
      seam.get('z-default')
    );
  });
  it('filters the default before selecting and handles zero or one eligible provider', () => {
    const seam = createSeam<{ available: boolean }>({ key: 'eligible', multiplicity: 'named' });
    seam.register('default', { available: false }, { provenance: 'builtin' });
    expect(resolveSeamAutoProvider(seam, { eligible, defaultProvider: 'default' })).toBeUndefined();
    seam.register('extension', { available: true }, { provenance: 'plugin' });
    expect(resolveSeamAutoProvider(seam, { eligible, defaultProvider: 'default' })).toBe(
      seam.get('extension')
    );
  });
});

describe('defineSeam', () => {
  it('supports the canonical createSeam constructor', () => {
    const seam = createSeam<{ value: string }>({ key: 'test.create', multiplicity: 'sole' });
    const dispose = seam.register('builtin', { value: 'ok' }, { provenance: 'builtin' });
    expect(seam.get().value).toBe('ok');
    dispose();
  });
  it('rejects a second provider for a sole seam', () => {
    const seam = defineSeam<{ value: string }>({ key: 'test.sole', multiplicity: 'sole' });
    seam.register('first', { value: 'first' }, { provenance: 'builtin' });

    expect(() => seam.register('second', { value: 'second' }, { provenance: 'plugin' })).toThrow(
      'already has provider first'
    );
    expect(seam.get().value).toBe('first');
  });

  it('requires an explicit selector when named providers are ambiguous', () => {
    const seam = defineSeam<{ value: string }>({ key: 'test.named', multiplicity: 'named' });
    seam.register('b', { value: 'B' }, { provenance: 'plugin' });
    seam.register('a', { value: 'A' }, { provenance: 'tenant-overlay' });

    expect(() => seam.get()).toThrowError(
      expect.objectContaining({ code: 'SEAM_PROVIDER_AMBIGUOUS', providerIds: ['a', 'b'] })
    );
    expect(seam.get('a').value).toBe('A');
    expect(() => seam.get('missing')).toThrowError(
      expect.objectContaining({ code: 'SEAM_PROVIDER_MISSING', providerIds: ['missing'] })
    );
    expect(seam.list().map((provider) => provider.id)).toEqual(['a', 'b']);
  });

  it('rejects duplicate ids and supports deterministic disposal/events', () => {
    const seam = defineSeam<{ value: string }>({ key: 'test.events', multiplicity: 'named' });
    const added: string[] = [];
    const removed: string[] = [];
    seam.on('added', (provider) => added.push(provider.id));
    seam.on('removed', (provider) => removed.push(provider.id));

    const dispose = seam.register('provider', { value: 'value' }, { provenance: 'generated' });
    expect(() =>
      seam.register('provider', { value: 'other' }, { provenance: 'generated' })
    ).toThrow(SeamError);
    dispose();
    dispose();
    expect(added).toEqual(['provider']);
    expect(removed).toEqual(['provider']);
    expect(seam.getOptional()).toBeUndefined();
  });
});

describe('seam catalog re-registration', () => {
  const OWNER = 'libs/core/example-owner.ts';

  it('lets the same owner replace its entry when its module is evaluated again', () => {
    const catalog = createSeamCatalog();
    const stale = createSeam<string>({ key: 'k', multiplicity: 'sole', catalog, owner: OWNER });
    stale.register('builtin', 'stale', { provenance: 'builtin' });
    const fresh = createSeam<string>({ key: 'k', multiplicity: 'sole', catalog, owner: OWNER });
    expect(catalog.get('k')).toBe(fresh);
    expect(catalog.list()).toEqual([{ key: 'k', multiplicity: 'sole', providers: [] }]);
    fresh.register('builtin', 'fresh', { provenance: 'builtin' });
    expect(catalog.get<string>('k')!.get()).toBe('fresh');
  });

  it('does not let the stale disposer remove the replacing seam', () => {
    const catalog = createSeamCatalog();
    const releaseStale = catalog.register(
      createSeam<string>({ key: 'k', multiplicity: 'named', owner: OWNER })
    );
    const fresh = createSeam<string>({ key: 'k', multiplicity: 'named', catalog, owner: OWNER });
    releaseStale();
    expect(catalog.get('k')).toBe(fresh);
  });

  it('still rejects a definition from another module, without an owner, or of another shape', () => {
    const catalog = createSeamCatalog();
    const original = createSeam<string>({ key: 'k', multiplicity: 'sole', catalog, owner: OWNER });
    const duplicate = (definition: { owner?: string; multiplicity?: 'sole' | 'named' }) => () =>
      createSeam<string>({ key: 'k', multiplicity: 'sole', catalog, ...definition });
    for (const attempt of [
      duplicate({ owner: 'libs/core/other-module.ts' }),
      duplicate({ owner: undefined }),
      duplicate({ owner: OWNER, multiplicity: 'named' }),
    ]) {
      expect(attempt).toThrowError(
        expect.objectContaining({
          code: 'SEAM_DUPLICATE_PROVIDER',
          message: 'Seam k is already registered in the catalog',
        })
      );
    }
    expect(catalog.get('k')).toBe(original);
  });

  it('keeps rejecting an unowned seam even when the newcomer declares an owner', () => {
    const catalog = createSeamCatalog();
    createSeam<string>({ key: 'k', multiplicity: 'sole', catalog });
    expect(() =>
      createSeam<string>({ key: 'k', multiplicity: 'sole', catalog, owner: OWNER })
    ).toThrow('already registered in the catalog');
  });

  describe('outside Vitest', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('throws SEAM_DUPLICATE_PROVIDER even for the same owner and shape', () => {
      const catalog = createSeamCatalog();
      const first = createSeam<string>({ key: 'k', multiplicity: 'sole', catalog, owner: OWNER });
      vi.stubEnv('VITEST', '');
      let error: unknown;
      try {
        createSeam<string>({ key: 'k', multiplicity: 'sole', catalog, owner: OWNER });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SeamError);
      expect((error as SeamError).code).toBe('SEAM_DUPLICATE_PROVIDER');
      expect(catalog.get('k')).toBe(first);
    });
  });

  it('rejects an empty owner', () => {
    expect(() => createSeam<string>({ key: 'k', multiplicity: 'sole', owner: ' ' })).toThrowError(
      expect.objectContaining({ code: 'SEAM_INVALID_DEFINITION' })
    );
  });
});
