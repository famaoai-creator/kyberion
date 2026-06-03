import { pathResolver } from './path-resolver.js';
import { recordTaskSessionHistory, updateTaskSession, type TaskSession } from './task-session.js';
import { createVirtualCameraBridge } from './virtual-camera-bridge.js';
import { createVirtualDeviceInventoryBridge } from './virtual-device-inventory-bridge.js';

export interface ExecuteCapturePhotoTaskSessionParams {
  session: TaskSession;
  queryText: string;
}

export interface ExecuteCapturePhotoTaskSessionResult {
  output: string;
  outputPath: string;
  session: TaskSession;
}

function buildOutputPath(sessionId: string): string {
  return pathResolver.sharedTmp(`capture-photo/${sessionId}.jpg`);
}

function resolveCameraPreference(session: TaskSession): string | undefined {
  const payload = session.payload || {};
  const candidates = [
    payload.camera_device_preference,
    payload.device_preference,
    payload.camera_name,
    payload.camera,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function resolveCameraIntent(session: TaskSession): 'record' | 'share' | 'reference' | 'ocr_source' {
  const payloadIntent = session.payload?.camera_intent;
  return payloadIntent === 'share' || payloadIntent === 'reference' || payloadIntent === 'ocr_source'
    ? payloadIntent
    : 'record';
}

export async function executeCapturePhotoTaskSession(
  params: ExecuteCapturePhotoTaskSessionParams,
): Promise<ExecuteCapturePhotoTaskSessionResult> {
  const devicePreference = resolveCameraPreference(params.session);
  const inventoryBridge = createVirtualDeviceInventoryBridge();
  const cameraBridge = createVirtualCameraBridge({
    inventory_bridge: inventoryBridge,
    device_preference: devicePreference,
  });

  const probe = await cameraBridge.probe();
  if (!probe.available) {
    throw new Error(`[capture-photo-task-session] camera bridge unavailable: ${probe.reason || 'unknown reason'}`);
  }

  const outputPath = buildOutputPath(params.session.session_id);
  const capture = await cameraBridge.capturePhoto({
    save_path: outputPath,
    camera_intent: resolveCameraIntent(params.session),
    subject_hint: params.session.goal.summary || params.queryText,
    device_preference: devicePreference || probe.selected_camera,
  });

  const summaryParts = [
    '写真を取得しました。',
    capture.selected_camera ? `使用カメラ: ${capture.selected_camera}` : '',
    `保存先: ${outputPath}`,
  ].filter(Boolean);

  const updated = updateTaskSession(params.session.session_id, {
    status: 'completed',
    artifact: {
      kind: 'image',
      output_path: outputPath,
      preview_text: summaryParts.join(' '),
      storage_class: 'tmp',
      backend: capture.backend,
      selected_camera: capture.selected_camera,
      camera_intent: capture.camera_intent,
    },
  });

  if (updated) {
    const timestamp = new Date().toISOString();
    recordTaskSessionHistory(updated.session_id, {
      ts: timestamp,
      type: 'execution',
      text: `Camera capture executed through ${capture.backend}.`,
    });
    recordTaskSessionHistory(updated.session_id, {
      ts: timestamp,
      type: 'artifact',
      text: `Captured image stored at ${outputPath}.`,
    });
  }

  return {
    output: summaryParts.join('\n'),
    outputPath,
    session: updated || params.session,
  };
}
