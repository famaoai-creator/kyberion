import { describe, expect, it } from 'vitest';
import { createSeam, createSeamCatalog, defineSeam, SeamError } from './seam.js';

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

  it('rejects an empty owner', () => {
    expect(() => createSeam<string>({ key: 'k', multiplicity: 'sole', owner: ' ' })).toThrowError(
      expect.objectContaining({ code: 'SEAM_INVALID_DEFINITION' })
    );
  });
});
