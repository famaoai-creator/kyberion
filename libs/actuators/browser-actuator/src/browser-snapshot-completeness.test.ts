import { describe, expect, it } from 'vitest';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';

function fakePage(evaluated: unknown) {
  return {
    evaluate: async () => evaluated,
    url: () => 'https://example.com/',
    title: async () => 'Example',
  } as unknown as Parameters<typeof browserRuntimeHelpers.buildSnapshot>[0];
}

describe('browser snapshot completeness', () => {
  it('marks a capped snapshot as truncated and incomplete', async () => {
    const snapshot = await browserRuntimeHelpers.buildSnapshot(
      fakePage({
        viewport: { width: 800, height: 600, scale: 1 },
        ready_state: 'complete',
        total_candidates: 5,
        elements: [
          {
            ref: '@e1',
            tag: 'button',
            role: 'button',
            text: 'Save',
            name: 'Save',
            type: null,
            placeholder: null,
            href: null,
            value: null,
            visible: true,
            editable: false,
            selector: 'button',
          },
        ],
      }),
      { sessionId: 's1', tabId: 'tab-1', maxElements: 1 }
    );
    expect(snapshot.element_count).toBe(1);
    expect(snapshot.element_total).toBe(5);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.complete).toBe(false);
  });

  it('marks an uncapped snapshot as complete', async () => {
    const snapshot = await browserRuntimeHelpers.buildSnapshot(
      fakePage({
        viewport: { width: 800, height: 600, scale: 1 },
        ready_state: 'complete',
        total_candidates: 1,
        elements: [
          {
            ref: '@e1',
            tag: 'a',
            role: 'link',
            text: 'Home',
            name: 'Home',
            type: null,
            placeholder: null,
            href: 'https://example.com/',
            value: null,
            visible: true,
            editable: false,
            selector: 'a',
          },
        ],
      }),
      { sessionId: 's1', tabId: 'tab-1', maxElements: 500 }
    );
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.complete).toBe(true);
  });

  it('tolerates legacy evaluate results without a candidate total', async () => {
    const snapshot = await browserRuntimeHelpers.buildSnapshot(fakePage({ elements: [] }), {
      sessionId: 's1',
      tabId: 'tab-1',
      maxElements: 10,
    });
    expect(snapshot.element_total).toBeUndefined();
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.complete).toBe(true);
  });
});
