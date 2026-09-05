import type { ImageGenerationMode } from './image-generation-types.js';
import { getRegisteredEnvText } from './foundation/env.js';

export interface LocalFluxGenerationPolicy {
  packageSpec: string;
  model: string;
  steps: number;
  quantize: number;
  timeoutMs: number;
}

export interface ImageGenerationPolicy {
  localFlux: LocalFluxGenerationPolicy;
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function resolveLocalFluxModel(env: NodeJS.ProcessEnv, mode?: ImageGenerationMode): string {
  return (
    getRegisteredEnvText('KYBERION_MFLUX_MODEL', { env })?.trim() ||
    (mode === 'artistic' ? 'dev' : 'schnell')
  );
}

export function resolveLocalFluxGenerationPolicy(
  env: NodeJS.ProcessEnv = process.env,
  mode?: ImageGenerationMode
): LocalFluxGenerationPolicy {
  const model = resolveLocalFluxModel(env, mode);
  const stepsFallback = model === 'dev' ? 20 : 4;

  return {
    packageSpec: getRegisteredEnvText('KYBERION_MFLUX_PACKAGE', { env })?.trim() || 'mflux',
    model,
    steps: parsePositiveInteger(
      getRegisteredEnvText('KYBERION_MFLUX_STEPS', { env })?.trim(),
      stepsFallback
    ),
    quantize: parsePositiveInteger(
      getRegisteredEnvText('KYBERION_MFLUX_QUANTIZE', { env })?.trim(),
      8
    ),
    timeoutMs: parsePositiveInteger(
      getRegisteredEnvText('KYBERION_MFLUX_TIMEOUT_MS', { env })?.trim(),
      30 * 60 * 1000
    ),
  };
}

export function resolveImageGenerationPolicy(
  env: NodeJS.ProcessEnv = process.env,
  mode?: ImageGenerationMode
): ImageGenerationPolicy {
  return {
    localFlux: resolveLocalFluxGenerationPolicy(env, mode),
  };
}
