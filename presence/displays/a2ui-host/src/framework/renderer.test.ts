import { describe, expect, it } from 'vitest';
import type { ActionDescriptor } from './actions.js';
import { registerStandardCatalog } from './catalog.js';
import { createFakeAdapter, type FakeNode } from './dom.js';
import type { A2UIComponent } from './protocol.js';
import { createComponentRegistry } from './registry.js';
import { collectActions, readDataPath, renderSurface, resolveValue } from './renderer.js';
import { createSurfaceStore } from './store.js';

function setup() {
  const adapter = createFakeAdapter();
  const registry = registerStandardCatalog(createComponentRegistry<FakeNode>());
  const store = createSurfaceStore({ now: () => '2026-09-15T00:00:00.000Z' });
  const container = adapter.create('div');
  return { adapter, registry, store, container };
}

describe('renderSurface', () => {
  it('renders canonical children, inline items and data-model refs through text nodes only', () => {
    const { adapter, registry, store, container } = setup();
    store.applyMany([
      { createSurface: { surfaceId: 's', catalogId: 'std', title: 'S' } },
      { updateDataModel: { surfaceId: 's', data: { user: { name: 'Mo' }, done: 3 } } },
      {
        updateComponents: {
          surfaceId: 's',
          components: [
            {
              id: 'root',
              type: 'card',
              props: { title: { $ref: 'user.name' } },
              children: ['greet', 'bar'],
            },
            { id: 'greet', type: 'text', props: { text: '<b>hi</b>' } },
            {
              id: 'bar',
              type: 'display:progress',
              props: { label: 'p', value: { $ref: 'done' }, max: 4 },
            },
            {
              id: 'sec',
              type: 'display:section',
              props: {
                title: 'Sec',
                items: [
                  {
                    type: 'display:kv',
                    props: { entries: [{ key: 'k', value: 'v', highlight: true }] },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    const report = renderSurface(container, store, 's', { adapter, registry });
    expect(report.rendered).toBe(5);
    expect(report.unsupported).toEqual([]);
    expect(container.children.map((node) => node.attributes['data-a2ui-id'])).toEqual([
      'root',
      'sec',
    ]);
    const title = adapter.find(container, (node) => node.className === 'a2ui-card-title');
    expect(title?.text).toBe('Mo');
    const greet = adapter.find(container, (node) => node.attributes['data-a2ui-id'] === 'greet');
    expect(greet?.text).toBe('<b>hi</b>');
    const fill = adapter.find(container, (node) => node.className.startsWith('a2ui-progress-fill'));
    expect(fill?.className).toBe('a2ui-progress-fill a2ui-progress-fill-80');
    const highlighted = adapter.find(container, (node) =>
      node.className.includes('a2ui-kv-row-highlight')
    );
    expect(highlighted).not.toBeNull();
    expect(
      adapter.find(container, (node) => node.attributes['data-a2ui-id'] === 'sec:0')
    ).not.toBeNull();
  });

  it('falls back to a placeholder for unknown types and reports them', () => {
    const { adapter, registry, store, container } = setup();
    store.applyMany([
      { createSurface: { surfaceId: 's', catalogId: 'std' } },
      {
        updateComponents: {
          surfaceId: 's',
          components: [{ id: 'x', type: 'kb-status-orbit', props: {} }],
        },
      },
    ]);
    const report = renderSurface(container, store, 's', {
      adapter,
      registry,
      strings: { unsupported: 'N/A' },
    });
    expect(report.unsupported).toEqual(['kb-status-orbit']);
    const placeholder = adapter.find(container, (node) => node.className === 'a2ui-unsupported');
    expect(placeholder?.attributes['data-type']).toBe('kb-status-orbit');
    expect(adapter.textOf(placeholder!)).toContain('N/A');
  });

  it('renders stepper-style progress from `steps` and derives the percent from done steps', () => {
    const { adapter, registry, store, container } = setup();
    store.applyMany([
      { createSurface: { surfaceId: 's', catalogId: 'std' } },
      {
        updateComponents: {
          surfaceId: 's',
          components: [
            {
              id: 'p',
              type: 'display:progress',
              props: {
                title: 'Phases',
                steps: [
                  { label: 'A 2/2', status: 'done' },
                  { label: 'B 0/3', status: 'current' },
                  { label: 'C', status: 'bad status!' },
                  'ignored',
                ],
              },
            },
          ],
        },
      },
    ]);
    renderSurface(container, store, 's', { adapter, registry });
    const value = adapter.find(container, (node) => node.className === 'a2ui-progress-value');
    expect(value?.text).toBe('33%');
    const steps = adapter.find(container, (node) => node.className === 'a2ui-progress-steps');
    expect(steps?.children.map((node) => node.attributes['data-status'])).toEqual([
      'done',
      'current',
      'pending',
    ]);
    expect(adapter.find(container, (node) => node.className === 'a2ui-progress-label')?.text).toBe(
      'Phases'
    );
  });

  it('shows the empty message for missing or empty surfaces', () => {
    const { adapter, registry, store, container } = setup();
    renderSurface(container, store, 'nope', { adapter, registry, strings: { empty: 'nothing' } });
    expect(container.children[0].text).toBe('nothing');
  });

  it('dispatches button actions and disables buttons without a valid action', () => {
    const { adapter, registry, store, container } = setup();
    const action = {
      operation_id: 'demo.go',
      method: 'POST',
      path: '/api/demo/go',
      body: { a: 1 },
    };
    store.applyMany([
      { createSurface: { surfaceId: 's', catalogId: 'std' } },
      {
        updateComponents: {
          surfaceId: 's',
          components: [
            { id: 'ok', type: 'button', props: { label: 'Go', variant: 'primary', action } },
            {
              id: 'bad',
              type: 'button',
              props: { label: 'No', action: { path: 'https://evil.example/x' } },
            },
          ],
        },
      },
    ]);
    const received: Array<{ action: ActionDescriptor; component: A2UIComponent }> = [];
    renderSurface(container, store, 's', {
      adapter,
      registry,
      onAction: (dispatched, component) => received.push({ action: dispatched, component }),
    });
    const ok = adapter.find(container, (node) => node.attributes['data-a2ui-id'] === 'ok')!;
    const bad = adapter.find(container, (node) => node.attributes['data-a2ui-id'] === 'bad')!;
    expect(ok.className).toContain('a2ui-button-primary');
    expect(bad.attributes.disabled).toBe('disabled');
    adapter.fire(ok, 'click');
    expect(received).toHaveLength(1);
    expect(received[0].action.path).toBe('/api/demo/go');
    expect(received[0].component.id).toBe('ok');
  });

  it('bounds recursion depth for self-nesting inline items', () => {
    const { adapter, registry, store, container } = setup();
    let nested: Record<string, unknown> = { type: 'text', props: { text: 'leaf' } };
    for (let index = 0; index < 40; index += 1)
      nested = { type: 'container', props: { items: [nested] } };
    store.applyMany([
      { createSurface: { surfaceId: 's', catalogId: 'std' } },
      {
        updateComponents: {
          surfaceId: 's',
          components: [{ id: 'deep', type: 'container', props: { items: [nested] } }],
        },
      },
    ]);
    const report = renderSurface(container, store, 's', { adapter, registry });
    expect(report.depthExceeded).toBe(true);
    expect(report.rendered).toBeGreaterThan(20);
  });
});

describe('helpers', () => {
  it('reads data paths and resolves refs', () => {
    expect(readDataPath({ a: { b: 2 } }, 'a.b')).toBe(2);
    expect(readDataPath({ a: 1 }, 'a.b')).toBeUndefined();
    expect(resolveValue({ $ref: 'a' }, { a: 'x' })).toBe('x');
    expect(resolveValue({ $ref: 'a', other: 1 }, { a: 'x' })).toEqual({ $ref: 'a', other: 1 });
    expect(resolveValue('plain', {})).toBe('plain');
  });

  it('collects actions from components and inline items', () => {
    const components: A2UIComponent[] = [
      {
        id: 'sec',
        type: 'display:section',
        props: {
          items: [
            {
              type: 'button',
              props: {
                label: 'Inner',
                action: { operation_id: 'x.inner', method: 'GET', path: '/api/x' },
              },
            },
          ],
        },
      },
      { id: 'b', type: 'button', props: { action: { operation_id: 'x.outer', path: '/api/y' } } },
      { id: 'c', type: 'button', props: { action: { operation_id: 'bad', path: '/nope' } } },
    ];
    const actions = collectActions(components);
    expect(actions.map((item) => [item.label, item.action.method, item.component.id])).toEqual([
      ['Inner', 'GET', 'sec:0'],
      ['x.outer', 'POST', 'b'],
    ]);
  });
});
