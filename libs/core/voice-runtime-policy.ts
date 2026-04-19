import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { safeJsonParse } from './validators.js';

export interface VoiceRuntimePolicy {
  version: string;
  queue: {
    concurrency: number;
    cancellation: 'queued_only' | 'queued_or_running';
  };
  chunking: {
    default_max_chunk_chars: number;
    default_crossfade_ms: number;
    preserve_paralinguistic_tags: boolean;
  };
  progress: {
    throttle_ms: number;
    min_percent_delta: number;
    emit_heartbeat: boolean;
  };
  delivery: {
    default_format: 'wav' | 'mp3' | 'ogg';
    retain_original_version: boolean;
    create_processed_version: boolean;
  };
  routing: {
    default_personal_voice_mode: 'allow_fallback' | 'require_personal_voice';
    enforce_clone_engine_for_personal_tier: boolean;
  };
}

const DEFAULT_POLICY_PATH = pathResolver.knowledge('public/governance/voice-runtime-policy.json');

const FALLBACK_POLICY: VoiceRuntimePolicy = {
  version: 'fallback',
  queue: {
    concurrency: 1,
    cancellation: 'queued_or_running',
  },
  chunking: {
    default_max_chunk_chars: 800,
    default_crossfade_ms: 50,
    preserve_paralinguistic_tags: true,
  },
  progress: {
    throttle_ms: 500,
    min_percent_delta: 1,
    emit_heartbeat: true,
  },
  delivery: {
    default_format: 'wav',
    retain_original_version: true,
    create_processed_version: false,
  },
  routing: {
    default_personal_voice_mode: 'allow_fallback',
    enforce_clone_engine_for_personal_tier: true,
  },
};

let cachedPolicyPath: string | null = null;
let cachedPolicy: VoiceRuntimePolicy | null = null;

function getPolicyPath(): string {
  return process.env.KYBERION_VOICE_RUNTIME_POLICY_PATH?.trim() || DEFAULT_POLICY_PATH;
}

export function resetVoiceRuntimePolicyCache(): void {
  cachedPolicyPath = null;
  cachedPolicy = null;
}

export function getVoiceRuntimePolicy(): VoiceRuntimePolicy {
  const policyPath = getPolicyPath();
  if (cachedPolicyPath === policyPath && cachedPolicy) return cachedPolicy;

  if (!safeExistsSync(policyPath)) {
    cachedPolicyPath = policyPath;
    cachedPolicy = FALLBACK_POLICY;
    return cachedPolicy;
  }

  try {
    const raw = safeReadFile(policyPath, { encoding: 'utf8' }) as string;
    const parsed = safeJsonParse<VoiceRuntimePolicy>(raw, 'voice runtime policy');
    cachedPolicyPath = policyPath;
    cachedPolicy = parsed;
    return parsed;
  } catch (error: any) {
    logger.warn(`[VOICE_RUNTIME_POLICY] Failed to load policy at ${policyPath}: ${error.message}`);
    cachedPolicyPath = policyPath;
    cachedPolicy = FALLBACK_POLICY;
    return cachedPolicy;
  }
}
