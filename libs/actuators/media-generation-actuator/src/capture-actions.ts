import { executeServicePreset, pathResolver } from '@agent/core';
import { handleAction as handleSystemAction } from '@actuator/system';

export type CaptureAction = 'capture_screen' | 'capture_focused_window' | 'record_screen';

function outputPath(params: Record<string, unknown>): string {
  const requested = typeof params.output === 'string' ? params.output : '';
  return pathResolver.rootResolve(requested || `active/shared/tmp/capture-${Date.now()}.jpg`);
}

export async function handleCaptureAction(
  action: CaptureAction,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (action === 'record_screen') {
    return executeServicePreset('media-generation', action, params) as Promise<
      Record<string, unknown>
    >;
  }

  const target = outputPath(params);
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
