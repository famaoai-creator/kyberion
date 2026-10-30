import { describe, expect, it } from 'vitest';
import '../secure-io.js';
import { compileSchema } from '../foundation/ajv.js';
import { validateVideoFilterRequest } from './video-filter.js';

describe('reviewed video filter contract', () => {
  const validate = compileSchema('knowledge/product/schemas/video-filter.schema.json');
  const base = { source_id: 'camera', filter_id: 'filter' };
  it.each([
    { ...base, type: 'color_correction', settings: { hue_degrees: 45, opacity: 0.5 } },
    { ...base, type: 'chroma_key', settings: { color: 'custom', custom_color: '#12aBef' } },
    { ...base, type: 'crop', settings: { relative: false, width: 1280, height: 720 } },
  ])('shares a valid domain contract with runtime validation ($type)', (input) => {
    expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(validateVideoFilterRequest(input))).toBe(true);
  });
  it.each([
    { ...base, type: 'color_filter_v2', settings: {} },
    { ...base, type: 'color_correction', settings: { hue_shift: 30 } },
    { ...base, type: 'chroma_key', settings: { custom_color: 0xffaabb } },
    { ...base, type: 'crop', settings: { cx: 1280 } },
    { ...base, type: 'crop', settings: {}, source_id: '  ' },
    { ...base, type: 'color_correction', settings: { opacity: 1.1 } },
    { ...base, type: 'crop', settings: { width: 640, height: 480 } },
    { ...base, type: 'crop', settings: { relative: true, width: 640 } },
    { ...base, type: 'crop', settings: { relative: false, width: 640, height: 480, right: 10 } },
    { ...base, type: 'crop', settings: { relative: false, width: 0, height: 480 } },
    { ...base, type: 'chroma_key', settings: { custom_color: '#FF0000' } },
    { ...base, type: 'chroma_key', settings: { color: 'green', custom_color: '#FF0000' } },
    { ...base, type: 'chroma_key', settings: { color: 'custom' } },
  ])('rejects native fields and invalid input in schema and runtime ($type)', (input) => {
    expect(validate(input)).toBe(false);
    expect(() => validateVideoFilterRequest(input)).toThrow();
  });
});
