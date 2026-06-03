import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const createVirtualDeviceInventoryBridge = vi.fn();
  const createVirtualCameraBridge = vi.fn();
  const updateTaskSession = vi.fn();
  const recordTaskSessionHistory = vi.fn();
  return {
    createVirtualDeviceInventoryBridge,
    createVirtualCameraBridge,
    updateTaskSession,
    recordTaskSessionHistory,
  };
});

vi.mock('./virtual-device-inventory-bridge.js', () => ({
  createVirtualDeviceInventoryBridge: mocks.createVirtualDeviceInventoryBridge,
}));

vi.mock('./virtual-camera-bridge.js', () => ({
  createVirtualCameraBridge: mocks.createVirtualCameraBridge,
}));

vi.mock('./task-session.js', () => ({
  updateTaskSession: mocks.updateTaskSession,
  recordTaskSessionHistory: mocks.recordTaskSessionHistory,
}));

describe('executeCapturePhotoTaskSession', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mocks.createVirtualDeviceInventoryBridge.mockReturnValue({ bridge_id: 'virtual-device-inventory-bridge' });
    mocks.createVirtualCameraBridge.mockReturnValue({
      probe: vi.fn().mockResolvedValue({
        available: true,
        reason: undefined,
        selected_camera: 'FaceTime HD Camera',
      }),
      capturePhoto: vi.fn().mockResolvedValue({
        backend: 'swift-avfoundation',
        selected_camera: 'FaceTime HD Camera',
        camera_intent: 'record',
      }),
    });
    mocks.updateTaskSession.mockReturnValue({
      session_id: 'TSK-TEST-CAPTURE',
      task_type: 'capture_photo',
      goal: {
        summary: '記録用の写真を撮る',
        success_condition: '画像が保存される',
      },
      artifact: {
        kind: 'image',
        output_path: '/tmp/capture-photo/TSK-TEST-CAPTURE.jpg',
        preview_text: '写真を取得しました。',
        storage_class: 'tmp',
      },
      work_loop: {
        resolution: {
          execution_shape: 'task_session',
        },
      },
    });
  });

  it('captures a photo through the bridge and persists the task-session artifact', async () => {
    const { executeCapturePhotoTaskSession } = await import('./capture-photo-task-session-executor.js');
    const result = await executeCapturePhotoTaskSession({
      session: {
        session_id: 'TSK-TEST-CAPTURE',
        surface: 'presence',
        task_type: 'capture_photo',
        status: 'planning',
        mode: 'interactive',
        goal: {
          summary: '記録用の写真を撮る',
          success_condition: '画像が保存される',
        },
        control: {
          interruptible: true,
          requires_approval: false,
          awaiting_user_input: false,
        },
        outcome_contract: {
          outcome_id: 'capture_photo_outcome',
          requested_result: 'photo',
          deliverable_kind: 'image',
          success_criteria: ['image saved'],
          evidence_required: false,
          expected_artifacts: [],
          verification_method: 'manual',
        },
        history: [],
        updated_at: '2026-06-04T00:00:00.000Z',
        payload: {
          camera_intent: 'record',
          camera_device_preference: 'FaceTime HD Camera',
        },
      },
      queryText: '記録用に写真を1枚撮って',
    });

    expect(result.output).toContain('写真を取得しました。');
    expect(result.outputPath).toContain('capture-photo/TSK-TEST-CAPTURE.jpg');
    expect(mocks.createVirtualDeviceInventoryBridge).toHaveBeenCalledTimes(1);
    expect(mocks.createVirtualCameraBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        inventory_bridge: expect.anything(),
        device_preference: 'FaceTime HD Camera',
      }),
    );
    expect(mocks.updateTaskSession).toHaveBeenCalledWith(
      'TSK-TEST-CAPTURE',
      expect.objectContaining({
        status: 'completed',
        artifact: expect.objectContaining({
          kind: 'image',
          output_path: expect.stringContaining('capture-photo/TSK-TEST-CAPTURE.jpg'),
        }),
      }),
    );
  });
});
