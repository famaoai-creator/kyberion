import type { ImageGenerationMode } from './image-generation-types.js';

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
  return env.KYBERION_MFLUX_MODEL?.trim() || (
    mode === 'artistic' ? 'dev' : 'schnell'
  );
}

export function resolveLocalFluxGenerationPolicy(
  env: NodeJS.ProcessEnv = process.env,
  mode?: ImageGenerationMode,
): LocalFluxGenerationPolicy {
  const model = resolveLocalFluxModel(env, mode);
  const stepsFallback = model === 'dev' ? 20 : 4;

  return {
    packageSpec: env.KYBERION_MFLUX_PACKAGE?.trim() || 'mflux',
    model,
    steps: parsePositiveInteger(env.KYBERION_MFLUX_STEPS?.trim(), stepsFallback),
    quantize: parsePositiveInteger(env.KYBERION_MFLUX_QUANTIZE?.trim(), 8),
    timeoutMs: parsePositiveInteger(env.KYBERION_MFLUX_TIMEOUT_MS?.trim(), 30 * 60 * 1000),
  };
}

export function resolveImageGenerationPolicy(
  env: NodeJS.ProcessEnv = process.env,
  mode?: ImageGenerationMode,
): ImageGenerationPolicy {
  return {
    localFlux: resolveLocalFluxGenerationPolicy(env, mode),
  };
}
