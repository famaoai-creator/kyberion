import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StubAudioBus } from './audio-bus.js';
import { createVirtualAudioDeviceBridge } from './virtual-audio-device-bridge.js';
import { createVirtualCameraBridge } from './virtual-camera-bridge.js';
import { createVirtualDeviceInventoryBridge, VIRTUAL_DEVICE_INVENTORY_BRIDGE_ID } from './virtual-device-inventory-bridge.js';

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
                {
                  _name: 'BlackHole 2ch',
                  coreaudio_default_audio_input_device: true,
                  coreaudio_default_audio_output_device: true,
                },
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
          '[1] BlackHole 2ch',
        ].join('\n'),
        status: 0,
      };
    }
    if (command === 'pactl' && args[0] === 'list' && args[2] === 'sources') {
      return {
        stdout: [
          '0\talsa_input.usb-Logitech',
          '1\tBlackHole.monitor',
        ].join('\n'),
        stderr: '',
        status: 0,
      };
    }
    if (command === 'pactl' && args[0] === 'list' && args[2] === 'sinks') {
      return {
        stdout: [
          '0\talsa_output.usb-Logitech',
          '1\tmeeting_out',
        ].join('\n'),
        stderr: '',
        status: 0,
      };
    }
    return { stdout: '', stderr: '', status: 0 };
  };
}

describe('createVirtualDeviceInventoryBridge', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
  });

  it('scans camera and audio candidates', async () => {
    const bridge = createVirtualDeviceInventoryBridge({
      command_runner: makeCommandRunner(),
    });

    const probe = await bridge.probe();
    expect(probe.bridge_id).toBe(VIRTUAL_DEVICE_INVENTORY_BRIDGE_ID);
    expect(probe.available).toBe(true);
    expect(probe.inventory.audio_inputs.map((d) => d.name)).toContain('Built-in Microphone');
    expect(probe.inventory.audio_outputs.map((d) => d.name)).toContain('Built-in Output');
    expect(probe.inventory.cameras.map((d) => d.name)).toContain('FaceTime HD Camera');
    expect(probe.inventory.virtual_audio_devices.map((d) => d.name)).toContain('BlackHole 2ch');
  });

  it('supplies discovered devices to the virtual audio bridge', async () => {
    const inventory = createVirtualDeviceInventoryBridge({
      command_runner: makeCommandRunner(),
    });
    const bridge = createVirtualAudioDeviceBridge({
      bus: new StubAudioBus(),
      inventory_bridge: inventory,
      input_device_preference: 'Built-in Microphone',
      output_device_preference: 'Built-in Output',
    });

    const probe = await bridge.probe();
    expect(probe.devices?.input).toBe('Built-in Microphone');
    expect(probe.devices?.output).toBe('Built-in Output');
    expect(probe.selected_devices?.input).toBe('Built-in Microphone');
    expect(probe.selected_devices?.output).toBe('Built-in Output');
  });

  it('attaches the scanned inventory to the virtual camera bridge probe', async () => {
    const inventory = createVirtualDeviceInventoryBridge({
      command_runner: makeCommandRunner(),
    });
    const bridge = createVirtualCameraBridge({
      preferred_backend: 'stub',
      inventory_bridge: inventory,
    });

    const probe = await bridge.probe();
    expect(probe.inventory?.cameras.map((d) => d.name)).toContain('FaceTime HD Camera');
    expect(probe.available).toBe(true);
    expect(probe.selected_camera).toBe('FaceTime HD Camera');
  });
});
