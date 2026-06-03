import {
  createVirtualAudioDeviceBridge,
  type VirtualAudioDeviceBridgeOptions,
} from './virtual-audio-device-bridge.js';
import {
  createVirtualCameraBridge,
  type VirtualCameraBackendIdExtended,
  type VirtualCameraBridgeOptions,
} from './virtual-camera-bridge.js';
import {
  createVirtualDeviceInventoryBridge,
  type VirtualDeviceInventoryBridge,
} from './virtual-device-inventory-bridge.js';

export const VIRTUAL_MEDIA_DEVICE_CONTROL_BRIDGE_ID = 'virtual-media-device-control-bridge' as const;

export type VirtualMediaDeviceControlAction = 'select' | 'add' | 'remove';
export type VirtualMediaDeviceControlScope = 'audio' | 'camera' | 'all';

export interface VirtualMediaDeviceControlRequest {
  action: VirtualMediaDeviceControlAction;
  scope?: VirtualMediaDeviceControlScope;
  input_device_preference?: string;
  output_device_preference?: string;
  camera_device_preference?: string;
  preferred_camera_backend?: VirtualCameraBackendIdExtended;
}

export interface VirtualMediaDeviceSelection {
  inventory: Awaited<ReturnType<VirtualDeviceInventoryBridge['probe']>>['inventory'];
  audio?: {
    bridge_id: string;
    devices?: { input?: string; output?: string };
    selected_devices?: { input?: string; output?: string };
    available: boolean;
    reason?: string;
  };
  camera?: {
    bridge_id: string;
    backend: VirtualCameraBackendIdExtended;
    available: boolean;
    reason?: string;
    device_preference?: string;
    selected_camera?: string;
  };
}

export interface VirtualMediaDeviceControlResult {
  bridge_id: typeof VIRTUAL_MEDIA_DEVICE_CONTROL_BRIDGE_ID;
  platform: NodeJS.Platform;
  action: VirtualMediaDeviceControlAction;
  scope: VirtualMediaDeviceControlScope;
  status: 'succeeded' | 'blocked' | 'unsupported';
  selection?: VirtualMediaDeviceSelection;
  host_plan?: {
    audio?: string[];
    camera?: string[];
    notes: string[];
  };
  reason?: string;
}

export interface VirtualMediaDeviceControlProbe {
  bridge_id: typeof VIRTUAL_MEDIA_DEVICE_CONTROL_BRIDGE_ID;
  platform: NodeJS.Platform;
  available: boolean;
  selection: VirtualMediaDeviceSelection;
  supported_actions: Array<{
    action: VirtualMediaDeviceControlAction;
    scope: VirtualMediaDeviceControlScope;
    runtime_supported: boolean;
    host_setup_required: boolean;
  }>;
}

export interface VirtualMediaDeviceControlBridgeOptions {
  inventory_bridge?: VirtualDeviceInventoryBridge;
  audio_bridge?: VirtualAudioDeviceBridgeOptions;
  camera_bridge?: VirtualCameraBridgeOptions;
}

function normalizeScope(scope?: VirtualMediaDeviceControlScope): VirtualMediaDeviceControlScope {
  return scope || 'all';
}

function buildHostPlan(scope: VirtualMediaDeviceControlScope): { audio?: string[]; camera?: string[]; notes: string[] } {
  const notes = [
    'Runtime selection is supported, but host-level add/remove requires OS-specific setup.',
  ];
  const plan: { audio?: string[]; camera?: string[]; notes: string[] } = { notes };
  if (scope === 'audio' || scope === 'all') {
    plan.audio = [
      'Install or enable the desired virtual audio driver (for example BlackHole or PulseAudio null sink).',
      'Re-route the meeting client to the selected virtual input/output devices.',
      'Use VirtualAudioDeviceBridge to select the active bus after the host device exists.',
    ];
  }
  if (scope === 'camera' || scope === 'all') {
    plan.camera = [
      'Install or enable the desired virtual camera backend or host capture path.',
      'Select the backend with VirtualCameraBridge after the host device is visible.',
      'Use inventory scan to confirm the camera appears before capture.',
    ];
  }
  return plan;
}

export class VirtualMediaDeviceControlBridgeImpl {
  readonly bridge_id = VIRTUAL_MEDIA_DEVICE_CONTROL_BRIDGE_ID;
  private readonly inventoryBridge: VirtualDeviceInventoryBridge;
  private readonly audioOptions: VirtualAudioDeviceBridgeOptions;
  private readonly cameraOptions: VirtualCameraBridgeOptions;

  constructor(private readonly opts: VirtualMediaDeviceControlBridgeOptions = {}) {
    this.inventoryBridge = opts.inventory_bridge ?? createVirtualDeviceInventoryBridge();
    this.audioOptions = { ...(opts.audio_bridge || {}), inventory_bridge: this.inventoryBridge };
    this.cameraOptions = { ...(opts.camera_bridge || {}), inventory_bridge: this.inventoryBridge };
  }

  async probe(): Promise<VirtualMediaDeviceControlProbe> {
    const inventory = await this.inventoryBridge.probe();
    const audioProbe = await createVirtualAudioDeviceBridge(this.audioOptions).probe();
    const cameraProbe = await createVirtualCameraBridge(this.cameraOptions).probe();
    return {
      bridge_id: VIRTUAL_MEDIA_DEVICE_CONTROL_BRIDGE_ID,
      platform: process.platform,
      available: true,
      selection: {
        inventory: inventory.inventory,
        audio: {
          bridge_id: audioProbe.bridge_id,
          devices: audioProbe.devices,
          selected_devices: audioProbe.selected_devices,
          available: audioProbe.available,
          reason: audioProbe.reason,
        },
        camera: {
          bridge_id: cameraProbe.bridge_id,
          backend: cameraProbe.backend,
          available: cameraProbe.available,
          reason: cameraProbe.reason,
          device_preference: cameraProbe.device_preference,
          selected_camera: cameraProbe.selected_camera,
        },
      },
      supported_actions: [
        { action: 'select', scope: 'audio', runtime_supported: true, host_setup_required: false },
        { action: 'select', scope: 'camera', runtime_supported: true, host_setup_required: false },
        { action: 'select', scope: 'all', runtime_supported: true, host_setup_required: false },
        { action: 'add', scope: 'audio', runtime_supported: false, host_setup_required: true },
        { action: 'add', scope: 'camera', runtime_supported: false, host_setup_required: true },
        { action: 'add', scope: 'all', runtime_supported: false, host_setup_required: true },
        { action: 'remove', scope: 'audio', runtime_supported: false, host_setup_required: true },
        { action: 'remove', scope: 'camera', runtime_supported: false, host_setup_required: true },
        { action: 'remove', scope: 'all', runtime_supported: false, host_setup_required: true },
      ],
    };
  }

  async control(request: VirtualMediaDeviceControlRequest): Promise<VirtualMediaDeviceControlResult> {
    const scope = normalizeScope(request.scope);
    const selection = await this.probe();
    if (request.action === 'select') {
      return {
        bridge_id: VIRTUAL_MEDIA_DEVICE_CONTROL_BRIDGE_ID,
        platform: process.platform,
        action: request.action,
        scope,
        status: 'succeeded',
        selection: selection.selection,
      };
    }

    return {
      bridge_id: VIRTUAL_MEDIA_DEVICE_CONTROL_BRIDGE_ID,
      platform: process.platform,
      action: request.action,
      scope,
      status: 'blocked',
      selection: selection.selection,
      host_plan: buildHostPlan(scope),
      reason: 'host-level add/remove is not performed by the runtime bridge; use the host provisioning plan',
    };
  }
}

export function createVirtualMediaDeviceControlBridge(
  opts: VirtualMediaDeviceControlBridgeOptions = {},
): VirtualMediaDeviceControlBridgeImpl {
  return new VirtualMediaDeviceControlBridgeImpl(opts);
}
