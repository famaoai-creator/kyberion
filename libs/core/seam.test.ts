import { describe, expect, it } from 'vitest';
import { defineSeam, SeamError } from './seam.js';

describe('defineSeam', () => {
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
