import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver, safeMkdir, safeWriteFile } from '@agent/core';
import { getVoiceRuntimePolicy, resetVoiceRuntimePolicyCache } from './voice-runtime-policy.js';

describe('voice runtime policy', () => {
  const tmpDir = pathResolver.sharedTmp('voice-runtime-policy-tests');
  const overridePath = `${tmpDir}/voice-runtime-policy.json`;

  afterEach(() => {
    delete process.env.KYBERION_VOICE_RUNTIME_POLICY_PATH;
    resetVoiceRuntimePolicyCache();
  });

  it('loads override policy files', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overridePath,
      JSON.stringify({
        version: 'test',
        queue: { concurrency: 1, cancellation: 'queued_only' },
        chunking: {
          default_max_chunk_chars: 640,
          default_crossfade_ms: 25,
          preserve_paralinguistic_tags: true,
        },
        progress: {
          throttle_ms: 100,
          min_percent_delta: 5,
          emit_heartbeat: false,
        },
        delivery: {
          default_format: 'mp3',
          retain_original_version: true,
          create_processed_version: true,
        },
        routing: {
          default_personal_voice_mode: 'require_personal_voice',
          enforce_clone_engine_for_personal_tier: true,
        },
      }),
    );
    process.env.KYBERION_VOICE_RUNTIME_POLICY_PATH = overridePath;

    const policy = getVoiceRuntimePolicy();
    expect(policy.version).toBe('test');
    expect(policy.chunking.default_max_chunk_chars).toBe(640);
    expect(policy.delivery.default_format).toBe('mp3');
    expect(policy.routing.default_personal_voice_mode).toBe('require_personal_voice');
  });
});
