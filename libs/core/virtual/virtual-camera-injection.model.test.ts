import { afterEach, describe, expect, it } from 'vitest';
import {
  checkFiniteStateSafety,
  type ModelStep,
  type SafetyModel,
} from '../testing/finite-state-checker.js';
import { createVirtualCameraInjectionBridge } from './virtual-camera-injection-bridge.js';
import type {
  VirtualDeviceInventory,
  VirtualDeviceInventoryBridge,
  VirtualDeviceRecord,
} from './virtual-device-inventory-bridge.js';

// Safety properties under verification (executable safety model; see
// knowledge/product/architecture/executable-safety-models.md):
//   VirtualCameraInjectionBridgeImpl.resolveSelection picks an injection
//   backend from the governed registry: an unknown requested id throws
//   before any platform/device consideration; a device backend is selected
//   only when it matches the platform, has its required device path, and
//   its ffmpeg binary probes alive; otherwise the run falls back to the
//   replay backend with a reason that distinguishes a requested-but-
//   ineligible backend from no-configured-backend at all.
//
// Abstraction: the registry is reduced to its real single entry
// (ffmpeg-v4l2, linux, device-required); env is {platform, device path,
// ffmpeg alive, requested id}; outcomes collapse to device / replay /
// throw. Frame I/O, ffmpeg argument construction, and host-plan wording
// are outside the model.

type Platform = 'linux' | 'darwin';
type Requested = 'none' | 'ffmpeg-v4l2' | 'ghost';

interface SelectionEnv {
  requested: Requested;
  platform: Platform;
  devicePath: boolean;
  ffmpeg: boolean;
}

interface SelectionState {
  env: SelectionEnv;
  outcome: 'pending' | 'device' | 'replay' | 'throw-unknown';
  reason: 'none' | 'requested-unavailable' | 'no-backend';
}

function specResolve(env: SelectionEnv): Pick<SelectionState, 'outcome' | 'reason'> {
  // The real registry holds exactly one backend: ffmpeg-v4l2, linux-only,
  // requires a device path.
  if (env.requested === 'ghost') return { outcome: 'throw-unknown', reason: 'none' };
  // Single-backend registry: the candidate is ffmpeg-v4l2 whenever it is
  // eligible — identical for an explicit request and for the first pick.
  const eligible = env.platform === 'linux' && env.devicePath;
  const backend = eligible && env.ffmpeg;
  if (backend) return { outcome: 'device', reason: 'none' };
  return {
    outcome: 'replay',
    reason: env.requested === 'ffmpeg-v4l2' ? 'requested-unavailable' : 'no-backend',
  };
}

function* selectionInitials(): Generator<SelectionState> {
  for (const requested of ['none', 'ffmpeg-v4l2', 'ghost'] as const)
    for (const platform of ['linux', 'darwin'] as const)
      for (const devicePath of [false, true])
        for (const ffmpeg of [false, true])
          yield {
            env: { requested, platform, devicePath, ffmpeg },
            outcome: 'pending',
            reason: 'none',
          };
}

const selectionModel: SafetyModel<SelectionState> = {
  initial: [...selectionInitials()],
  key: (s) => JSON.stringify(s),
  next: (s): ModelStep<SelectionState>[] => {
    if (s.outcome !== 'pending') return [];
    return [{ action: 'resolve', state: { ...s, ...specResolve(s.env) } }];
  },
  invariants: {
    'unknown requested backends throw': (s) =>
      s.outcome === 'pending' || (s.env.requested === 'ghost') === (s.outcome === 'throw-unknown'),
    'a device backend only on an eligible, probed host': (s) =>
      s.outcome !== 'device' || (s.env.platform === 'linux' && s.env.devicePath && s.env.ffmpeg),
    'replay only when no usable backend': (s) =>
      s.outcome !== 'replay' || !(s.env.platform === 'linux' && s.env.devicePath && s.env.ffmpeg),
    'the requested-unavailable reason only follows a known request': (s) =>
      s.reason !== 'requested-unavailable' || s.env.requested === 'ffmpeg-v4l2',
    'a requested backend never reports the no-backend reason': (s) =>
      s.outcome !== 'replay' || s.reason !== 'no-backend' || s.env.requested !== 'ffmpeg-v4l2',
  },
};

describe('virtual-camera-injection selection finite-state specification', () => {
  it('exhausts the selection lattice', () => {
    const result = checkFiniteStateSafety(selectionModel);
    expect(result).toEqual({ status: 'verified', visited: 48, transitions: 24 });
  });

  it('detects a ghost-fallback mutation', () => {
    const result = checkFiniteStateSafety({
      ...selectionModel,
      next: (s) => {
        if (s.outcome !== 'pending') return [];
        // Mutant: an unknown backend falls back to replay instead of throwing.
        if (s.env.requested === 'ghost') {
          return [
            {
              action: 'mutant:ghost-replay',
              state: { ...s, outcome: 'replay', reason: 'no-backend' },
            },
          ];
        }
        return [{ action: 'resolve', state: { ...s, ...specResolve(s.env) } }];
      },
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('unknown requested backends throw');
  });

  it('detects a device-selection-without-ffmpeg mutation', () => {
    const result = checkFiniteStateSafety({
      ...selectionModel,
      next: (s) => {
        if (s.outcome !== 'pending') return [];
        // Mutant: ffmpeg unavailability is ignored for device backends.
        const resolved = specResolve(s.env);
        if (resolved.outcome === 'replay' && s.env.platform === 'linux' && s.env.devicePath) {
          return [{ action: 'mutant:device-anyway', state: { ...s, outcome: 'device' } }];
        }
        return [{ action: 'resolve', state: { ...s, ...resolved } }];
      },
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('a device backend only on an eligible, probed host');
  });
});

// ---------------------------------------------------------------------------
// Conformance: the production bridge's probe() over the real registry.
// ---------------------------------------------------------------------------

const device = (name: string, kind: 'camera' | 'virtual-camera'): VirtualDeviceRecord => ({
  kind,
  name,
  platform: process.platform,
  source: 'fixture',
  available: true,
});

function fakeInventory(inventory: Partial<VirtualDeviceInventory>): VirtualDeviceInventoryBridge {
  return {
    bridge_id: 'virtual-device-inventory-bridge',
    probe: async () => ({
      bridge_id: 'virtual-device-inventory-bridge',
      platform: process.platform,
      available: true,
      inventory: {
        audio_inputs: [],
        audio_outputs: [],
        cameras: [],
        virtual_audio_devices: [],
        virtual_cameras: [],
        notes: [],
        ...inventory,
      },
    }),
    scan: async () => {
      throw new Error('not needed');
    },
  };
}

describe('virtual-camera-injection selection conformance', () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('throws for an unknown requested backend before any selection', async () => {
    const bridge = createVirtualCameraInjectionBridge({
      inventory_bridge: fakeInventory({}),
      ffmpeg_bin: 'true',
      backend_id: 'ghost',
    });
    await expect(bridge.probe()).rejects.toThrow(/Unknown virtual camera injection backend/);
  });

  it('falls back to replay on darwin even with a device path and ffmpeg', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const bridge = createVirtualCameraInjectionBridge({
      inventory_bridge: fakeInventory({}),
      ffmpeg_bin: 'true',
      device_path: '/dev/video2',
    });
    const probe = await bridge.probe();
    expect(probe.backend).toBe('stub');
    expect(probe.reason).toMatch(/replay-only/);
  });

  it('reports the requested-but-ineligible reason on darwin', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const bridge = createVirtualCameraInjectionBridge({
      inventory_bridge: fakeInventory({}),
      ffmpeg_bin: 'true',
      device_path: '/dev/video2',
      backend_id: 'ffmpeg-v4l2',
    });
    const probe = await bridge.probe();
    expect(probe.backend).toBe('stub');
    expect(probe.reason).toMatch(/requested backend is unavailable/);
  });

  it('selects the device backend on linux only with a device path and live ffmpeg', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const available = createVirtualCameraInjectionBridge({
      inventory_bridge: fakeInventory({}),
      ffmpeg_bin: 'true',
      device_path: '/dev/video2',
    });
    const probe = await available.probe();
    expect(probe.backend).toBe('ffmpeg-v4l2');
    expect(probe.selected_device_path).toBe('/dev/video2');

    const noPath = createVirtualCameraInjectionBridge({
      inventory_bridge: fakeInventory({}),
      ffmpeg_bin: 'true',
    });
    expect((await noPath.probe()).backend).toBe('stub');

    const noFfmpeg = createVirtualCameraInjectionBridge({
      inventory_bridge: fakeInventory({}),
      ffmpeg_bin: 'definitely-missing-ffmpeg-bin',
      device_path: '/dev/video2',
    });
    const fallback = await noFfmpeg.probe();
    expect(fallback.backend).toBe('stub');
    expect(fallback.reason).toMatch(/replay-only/);
  });

  it.each([
    {
      name: 'virtual cameras preferred over physical cameras',
      inventory: {
        cameras: [device('FaceTime', 'camera')],
        virtual_cameras: [device('OBS Cam', 'virtual-camera')],
      },
      preference: undefined,
      expected: 'OBS Cam',
    },
    {
      name: 'exact preference match wins',
      inventory: { cameras: [device('FaceTime HD', 'camera'), device('Studio Cam', 'camera')] },
      preference: 'Studio Cam',
      expected: 'Studio Cam',
    },
    {
      name: 'contained preference match beats the first entry',
      inventory: { cameras: [device('FaceTime HD', 'camera'), device('Studio Cam', 'camera')] },
      preference: 'studio',
      expected: 'Studio Cam',
    },
    {
      name: 'unmatched preference falls back to the first entry',
      inventory: { cameras: [device('FaceTime HD', 'camera'), device('Studio Cam', 'camera')] },
      preference: 'missing-cam',
      expected: 'FaceTime HD',
    },
    {
      name: 'empty inventory keeps the preference as a hint',
      inventory: {},
      preference: 'Preferred Cam',
      expected: 'Preferred Cam',
    },
  ])('pickCamera: $name', async ({ inventory, preference, expected }) => {
    const bridge = createVirtualCameraInjectionBridge({
      inventory_bridge: fakeInventory(inventory),
      ffmpeg_bin: 'true',
      device_preference: preference,
    });
    const probe = await bridge.probe();
    expect(probe.selected_camera).toBe(expected);
  });
});
