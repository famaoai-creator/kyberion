import { beforeEach, describe, expect, it, vi } from 'vitest';

const systemAction = vi.hoisted(() => vi.fn());

vi.mock('@actuator/system', () => ({
  handleAction: systemAction,
}));

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual<typeof import('@agent/core')>('@agent/core');
  return {
    ...actual,
    executeServicePreset: vi.fn(),
    pathResolver: {
      ...actual.pathResolver,
      rootResolve: (value: string) => `/repo/${value.replace(/^\/+/, '')}`,
    },
  };
});

import { handleCaptureAction } from './capture-actions.js';

describe('media generation capture compatibility forwarding', () => {
  beforeEach(() => {
    systemAction.mockReset();
    systemAction.mockResolvedValue({ screenshot_path: '/repo/screen.png' });
  });

  it('forwards screen capture to the canonical system screenshot op', async () => {
    const result = await handleCaptureAction('capture_screen', { output: 'screen.png' });

    expect(systemAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pipeline',
        steps: [
          expect.objectContaining({
            op: 'screenshot',
            params: expect.objectContaining({ capture_mode: 'screen', path: '/repo/screen.png' }),
          }),
        ],
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        path: '/repo/screen.png',
        compatibility_forwarded_to: 'system-actuator:screenshot',
      })
    );
  });

  it('preserves focused-window intent in the forwarded canonical request', async () => {
    await handleCaptureAction('capture_focused_window', { output: 'focused.png' });
    expect(systemAction).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            params: expect.objectContaining({ capture_mode: 'focused_window' }),
          }),
        ],
      })
    );
  });
});
