import { describe, expect, it } from 'vitest';
import { createVirtualDeviceInventoryBridge } from './virtual-device-inventory-bridge.js';
import { createVirtualMediaDeviceControlBridge, VIRTUAL_MEDIA_DEVICE_CONTROL_BRIDGE_ID } from './virtual-media-device-control-bridge.js';

function makeCommandRunner() {
  return (command: string, args: string[]) => {
    if (command === 'system_profiler' && args[0] === 'SPAudioDataType') {
      return {
        stdout: JSON.stringify({
          SPAudioDataType: [
            {
              _items: [
                { _name: 'Built-in Microphone', coreaudio_default_audio_input_device: true },
                { _name: 'Built-in Output', coreaudio_default_audio_output_device: true },
              ],
            },
          ],
        }),
        stderr: '',
        status: 0,
      };
    }
    if (command === 'system_profiler' && args[0] === 'SPCameraDataType') {
      return {
        stdout: JSON.stringify({
          SPCameraDataType: [
            {
              _items: [
                { _name: 'FaceTime HD Camera' },
              ],
            },
          ],
        }),
        stderr: '',
        status: 0,
      };
    }
    if (command === 'ffmpeg' && args.includes('-list_devices')) {
      return {
        stdout: '',
        stderr: [
          '[AVFoundation video devices]',
          '[0] FaceTime HD Camera',
          '[AVFoundation audio devices]',
          '[1] Built-in Microphone',
        ].join('\n'),
        status: 0,
      };
    }
    return { stdout: '', stderr: '', status: 0 };
  };
}

describe('createVirtualMediaDeviceControlBridge', () => {
  it('selects existing audio and camera devices at runtime', async () => {
    const inventory = createVirtualDeviceInventoryBridge({
      command_runner: makeCommandRunner(),
    });
    const bridge = createVirtualMediaDeviceControlBridge({
      inventory_bridge: inventory,
      audio_bridge: {
        input_device_preference: 'Built-in Microphone',
        output_device_preference: 'Built-in Output',
      },
      camera_bridge: {
        device_preference: 'FaceTime',
      } as any,
    });

    const probe = await bridge.probe();
    expect(probe.bridge_id).toBe(VIRTUAL_MEDIA_DEVICE_CONTROL_BRIDGE_ID);
    expect(probe.supported_actions.find((action) => action.action === 'select' && action.scope === 'audio')?.runtime_supported).toBe(true);
    expect(probe.supported_actions.find((action) => action.action === 'add' && action.scope === 'camera')?.host_setup_required).toBe(true);
  });

  it('returns a host provisioning plan for add/remove requests', async () => {
    const bridge = createVirtualMediaDeviceControlBridge();
    const result = await bridge.control({ action: 'add', scope: 'all' });

    expect(result.bridge_id).toBe(VIRTUAL_MEDIA_DEVICE_CONTROL_BRIDGE_ID);
    expect(result.status).toBe('blocked');
    expect(result.host_plan?.audio?.length).toBeGreaterThan(0);
    expect(result.host_plan?.camera?.length).toBeGreaterThan(0);
  });
});
