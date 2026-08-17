/**
 * VAD backend registry — pick the voice activity detector by id
 * (`KYBERION_VAD`) the same way STT/TTS bridges are picked, so the
 * realtime loop and recorders can swap EnergyVad for a neural VAD
 * without touching call sites.
 *
 * 'energy' is built in. Other backends (e.g. 'silero') register via
 * their install helpers; resolution FAILS SOFT: if the requested
 * backend is unavailable, the caller receives the energy backend plus
 * a reason so it can log the degradation explicitly (never silently).
 */

import { EnergyVad, type VoiceActivityDetector } from './voice-activity-detector.js';
import { getAdapterDefault } from './adapter-default-preferences.js';
import { coreSeamCatalog, defineSeam } from './seam.js';

export interface VadFactoryOptions {
  /** Calibrated or explicit RMS threshold; null when calibration is skipped. */
  rmsThreshold: number | null;
  /** ms of continuous silence before declaring an endpoint. */
  endpointMs: number;
}

export interface VadBackend {
  readonly backend_id: string;
  /** Energy calibration only makes sense for energy-style detectors. */
  readonly needsCalibration: boolean;
  /** Cheap availability check (binaries, model files) before creating. */
  probe(): { available: boolean; reason?: string };
  create(opts: VadFactoryOptions): VoiceActivityDetector;
}

export const ENERGY_VAD_BACKEND: VadBackend = {
  backend_id: 'energy',
  needsCalibration: true,
  probe: () => ({ available: true }),
  create: (opts) =>
    new EnergyVad({ rms_threshold: opts.rmsThreshold ?? 800, endpoint_ms: opts.endpointMs }),
};

const vadBackendSeam = defineSeam<VadBackend>({
  key: 'voice.vad-backend',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});
const registrations = new Map<string, () => void>();

export function registerVadBackend(backend: VadBackend): () => void {
  const dispose = vadBackendSeam.register(backend.backend_id, backend, {
    provenance: backend.backend_id === 'energy' ? 'builtin' : 'plugin',
    source: `vad:${backend.backend_id}`,
  });
  const wrappedDispose = () => {
    dispose();
    if (registrations.get(backend.backend_id) === wrappedDispose) {
      registrations.delete(backend.backend_id);
    }
  };
  registrations.set(backend.backend_id, wrappedDispose);
  return wrappedDispose;
}

registerVadBackend(ENERGY_VAD_BACKEND);

export function listVadBackends(): string[] {
  return vadBackendSeam
    .list()
    .map((provider) => provider.id)
    .sort();
}

export interface ResolvedVadBackend {
  backend: VadBackend;
  /** Set when the requested backend was unavailable and energy was substituted. */
  degradedFrom?: string;
  degradedReason?: string;
}

/**
 * Resolve a VAD backend by id (default: `KYBERION_VAD` or 'energy').
 * Unknown or unavailable backends degrade to 'energy' with a reason —
 * callers must surface it (fail-soft, never silent).
 */
export function resolveVadBackend(id?: string): ResolvedVadBackend {
  const explicit = id?.trim() || process.env.KYBERION_VAD?.trim();
  const requested = explicit || getAdapterDefault('voice.vad') || 'energy';
  const backend = vadBackendSeam
    .list()
    .find((provider) => provider.id === requested)?.implementation;
  if (!backend) {
    return {
      backend: ENERGY_VAD_BACKEND,
      degradedFrom: requested,
      degradedReason: `unknown VAD backend '${requested}' (registered: ${listVadBackends().join(', ')})`,
    };
  }
  const probe = backend.probe();
  if (!probe.available) {
    return {
      backend: ENERGY_VAD_BACKEND,
      degradedFrom: requested,
      degradedReason: probe.reason || `VAD backend '${requested}' is unavailable`,
    };
  }
  return { backend };
}

/** Test hook: drop everything except the built-in energy backend. */
export function resetVadBackendRegistry(): void {
  for (const dispose of [...registrations.values()]) dispose();
  registerVadBackend(ENERGY_VAD_BACKEND);
}
