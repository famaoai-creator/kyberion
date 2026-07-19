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

const registry = new Map<string, VadBackend>();

export const ENERGY_VAD_BACKEND: VadBackend = {
  backend_id: 'energy',
  needsCalibration: true,
  probe: () => ({ available: true }),
  create: (opts) =>
    new EnergyVad({ rms_threshold: opts.rmsThreshold ?? 800, endpoint_ms: opts.endpointMs }),
};

registry.set('energy', ENERGY_VAD_BACKEND);

export function registerVadBackend(backend: VadBackend): void {
  registry.set(backend.backend_id, backend);
}

export function listVadBackends(): string[] {
  return [...registry.keys()].sort();
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
  const requested = (id ?? process.env.KYBERION_VAD ?? 'energy').trim() || 'energy';
  const backend = registry.get(requested);
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
  registry.clear();
  registry.set('energy', ENERGY_VAD_BACKEND);
}
