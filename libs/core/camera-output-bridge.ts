/**
 * Camera-output bridge seam — "show this video as a camera" backends.
 *
 * Mirrors the voice-side bridge pattern (`speech-to-text-bridge`):
 * capability-declared, probe-gated, named multiplicity so deployments
 * can register alternatives (OBS virtual camera, v4l2 loopback, …)
 * and callers resolve by preference instead of hardcoding one vendor.
 * The voice actuator's `output_to_virtual_camera` op is the thin
 * dispatcher over this seam.
 */

import { coreSeamCatalog, createSeam } from './seam.js';

export interface CameraOutputCapabilities {
  /** Whether frames reach a real OS virtual-camera device. */
  virtual_camera: boolean;
  /** Whether a looping file source can be attached. */
  looping_source: boolean;
  /** Whether scenes can be created/switched programmatically. */
  scene_switching: boolean;
  /** Whether video stays on the local machine. */
  local_only?: boolean;
}

export interface CameraOutputProbe {
  available: boolean;
  reason?: string;
}

export interface AvatarOutputRequest {
  videoPath: string;
  sceneName?: string;
  sourceName?: string;
  loop?: boolean;
}

export interface AvatarOutputResult {
  scene: string;
  source: string;
  virtualCamStarted: boolean;
}

export interface CameraOutputBridge {
  readonly bridge_id: string;
  readonly capabilities: CameraOutputCapabilities;
  probe(): Promise<CameraOutputProbe>;
  startAvatarOutput(input: AvatarOutputRequest): Promise<AvatarOutputResult>;
  stopAvatarOutput(): Promise<void>;
}

const cameraOutputSeam = createSeam<CameraOutputBridge>({
  key: 'camera-output-bridge',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});

const registeredDisposers = new Map<string, () => void>();

export function registerCameraOutputBridge(bridge: CameraOutputBridge): () => void {
  const id = String(bridge.bridge_id || '').trim();
  if (!id) throw new Error('CameraOutputBridge.bridge_id is required');
  registeredDisposers.get(id)?.();
  const disposer = cameraOutputSeam.register(id, bridge, {
    provenance: 'builtin',
    source: 'camera-output-bridge',
  });
  registeredDisposers.set(id, disposer);
  return disposer;
}

export function resetCameraOutputBridges(): void {
  for (const dispose of registeredDisposers.values()) {
    try {
      dispose();
    } catch {
      /* noop */
    }
  }
  registeredDisposers.clear();
}

export function listCameraOutputBridges(): CameraOutputBridge[] {
  return cameraOutputSeam.list().map((provider) => provider.implementation);
}

/**
 * Resolve a backend by explicit id, or the first probed-available
 * backend in registration order for `auto`. Never silently falls
 * back to a stub — when nothing usable is probed the error lists
 * every backend's reason so the operator knows what to install.
 */
export async function resolveCameraOutputBridge(preference?: string): Promise<CameraOutputBridge> {
  const bridges = listCameraOutputBridges();
  const wanted =
    String(preference || 'auto')
      .trim()
      .toLowerCase() || 'auto';
  if (wanted !== 'auto') {
    const backend = bridges.find((bridge) => bridge.bridge_id === wanted);
    if (!backend) {
      const known = bridges.map((bridge) => bridge.bridge_id).join(', ') || '(none registered)';
      throw new Error(`[camera-output] unknown backend '${wanted}'. Registered: ${known}.`);
    }
    const probe = await backend.probe();
    if (!probe.available) {
      throw new Error(
        `[camera-output] backend '${wanted}' unavailable: ${probe.reason || 'unknown'}`
      );
    }
    return backend;
  }
  const reasons: string[] = [];
  for (const backend of bridges) {
    if (backend.bridge_id === 'stub') continue;
    const probe = await backend.probe();
    if (probe.available) return backend;
    reasons.push(`${backend.bridge_id}: ${probe.reason || 'unavailable'}`);
  }
  throw new Error(
    `[camera-output] no usable camera backend probed${reasons.length ? ` (${reasons.join('; ')})` : ''}. ` +
      'Install OBS Studio with the virtual camera, or select an explicitly configured backend.'
  );
}
