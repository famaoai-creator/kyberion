import { pathResolver } from '@agent/core';
import { handleAction as handleSystemAction } from '@actuator/system';

export type CaptureAction = 'capture_screen' | 'capture_focused_window' | 'record_screen';

function outputPath(params: Record<string, unknown>, extension = '.jpg'): string {
  const requested = typeof params.output === 'string' ? params.output : '';
  return pathResolver.rootResolve(
    requested || `active/shared/tmp/capture-${Date.now()}${extension}`
  );
}

export async function handleCaptureAction(
  action: CaptureAction,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const target = outputPath(params, action === 'record_screen' ? '.mp4' : '.jpg');
  if (action === 'record_screen') {
    const canonicalResult = await handleSystemAction({
      action: 'pipeline',
      steps: [
        {
          type: 'capture',
          op: 'record_screen',
          params: { ...params, output: target, export_as: 'media_recording' },
        },
      ],
    });
    const result =
      canonicalResult && typeof canonicalResult === 'object'
        ? (canonicalResult as Record<string, unknown>)
        : {};
    const recording =
      result.media_recording && typeof result.media_recording === 'object'
        ? (result.media_recording as Record<string, unknown>)
        : result;
    return {
      ...recording,
      status: recording.status || 'succeeded',
      path: typeof recording.output_path === 'string' ? recording.output_path : target,
      compatibility_forwarded_to: 'system-actuator:record_screen',
    };
  }

  const canonicalResult = await handleSystemAction({
    action: 'pipeline',
    steps: [
      {
        type: 'capture',
        op: 'screenshot',
        params: {
          ...params,
          path: target,
          capture_mode: action === 'capture_focused_window' ? 'focused_window' : 'screen',
          export_as: 'media_capture',
        },
      },
    ],
  });
  const result =
    canonicalResult && typeof canonicalResult === 'object'
      ? (canonicalResult as Record<string, unknown>)
      : {};
  return {
    ...result,
    status: 'succeeded',
    path: typeof result.screenshot_path === 'string' ? result.screenshot_path : target,
    compatibility_forwarded_to: 'system-actuator:screenshot',
  };
}
