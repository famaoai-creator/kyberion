import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from '@agent/core/schema-loader';
import { pathResolver } from '@agent/core/path-resolver';
import { describeOps, VOICE_OP_INPUT_CONTRACTS } from './op-catalog.js';

type AjvConstructor = typeof AjvModule;
type AddFormats = (ajv: InstanceType<AjvConstructor>) => unknown;
const Ajv: AjvConstructor =
  (AjvModule as unknown as { default?: AjvConstructor }).default ?? AjvModule;
const addFormats: AddFormats =
  (addFormatsModule as unknown as { default?: AddFormats }).default ??
  (addFormatsModule as unknown as AddFormats);

/** The contract served to pipelines (typed, or open for legacy-open ops). */
function opValidator(op: string) {
  const spec = describeOps().find((entry) => entry.op === op);
  if (!spec?.input_schema) throw new Error(`no input_schema for ${op}`);
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(spec.input_schema as object);
}

/** The typed declaration itself (what legacy-open ops migrate to). */
function typedValidator(op: string) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(VOICE_OP_INPUT_CONTRACTS[op] as object);
}

describe('voice-actuator op input contracts cover what the handlers read', () => {
  it.each(['transcribe', 'transcribe_voice_sample'])('%s declares every STT param', (op) => {
    const validate = opValidator(op);
    const params = {
      audio_path: 'active/shared/tmp/sample.wav',
      language: 'ja',
      purpose: 'accuracy',
      backend: 'auto',
      prefer_timestamps: false,
      allow_synthetic: true,
      write_sidecar: false,
      model: 'mlx-community/whisper-large-v3-turbo',
    };
    expect(validate(params), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...params, backend: 'cloud' })).toBe(false);
  });

  it('speak_local accepts purpose and local_only', () => {
    const validate = typedValidator('speak_local');
    expect(
      validate({ text: 'こんにちは', purpose: 'naturalness', local_only: true, language: 'ja' }),
      JSON.stringify(validate.errors)
    ).toBe(true);
  });

  it('verify_tts_loopback declares every param the loopback reads', () => {
    const validate = typedValidator('verify_tts_loopback');
    expect(
      validate({
        request_id: 'loop-1',
        text: 'Hello.',
        expected_text: 'Hello.',
        language: 'en',
        voice_profile_id: 'operator-ja-default',
        mission_id: 'MSN-1',
        tenant_slug: 'acme',
        operator_confirmed: true,
        stt_bridge_id: 'stub',
        dry_run: true,
        audio_route: { bus: 'stub' },
        format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
        timing: { pre_roll_ms: 0 },
        quality: { minimum_similarity: 0.5 },
        persistence: { retain_audio: false },
      }),
      JSON.stringify(validate.errors)
    ).toBe(true);
  });

  it('generate_voice ADF accepts engine auto with purpose and local_only', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      pathResolver.rootResolve('knowledge/product/schemas/voice-action.schema.json')
    );
    const request = {
      action: 'generate_voice',
      request_id: 'req-auto-1',
      text: 'こんにちは',
      profile_ref: { profile_id: 'operator-ja-default' },
      engine: { engine_id: 'auto', purpose: 'naturalness', local_only: true },
      rendering: {
        language: 'ja',
        chunking: { max_chunk_chars: 200, crossfade_ms: 50, preserve_paralinguistic_tags: true },
      },
      delivery: { mode: 'artifact', format: 'wav', emit_progress_packets: true },
    };
    expect(validate(request), JSON.stringify(validate.errors || [])).toBe(true);
    expect(validate({ ...request, engine: { engine_id: 'auto', purpose: 'Loud!' } })).toBe(false);
  });
});
