import { describe, expect, it } from 'vitest';
import { A2UIProtocolError, parseA2UIMessage } from './protocol.js';
import { createSurfaceStore } from './store.js';

const fixedNow = () => '2026-09-15T00:00:00.000Z';

describe('protocol', () => {
  it('accepts each operation and rejects malformed shapes with a reason', () => {
    expect(() =>
      parseA2UIMessage({ createSurface: { surfaceId: 'a', catalogId: 'demo' } })
    ).not.toThrow();
    expect(() => parseA2UIMessage({ deleteSurface: { surfaceId: 'a' } })).not.toThrow();
    expect(() => parseA2UIMessage({})).toThrow(A2UIProtocolError);
    expect(() => parseA2UIMessage({ createSurface: {}, deleteSurface: {} })).toThrow(/exactly one/);
    expect(() => parseA2UIMessage({ createSurface: { surfaceId: 'A' } })).toThrow(/surfaceId/);
    expect(() =>
      parseA2UIMessage({
        updateComponents: { surfaceId: 'a', components: [{ id: 'x', type: 'text' }] },
      })
    ).toThrow(/props/);
    expect(() =>
      parseA2UIMessage({
        updateComponents: {
          surfaceId: 'a',
          components: [{ id: 'x', type: 'text', props: {}, extra: 1 }],
        },
      })
    ).toThrow(/unknown field/);
  });
});

describe('SurfaceStore', () => {
  it('applies create, update, data and delete in order and records history', () => {
    const store = createSurfaceStore({ now: fixedNow });
    const events = store.applyMany(
      [
        { createSurface: { surfaceId: 'demo', catalogId: 'std', title: 'Demo' } },
        {
          updateComponents: {
            surfaceId: 'demo',
            components: [
              { id: 'root', type: 'container', props: {}, children: ['t1'] },
              { id: 't1', type: 'text', props: { text: 'hello' } },
            ],
          },
        },
        { updateDataModel: { surfaceId: 'demo', data: { count: 1 } } },
        { updateDataModel: { surfaceId: 'demo', data: { name: 'x' } } },
      ],
      'test'
    );
    expect(events.map((event) => event.kind)).toEqual([
      'createSurface',
      'updateComponents',
      'updateDataModel',
      'updateDataModel',
    ]);
    const surface = store.get('demo');
    expect(surface?.title).toBe('Demo');
    expect(surface?.order).toEqual(['root', 't1']);
    expect(surface?.data).toEqual({ count: 1, name: 'x' });
    expect(surface?.revision).toBe(4);
    expect(store.history()).toHaveLength(4);
    expect(store.history()[0].source).toBe('test');

    store.apply({ deleteSurface: { surfaceId: 'demo' } });
    expect(store.get('demo')).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('records invalid messages as rejected events instead of throwing', () => {
    const store = createSurfaceStore({ now: fixedNow });
    const event = store.apply({ nope: true });
    expect(event.kind).toBe('rejected');
    expect(event.detail).toMatch(/unknown field/);
    expect(store.applyMany({ not: 'array' })[0].detail).toMatch(/array/);
    expect(store.list()).toEqual([]);
  });

  it('creates an implicit surface when an update arrives first, then upgrades it', () => {
    const store = createSurfaceStore({ now: fixedNow });
    store.apply({
      updateComponents: { surfaceId: 'late', components: [{ id: 'a', type: 'text', props: {} }] },
    });
    expect(store.get('late')?.implicit).toBe(true);
    store.apply({ createSurface: { surfaceId: 'late', catalogId: 'std', title: 'Late' } });
    const surface = store.get('late');
    expect(surface?.implicit).toBe(false);
    expect(surface?.title).toBe('Late');
    expect(surface?.order).toEqual(['a']);
  });

  it('upserts components by id without duplicating order', () => {
    const store = createSurfaceStore({ now: fixedNow });
    store.apply({ createSurface: { surfaceId: 's', catalogId: 'std' } });
    store.apply({
      updateComponents: {
        surfaceId: 's',
        components: [{ id: 'a', type: 'text', props: { text: '1' } }],
      },
    });
    store.apply({
      updateComponents: {
        surfaceId: 's',
        components: [{ id: 'a', type: 'text', props: { text: '2' } }],
      },
    });
    expect(store.get('s')?.order).toEqual(['a']);
    expect(store.get('s')?.components.a.props.text).toBe('2');
  });

  it('resolves roots and children, ignoring unknown and cyclic references', () => {
    const store = createSurfaceStore({ now: fixedNow });
    store.apply({ createSurface: { surfaceId: 's', catalogId: 'std' } });
    store.apply({
      updateComponents: {
        surfaceId: 's',
        components: [
          { id: 'root', type: 'container', props: {}, children: ['a', 'missing', 'root'] },
          { id: 'a', type: 'container', props: {}, children: ['root'] },
          { id: 'solo', type: 'text', props: {} },
        ],
      },
    });
    const tree = store.tree('s');
    expect(tree.roots.map((component) => component.id)).toEqual(['solo']);
    expect(tree.childrenOf('root').map((component) => component.id)).toEqual(['a']);
    expect(tree.childrenOf('a').map((component) => component.id)).toEqual(['root']);
    expect(store.tree('none').roots).toEqual([]);
  });

  it('bounds history and notifies subscribers', () => {
    const store = createSurfaceStore({ now: fixedNow, maxHistory: 2 });
    const seen: string[] = [];
    const unsubscribe = store.subscribe((event) => seen.push(event.kind));
    store.apply({ createSurface: { surfaceId: 's', catalogId: 'std' } });
    store.apply({ updateDataModel: { surfaceId: 's', data: {} } });
    store.apply({ updateDataModel: { surfaceId: 's', data: {} } });
    unsubscribe();
    store.apply({ updateDataModel: { surfaceId: 's', data: {} } });
    expect(store.history()).toHaveLength(2);
    expect(seen).toEqual(['createSurface', 'updateDataModel', 'updateDataModel']);
  });
});
