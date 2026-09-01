import { afterEach, describe, expect, it } from 'vitest';
import { registerOpPreflightListener } from '@agent/core/op-preflight';
import { handleMediaAction, type MediaAction } from './media-pipeline-helpers.js';

describe('media actuator direct preflight boundary', () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it('blocks direct media pipeline dispatch before any media operation runs', async () => {
    let called = false;
    dispose = registerOpPreflightListener({
      id: 'test-media-pipeline-block',
      order: 1,
      run: (call) => {
        if (call.op !== 'media:pipeline') return;
        return { decision: 'block', reason: 'media pipeline denied by test policy' };
      },
    });

    const action: MediaAction = { action: 'pipeline', steps: [] };
    await expect(
      handleMediaAction(action, {
        opCapture: async () => {
          called = true;
          return {};
        },
        opTransform: async () => {
          called = true;
          return {};
        },
        opApply: async () => {
          called = true;
          return {};
        },
      })
    ).rejects.toThrow('[OP_PREFLIGHT_BLOCK] media pipeline denied by test policy');
    expect(called).toBe(false);
  });
});
