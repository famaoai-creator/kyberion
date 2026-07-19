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

  it('forwards recording to the canonical system recording op', async () => {
    systemAction.mockResolvedValue({
      media_recording: { status: 'succeeded', output_path: '/repo/recording.mp4' },
    });

    const result = await handleCaptureAction('record_screen', {
      output: 'recording.mp4',
      duration: 2,
      fps: 10,
    });

    expect(systemAction).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            op: 'record_screen',
            params: expect.objectContaining({ output: '/repo/recording.mp4' }),
          }),
        ],
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        path: '/repo/recording.mp4',
        compatibility_forwarded_to: 'system-actuator:record_screen',
      })
    );
  });
});
