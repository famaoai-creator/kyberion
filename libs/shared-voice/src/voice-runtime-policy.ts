import { getRegisteredEnvText } from '@agent/core/foundation/env';
import { defineCatalog } from '@agent/core/foundation/governed-catalog';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';

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

const DEFAULT_POLICY_PATH = pathResolver.knowledge('product/governance/voice-runtime-policy.json');

function getPolicyPath(): string {
  return assertSafeRepositoryPath(
    getRegisteredEnvText('KYBERION_VOICE_RUNTIME_POLICY_PATH')?.trim() || DEFAULT_POLICY_PATH,
    { allowMissingLeaf: true }
  );
}

const policyCatalog = defineCatalog<VoiceRuntimePolicy>({
  id: 'voice-runtime-policy',
  path: getPolicyPath,
  schema: pathResolver.knowledge('product/schemas/voice-runtime-policy.schema.json'),
});

export function _resetVoiceRuntimePolicyCacheForTests(): void {
  policyCatalog.reset();
}

export function getVoiceRuntimePolicy(): VoiceRuntimePolicy {
  return policyCatalog.load();
}
