import { getRegisteredEnvText } from './foundation/env.js';

export interface LocalMusicGenMlxGenerationPolicy {
  packageSpec: string;
  model: string;
  durationSec: number;
  maxDurationSec: number;
  timeoutMs: number;
  seed?: string;
}

export interface LocalStableAudioGenerationPolicy {
  packageSpec: string;
  model: string;
  durationSec: number;
  maxDurationSec: number;
  steps: number;
  timeoutMs: number;
  device?: string;
  seed?: string;
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function clampDuration(
  durationSec: number | undefined,
  fallback: number,
  maxDurationSec: number
): number {
  const requested =
    typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0
      ? Math.round(durationSec)
      : fallback;
  return Math.min(Math.max(1, requested), maxDurationSec);
}

export function resolveLocalMusicGenMlxGenerationPolicy(
  env: NodeJS.ProcessEnv = process.env
): LocalMusicGenMlxGenerationPolicy {
  const maxDurationSec = parsePositiveInteger(
    getRegisteredEnvText('KYBERION_MUSICGEN_MAX_DURATION_SEC', { env })?.trim(),
    30
  );
  const requestedDuration = parsePositiveInteger(
    getRegisteredEnvText('KYBERION_MUSICGEN_DURATION_SEC', { env })?.trim(),
    10
  );
  const seed = getRegisteredEnvText('KYBERION_MUSICGEN_SEED', { env })?.trim();

  return {
    packageSpec:
      getRegisteredEnvText('KYBERION_MUSICGEN_PACKAGE', { env })?.trim() || 'mlx-audiocraft',
    model:
      getRegisteredEnvText('KYBERION_MUSICGEN_MODEL', { env })?.trim() || 'facebook/musicgen-small',
    durationSec: Math.min(requestedDuration, maxDurationSec),
    maxDurationSec,
    timeoutMs: parsePositiveInteger(
      getRegisteredEnvText('KYBERION_MUSICGEN_TIMEOUT_MS', { env })?.trim(),
      30 * 60 * 1000
    ),
    ...(seed ? { seed } : {}),
  };
}

export function clampMusicGenDurationSec(
  durationSec: number | undefined,
  policy: LocalMusicGenMlxGenerationPolicy = resolveLocalMusicGenMlxGenerationPolicy()
): number {
  return clampDuration(durationSec, policy.durationSec, policy.maxDurationSec);
}

export function resolveLocalStableAudioGenerationPolicy(
  env: NodeJS.ProcessEnv = process.env
): LocalStableAudioGenerationPolicy {
  const maxDurationSec = parsePositiveInteger(
    getRegisteredEnvText('KYBERION_STABLE_AUDIO_MAX_DURATION_SEC', { env })?.trim(),
    120
  );
  const requestedDuration = parsePositiveInteger(
    getRegisteredEnvText('KYBERION_STABLE_AUDIO_DURATION_SEC', { env })?.trim(),
    30
  );
  const seed = getRegisteredEnvText('KYBERION_STABLE_AUDIO_SEED', { env })?.trim();
  const device = getRegisteredEnvText('KYBERION_STABLE_AUDIO_DEVICE', { env })?.trim();

  return {
    packageSpec:
      getRegisteredEnvText('KYBERION_STABLE_AUDIO_PACKAGE', { env })?.trim() ||
      'git+https://github.com/Stability-AI/stable-audio-3.git',
    model: getRegisteredEnvText('KYBERION_STABLE_AUDIO_MODEL', { env })?.trim() || 'small-music',
    durationSec: Math.min(requestedDuration, maxDurationSec),
    maxDurationSec,
    steps: parsePositiveInteger(
      getRegisteredEnvText('KYBERION_STABLE_AUDIO_STEPS', { env })?.trim(),
      8
    ),
    timeoutMs: parsePositiveInteger(
      getRegisteredEnvText('KYBERION_STABLE_AUDIO_TIMEOUT_MS', { env })?.trim(),
      30 * 60 * 1000
    ),
    ...(device ? { device } : {}),
    ...(seed ? { seed } : {}),
  };
}

export function clampStableAudioDurationSec(
  durationSec: number | undefined,
  policy: LocalStableAudioGenerationPolicy = resolveLocalStableAudioGenerationPolicy()
): number {
  return clampDuration(durationSec, policy.durationSec, policy.maxDurationSec);
}
