import { describe, expect, it } from 'vitest';
import { parseHeadlessA2UIResponse } from './headless-a2ui-response';

const valid = {
  ok: true,
  data: {
    a2ui: {
      updateComponents: {
        surfaceId: 'chronos.headless.operator-home',
        components: [
          {
            id: 'status',
            type: 'display:status',
            props: { label: 'Next action', status: 'ok', metrics: [{ value: 1 }] },
          },
        ],
      },
    },
  },
};

describe('headless A2UI response boundary', () => {
  it('accepts the envelope and JSON-safe component props', () => {
    expect(parseHeadlessA2UIResponse(valid)?.data.a2ui.updateComponents.components).toHaveLength(1);
  });

  it('rejects malformed components, roots, and dangerous nested props', () => {
    expect(parseHeadlessA2UIResponse({ ...valid, ok: false })).toBeUndefined();
    expect(
      parseHeadlessA2UIResponse({
        ...valid,
        data: { a2ui: { updateComponents: { surfaceId: 'surface', components: [{ id: 'x' }] } } },
      })
    ).toBeUndefined();
    expect(
      parseHeadlessA2UIResponse(
        JSON.parse(
          '{"ok":true,"data":{"a2ui":{"updateComponents":{"surfaceId":"surface","components":[{"id":"x","type":"display:status","props":{"__proto__":{}}}]}}}}'
        )
      )
    ).toBeUndefined();
  });

  it('preserves optional child references only when they are strings', () => {
    expect(
      parseHeadlessA2UIResponse({
        ...valid,
        data: {
          a2ui: {
            updateComponents: {
              ...valid.data.a2ui.updateComponents,
              components: [
                { ...valid.data.a2ui.updateComponents.components[0], children: ['child-1'] },
              ],
            },
          },
        },
      })?.data.a2ui.updateComponents.components[0]?.children
    ).toEqual(['child-1']);
    expect(
      parseHeadlessA2UIResponse({
        ...valid,
        data: {
          a2ui: {
            updateComponents: {
              ...valid.data.a2ui.updateComponents,
              components: [{ ...valid.data.a2ui.updateComponents.components[0], children: [1] }],
            },
          },
        },
      })
    ).toBeUndefined();
  });
});
