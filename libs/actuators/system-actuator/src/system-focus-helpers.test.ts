import { describe, expect, it } from 'vitest';
import { parseFocusTargetStore } from './system-focus-helpers.js';

describe('parseFocusTargetStore', () => {
  it('keeps only well-shaped focus targets keyed by their id', () => {
    expect(
      parseFocusTargetStore({
        chat: {
          id: 'chat',
          application: 'Slack',
          windowTitle: '#ops',
          role: 'AXTextArea',
          description: 'message composer',
          editable: true,
          updatedAt: '2026-09-01T09:00:00.000Z',
          ignored: { nested: true },
        },
        mismatched: { id: 'other', application: 'Slack' },
        invalid: { id: 'invalid', editable: 'yes' },
      })
    ).toEqual({
      chat: {
        id: 'chat',
        application: 'Slack',
        windowTitle: '#ops',
        role: 'AXTextArea',
        description: 'message composer',
        editable: true,
        updatedAt: '2026-09-01T09:00:00.000Z',
      },
    });
  });

  it('fails closed for primitive, array, and prototype-pollution entries', () => {
    expect(parseFocusTargetStore(null)).toEqual({});
    expect(parseFocusTargetStore([])).toEqual({});
    expect(
      parseFocusTargetStore(
        JSON.parse(
          '{"__proto__":{"id":"__proto__"},"constructor":{"id":"constructor"},"prototype":{"id":"prototype"}}'
        )
      )
    ).toEqual({});
  });
});
