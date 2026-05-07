import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from '@agent/core';
import { describe, expect, it } from 'vitest';
import { compileMusicGenerationADF } from './music-workflow-compiler.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('compileMusicGenerationADF', () => {
  it('builds an ACE-Step workflow from a music generation ADF', () => {
    const adf = {
      kind: 'music-generation-adf',
      version: '1.0.0',
      intent: 'anniversary_song',
      style: {
        genre: 'country',
        mood: ['warm', 'hopeful'],
        vocal: {
          presence: true,
          gender: 'female',
          language: 'ja',
        },
      },
      composition: {
        duration_sec: 180,
        bpm: 84,
        key: 'D major',
        structure: ['verse', 'chorus'],
      },
      lyrics: {
        mode: 'provided',
        text: '[Verse]\nありがとう',
      },
      arrangement: {
        instruments: ['acoustic_guitar', 'harmonica'],
        mix_traits: ['intimate'],
      },
      output: {
        format: 'mp3',
        filename_prefix: 'anniversary-song',
      },
    } as any;
    const result = compileMusicGenerationADF(adf);

    expect(result.engine).toEqual({
      provider: 'comfyui',
      model_family: 'ace_step_1_5',
      profile: 'turbo',
    });
    expect(result.resolved).toEqual(expect.objectContaining({
      duration_sec: 180,
      bpm: 84,
      keyscale: 'D major',
      language: 'ja',
      filename_prefix: 'anniversary-song',
    }));
    expect(result.workflow['94']).toEqual(expect.objectContaining({
      class_type: 'TextEncodeAceStepAudio1.5',
      inputs: expect.objectContaining({
        bpm: 84,
        duration: 180,
        language: 'ja',
        lyrics: '[Verse]\nありがとう',
      }),
    }));
    expect(result.workflow['111']).toEqual({
      class_type: 'SaveAudioMP3',
      inputs: {
        audio: ['18', 0],
        filename_prefix: 'anniversary-song',
        quality: 'V0',
      },
    });
  });

  it('emits music-generation-adf that matches the schema', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/public/schemas/music-generation-adf.schema.json'));

    expect(validate({
      kind: 'music-generation-adf',
      version: '1.0.0',
      intent: 'anniversary_song',
      style: {
        genre: 'country',
        mood: ['warm', 'hopeful'],
        vocal: {
          presence: true,
          gender: 'female',
          language: 'ja',
        },
      },
      composition: {
        duration_sec: 180,
        bpm: 84,
        key: 'D major',
        structure: ['verse', 'chorus'],
      },
      lyrics: {
        mode: 'provided',
        text: '[Verse]\nありがとう',
      },
      arrangement: {
        instruments: ['acoustic_guitar', 'harmonica'],
        mix_traits: ['intimate'],
      },
      output: {
        format: 'mp3',
        filename_prefix: 'anniversary-song',
      },
    })).toBe(true);
  });

  it('rejects vocal workflows that omit provided lyrics', () => {
    expect(() => compileMusicGenerationADF({
      kind: 'music-generation-adf',
      version: '1.0.0',
      style: {
        genre: 'country',
        vocal: {
          presence: true,
        },
      },
      composition: {
        duration_sec: 30,
      },
      lyrics: {
        mode: 'provided',
      },
      output: {
        format: 'mp3',
      },
    } as any)).toThrow('lyrics.text is required');
  });
});
