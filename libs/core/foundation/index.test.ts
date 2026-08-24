import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileSchema } from './ajv.js';
import { clamp, normalizeText, parseIso, slugify } from './index.js';

describe('foundation helpers', () => {
  it('keeps deterministic text and numeric semantics in one place', () => {
    expect(normalizeText('  hello   world  ')).toBe('hello world');
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(clamp(12, 0, 10)).toBe(10);
    expect(parseIso('2026-08-25T00:00:00.000Z').toISOString()).toBe('2026-08-25T00:00:00.000Z');
  });

  it('rejects invalid ranges and timestamps', () => {
    expect(() => clamp(1, 2, 0)).toThrow('Invalid clamp range');
    expect(() => parseIso('not-a-date')).toThrow('Invalid ISO timestamp');
  });

  it('registers external refs before compiling actuator schemas', () => {
    const validateVoiceAction = compileSchema(
      path.resolve(process.cwd(), 'schemas/voice-action.schema.json')
    );
    const validateVideoAction = compileSchema(
      path.resolve(process.cwd(), 'schemas/video-composition-action.schema.json')
    );

    expect(validateVoiceAction({ action: 'health', params: {} })).toBe(true);
    expect(validateVideoAction({ action: 'list_video_composition_templates', params: {} })).toBe(
      true
    );
  });
});
