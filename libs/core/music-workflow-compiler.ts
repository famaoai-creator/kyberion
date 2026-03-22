import type { KyberionMusicGenerationADF } from './src/types/music-generation-adf.js';

export interface CompiledMusicWorkflow {
  workflow: Record<string, any>;
  engine: {
    provider: 'comfyui';
    model_family: 'ace_step_1_5';
    profile: string;
  };
  resolved: {
    tags: string;
    lyrics: string;
    duration_sec: number;
    bpm: number;
    keyscale: string;
    language: string;
    filename_prefix: string;
  };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'kyberion-music';
}

function deriveTags(adf: KyberionMusicGenerationADF): string {
  const parts = [
    adf.style.genre,
    ...(adf.style.mood || []),
    ...(adf.arrangement?.instruments || []),
    ...(adf.arrangement?.mix_traits || []),
    adf.style.vocal?.presence ? `${adf.style.vocal.gender || 'unspecified'} vocal` : 'instrumental',
    adf.intent,
  ];
  return parts.filter(Boolean).join(', ');
}

function resolveLyrics(adf: KyberionMusicGenerationADF): string {
  const mode = adf.lyrics?.mode || 'instrumental';
  if (mode === 'instrumental') return '';
  if (adf.lyrics?.text?.trim()) return adf.lyrics.text.trim();
  throw new Error(`lyrics.text is required when lyrics.mode is "${mode}"`);
}

function resolveProfile(adf: KyberionMusicGenerationADF): string {
  return adf.engine?.profile || 'turbo';
}

function resolveModels(adf: KyberionMusicGenerationADF): NonNullable<Required<NonNullable<KyberionMusicGenerationADF['engine']>['models']>> {
  const profile = resolveProfile(adf);
  const defaults = {
    unet_name: profile === 'base' ? 'acestep_v1.5.safetensors' : 'acestep_v1.5_turbo.safetensors',
    clip_name1: 'qwen_0.6b_ace15.safetensors',
    clip_name2: 'qwen_1.7b_ace15.safetensors',
    vae_name: 'ace_1.5_vae.safetensors',
  };
  return { ...defaults, ...(adf.engine?.models || {}) };
}

function normalizeLanguage(input?: string): string {
  if (!input) return 'en';
  const value = input.toLowerCase();
  if (value.startsWith('ja')) return 'ja';
  if (value.startsWith('en')) return 'en';
  return input;
}

function normalizeTimeSignature(input?: string): string {
  return input || '4';
}

function normalizeKeyscale(input?: string): string {
  return input || 'C major';
}

function resolveSeed(adf: KyberionMusicGenerationADF): number {
  return Number.isInteger(adf.engine?.seed) ? Number(adf.engine?.seed) : Math.floor(Date.now() % 2147483647);
}

export function compileMusicGenerationADF(adf: KyberionMusicGenerationADF): CompiledMusicWorkflow {
  if (adf.kind !== 'music-generation-adf') {
    throw new Error(`Unsupported ADF kind: ${adf.kind}`);
  }

  const tags = deriveTags(adf);
  const lyrics = resolveLyrics(adf);
  const profile = resolveProfile(adf);
  const models = resolveModels(adf);
  const duration = adf.composition.duration_sec;
  const bpm = adf.composition.bpm || 100;
  const keyscale = normalizeKeyscale(adf.composition.key);
  const language = normalizeLanguage(
    adf.style.vocal?.language || (adf.lyrics?.text?.trim() ? 'ja' : undefined),
  );
  const filename_prefix = adf.output.filename_prefix || slugify(adf.intent || `${adf.style.genre}-song`);
  const seed = resolveSeed(adf);

  const workflow = {
    '3': {
      inputs: {
        seed,
        steps: 8,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
        model: ['78', 0],
        positive: ['94', 0],
        negative: ['47', 0],
        latent_image: ['98', 0],
      },
      class_type: 'KSampler',
    },
    '18': {
      inputs: {
        samples: ['3', 0],
        vae: ['106', 0],
      },
      class_type: 'VAEDecodeAudio',
    },
    '47': {
      inputs: {
        conditioning: ['94', 0],
      },
      class_type: 'ConditioningZeroOut',
    },
    '78': {
      inputs: {
        model: ['104', 0],
        shift: 3,
      },
      class_type: 'ModelSamplingAuraFlow',
    },
    '94': {
      inputs: {
        clip: ['105', 0],
        tags,
        lyrics,
        seed,
        bpm,
        duration,
        timesignature: normalizeTimeSignature(adf.composition.time_signature),
        language,
        keyscale,
        generate_audio_codes: adf.engine?.generate_audio_codes ?? true,
        cfg_scale: adf.engine?.cfg_scale ?? 2,
        temperature: adf.engine?.temperature ?? 0.85,
        top_p: adf.engine?.top_p ?? 0.9,
        top_k: adf.engine?.top_k ?? 0,
        min_p: adf.engine?.min_p ?? 0,
      },
      class_type: 'TextEncodeAceStepAudio1.5',
    },
    '98': {
      inputs: {
        seconds: duration,
        batch_size: 1,
      },
      class_type: 'EmptyAceStep1.5LatentAudio',
    },
    '104': {
      inputs: {
        unet_name: models.unet_name,
        weight_dtype: 'default',
      },
      class_type: 'UNETLoader',
    },
    '105': {
      inputs: {
        clip_name1: models.clip_name1,
        clip_name2: models.clip_name2,
        type: 'ace',
        device: 'default',
      },
      class_type: 'DualCLIPLoader',
    },
    '106': {
      inputs: {
        vae_name: models.vae_name,
      },
      class_type: 'VAELoader',
    },
    '111': {
      inputs: {
        audio: ['18', 0],
        filename_prefix,
      },
      class_type: 'SaveAudioMP3',
    },
  };

  return {
    workflow,
    engine: {
      provider: 'comfyui',
      model_family: 'ace_step_1_5',
      profile,
    },
    resolved: {
      tags,
      lyrics,
      duration_sec: duration,
      bpm,
      keyscale,
      language,
      filename_prefix,
    },
  };
}
