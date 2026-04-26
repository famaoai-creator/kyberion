import path from 'node:path';
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath, pathResolver } from '@agent/core';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('voice-actuator schema', () => {
  it('accepts supported voice actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, pathResolver.rootResolve('schemas/voice-action.schema.json'));

    expect(
      validate({
        action: 'generate_voice',
        request_id: 'req-schema-1',
        text: 'hello world',
        profile_ref: { profile_id: 'operator-ja-default' },
        engine: { engine_id: 'local_say' },
        rendering: {
          language: 'ja',
          chunking: {
            max_chunk_chars: 200,
            crossfade_ms: 50,
            preserve_paralinguistic_tags: true,
          },
        },
        delivery: {
          mode: 'artifact',
          format: 'wav',
          emit_progress_packets: true,
        },
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);

    expect(
      validate({
        action: 'register_voice_profile',
        request_id: 'reg-schema-1',
        profile: {
          profile_id: 'user-ja-voice',
          display_name: 'User JA',
          tier: 'personal',
          languages: ['ja'],
          default_engine_id: 'open_voice_clone',
        },
        samples: [
          { sample_id: 's1', path: 'Downloads/sample-1.wav', language: 'ja' },
          { sample_id: 's2', path: 'Downloads/sample-2.wav', language: 'ja' },
        ],
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);

    expect(
      validate({
        action: 'pipeline',
        steps: [
          {
            action: 'generate_voice',
            request_id: 'req-schema-1',
            text: 'hello world',
            profile_ref: { profile_id: 'operator-ja-default' },
            engine: { engine_id: 'local_say' },
            rendering: {
              language: 'ja',
              chunking: {
                max_chunk_chars: 200,
                crossfade_ms: 50,
                preserve_paralinguistic_tags: true,
              },
            },
            delivery: {
              mode: 'artifact',
              format: 'wav',
              emit_progress_packets: true,
            },
          },
        ],
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);
  });

  it('rejects unsupported voice actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, pathResolver.rootResolve('schemas/voice-action.schema.json'));

    expect(
      validate({
        action: 'unsupported',
        params: {},
      }),
    ).toBe(false);
  });
});
