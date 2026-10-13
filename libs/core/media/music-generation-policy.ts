import { getRegisteredEnvText } from '../foundation/env.js';

export interface LocalMusicGenMlxGenerationPolicy {
  packageSpec: string;
  model: string;
  durationSec: number;
  maxDurationSec: number;
  timeoutMs: number;
  seed?: string;
}

export interface LocalMlAudioGenGenerationPolicy {
  packageSpec: string;
  model: string;
  weightsDir?: string;
  durationSec: number;
  maxDurationSec: number;
  timeoutMs: number;
  topK: number;
  guidance: number;
  seed?: string;
}

export interface ChatMusicianGenerationPolicy {
  packageSpec: string;
  /** Converted MLX model dir; unset falls back to `hfRepo` for mlx-lm auto-convert. */
  model?: string;
  hfRepo: string;
  maxTokens: number;
  temperature: number;
  soundfont?: string;
  timeoutMs: number;
  seed?: string;
}

function parseOptionalText(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
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

export function resolveMlAudioGenGenerationPolicy(
  env: NodeJS.ProcessEnv = process.env
): LocalMlAudioGenGenerationPolicy {
  const maxDurationSec = parsePositiveInteger(
    getRegisteredEnvText('KYBERION_MUSAUDIOGEN_MAX_DURATION_SEC', { env })?.trim(),
    30
  );
  const requestedDuration = parsePositiveInteger(
    getRegisteredEnvText('KYBERION_MUSAUDIOGEN_DURATION_SEC', { env })?.trim(),
    10
  );
  const seed = parseOptionalText(getRegisteredEnvText('KYBERION_MUSAUDIOGEN_SEED', { env }));

  return {
    packageSpec:
      getRegisteredEnvText('KYBERION_MUSAUDIOGEN_PACKAGE', { env })?.trim() || 'mlx-audiogen',
    model:
      getRegisteredEnvText('KYBERION_MUSAUDIOGEN_MODEL', { env })?.trim() ||
      'facebook/musicgen-small',
    weightsDir: parseOptionalText(
      getRegisteredEnvText('KYBERION_MUSAUDIOGEN_WEIGHTS_DIR', { env })
    ),
    durationSec: Math.min(requestedDuration, maxDurationSec),
    maxDurationSec,
    timeoutMs: parsePositiveInteger(
      getRegisteredEnvText('KYBERION_MUSAUDIOGEN_TIMEOUT_MS', { env })?.trim(),
      30 * 60 * 1000
    ),
    topK: parsePositiveInteger(
      getRegisteredEnvText('KYBERION_MUSAUDIOGEN_TOP_K', { env })?.trim(),
      250
    ),
    guidance: parsePositiveInteger(
      getRegisteredEnvText('KYBERION_MUSAUDIOGEN_GUIDANCE', { env })?.trim(),
      3
    ),
    ...(seed ? { seed } : {}),
  };
}

export function clampMlAudioGenDurationSec(
  durationSec: number | undefined,
  policy: LocalMlAudioGenGenerationPolicy = resolveMlAudioGenGenerationPolicy()
): number {
  return clampDuration(durationSec, policy.durationSec, policy.maxDurationSec);
}

function parseTemperature(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Registry short names accepted by `mlx-audiogen --weights-dir` (auto-download). */
const MUSAUDIOGEN_VARIANT_BY_MODEL: Record<string, string> = {
  'facebook/musicgen-small': 'musicgen-small',
  'facebook/musicgen-medium': 'musicgen-medium',
  'facebook/musicgen-large': 'musicgen-large',
  'facebook/musicgen-melody': 'musicgen-melody',
  'facebook/musicgen-melody-large': 'musicgen-melody-large',
  'facebook/musicgen-style': 'musicgen-style',
  'facebook/musicgen-stereo-small': 'musicgen-stereo-small',
  'facebook/musicgen-stereo-medium': 'musicgen-stereo-medium',
  'facebook/musicgen-stereo-large': 'musicgen-stereo-large',
  'facebook/musicgen-stereo-melody': 'musicgen-stereo-melody',
  'facebook/musicgen-stereo-melody-large': 'musicgen-stereo-melody-large',
  'musicgen-small': 'musicgen-small',
  'musicgen-medium': 'musicgen-medium',
  'musicgen-large': 'musicgen-large',
  'musicgen-melody': 'musicgen-melody',
  'musicgen-melody-large': 'musicgen-melody-large',
  'musicgen-style': 'musicgen-style',
  'musicgen-stereo-small': 'musicgen-stereo-small',
  'musicgen-stereo-medium': 'musicgen-stereo-medium',
  'musicgen-stereo-large': 'musicgen-stereo-large',
  'musicgen-stereo-melody': 'musicgen-stereo-melody',
  'musicgen-stereo-melody-large': 'musicgen-stereo-melody-large',
};

/**
 * Which `--weights-dir` value to pass: an explicit env dir/name wins,
 * otherwise the request/policy model maps to a registry short name
 * (auto-downloaded on first use), defaulting to musicgen-small.
 */
export function resolveMlAudioGenVariant(
  model: string | undefined,
  policy: LocalMlAudioGenGenerationPolicy = resolveMlAudioGenGenerationPolicy()
): string {
  if (policy.weightsDir) return policy.weightsDir;
  const key = (model?.trim() || policy.model).trim();
  return MUSAUDIOGEN_VARIANT_BY_MODEL[key] || 'musicgen-small';
}

/** Pre-converted MLX weight repos (jasonvassallo/*) per registry short name. */
export const MUSAUDIOGEN_VARIANT_HF_REPO: Record<string, string> = {
  'musicgen-small': 'jasonvassallo/mlx-musicgen-small',
  'musicgen-medium': 'jasonvassallo/mlx-musicgen-medium',
  'musicgen-large': 'jasonvassallo/mlx-musicgen-large',
  'musicgen-stereo-small': 'jasonvassallo/mlx-musicgen-stereo-small',
  'musicgen-stereo-medium': 'jasonvassallo/mlx-musicgen-stereo-medium',
  'musicgen-stereo-large': 'jasonvassallo/mlx-musicgen-stereo-large',
  'musicgen-melody': 'jasonvassallo/mlx-musicgen-melody',
  'musicgen-melody-large': 'jasonvassallo/mlx-musicgen-melody-large',
  'musicgen-stereo-melody': 'jasonvassallo/mlx-musicgen-stereo-melody',
  'musicgen-stereo-melody-large': 'jasonvassallo/mlx-musicgen-stereo-melody-large',
  'musicgen-style': 'jasonvassallo/mlx-musicgen-style',
};

/** Marker files proving a converted weights dir is complete. */
export const MUSAUDIOGEN_REQUIRED_FILES = ['config.json', 't5.safetensors', 'decoder.safetensors'];

export function resolveChatMusicianGenerationPolicy(
  env: NodeJS.ProcessEnv = process.env
): ChatMusicianGenerationPolicy {
  const model = parseOptionalText(getRegisteredEnvText('KYBERION_CHATMUSICIAN_MODEL', { env }));
  const soundfont = parseOptionalText(
    getRegisteredEnvText('KYBERION_CHATMUSICIAN_SOUNDFONT', { env })
  );
  const seed = parseOptionalText(getRegisteredEnvText('KYBERION_CHATMUSICIAN_SEED', { env }));

  return {
    packageSpec: getRegisteredEnvText('KYBERION_CHATMUSICIAN_PACKAGE', { env })?.trim() || 'mlx-lm',
    ...(model ? { model } : {}),
    hfRepo:
      getRegisteredEnvText('KYBERION_CHATMUSICIAN_HF_REPO', { env })?.trim() ||
      'm-a-p/ChatMusician',
    maxTokens: parsePositiveInteger(
      getRegisteredEnvText('KYBERION_CHATMUSICIAN_MAX_TOKENS', { env })?.trim(),
      1024
    ),
    temperature: parseTemperature(
      getRegisteredEnvText('KYBERION_CHATMUSICIAN_TEMPERATURE', { env })?.trim(),
      0.7
    ),
    ...(soundfont ? { soundfont } : {}),
    timeoutMs: parsePositiveInteger(
      getRegisteredEnvText('KYBERION_CHATMUSICIAN_TIMEOUT_MS', { env })?.trim(),
      30 * 60 * 1000
    ),
    ...(seed ? { seed } : {}),
  };
}
