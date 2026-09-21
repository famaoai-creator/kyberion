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
 *
 * Without an explicit id (argument, `KYBERION_VAD`, adapter default), a
 * purpose or an operator rule for the `voice.vad-backend` seam selects among
 * the registered backends whose probe passes (seam-provider-selection.ts);
 * otherwise 'energy' stays the default.
 */

import { EnergyVad, type VoiceActivityDetector } from './voice-activity-detector.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { getAdapterDefault } from './adapter-default-preferences.js';
import { coreSeamCatalog, createSeam } from './seam.js';
import {
  listSeamSelectionPurposes,
  resolveSeamProviderDecision,
  type SeamProviderDecision,
} from './seam-provider-selection.js';
import { matchSeamSelectionRule } from './seam-selection-rules.js';

export const VAD_BACKEND_SEAM = 'voice.vad-backend';

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

const vadBackendSeam = createSeam<VadBackend>({
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
  /** Set when the backend was chosen by seam selection (purpose / operator rule). */
  decision?: SeamProviderDecision;
}

export interface ResolveVadBackendOptions {
  /** Governed purpose of the `voice.vad-backend` policy (e.g. accuracy, light). */
  purpose?: string;
  /** Request facts operator rules may match on. */
  context?: Record<string, string>;
}

/**
 * Whether a caller without an explicit backend should go through seam
 * selection: a purpose was given or an operator rule matches this request.
 * Otherwise 'energy' stays the default.
 */
export function shouldSelectVadBackend(options: ResolveVadBackendOptions = {}): boolean {
  if (options.purpose?.trim()) return true;
  return Boolean(matchSeamSelectionRule(VAD_BACKEND_SEAM, { context: options.context }));
}

function selectVadBackend(options: ResolveVadBackendOptions): ResolvedVadBackend {
  const purpose = options.purpose?.trim() || undefined;
  const backends = vadBackendSeam.list().map((provider) => provider.implementation);
  const candidates = backends.map((backend) => {
    const probe = backend.probe();
    return probe.available
      ? { id: backend.backend_id, eligible: true }
      : {
          id: backend.backend_id,
          eligible: false,
          unmet: [probe.reason || 'unavailable'],
        };
  });
  const decision = resolveSeamProviderDecision({
    seam: VAD_BACKEND_SEAM,
    candidates,
    ...(purpose ? { purpose } : {}),
    ...(options.context ? { context: options.context } : {}),
    decisionKey: purpose || 'default',
  });
  if (decision.strategy === 'unresolved') {
    const known = listSeamSelectionPurposes(VAD_BACKEND_SEAM);
    if (purpose && !known.includes(purpose)) {
      throw new Error(
        `[VAD_SELECTION] unknown purpose '${purpose}' for seam '${VAD_BACKEND_SEAM}' (known: ${known.join(', ')})`
      );
    }
    return {
      backend: ENERGY_VAD_BACKEND,
      degradedFrom: 'selection',
      degradedReason: decision.rationale,
      decision,
    };
  }
  const backend =
    backends.find((candidate) => candidate.backend_id === decision.provider_id) ??
    ENERGY_VAD_BACKEND;
  return { backend, decision };
}

/**
 * Resolve a VAD backend by id (default: `KYBERION_VAD`, the adapter default,
 * then seam selection when a purpose or operator rule applies, else 'energy').
 * Unknown or unavailable explicit backends degrade to 'energy' with a reason —
 * callers must surface it (fail-soft, never silent).
 */
export function resolveVadBackend(
  id?: string,
  options: ResolveVadBackendOptions = {}
): ResolvedVadBackend {
  const explicit =
    id?.trim() || getRegisteredEnvText('KYBERION_VAD')?.trim() || getAdapterDefault('voice.vad');
  if (!explicit && shouldSelectVadBackend(options)) {
    return selectVadBackend(options);
  }
  const requested = explicit || 'energy';
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
