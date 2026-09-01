import { describe, expect, it } from 'vitest';
import { normalizeSurfaceRuntimeArgs, parseSurfaceRegisterArgs } from './surface_runtime.js';

describe('surface runtime entrypoint', () => {
  it('maps the unified positional action to the legacy action option', () => {
    expect(normalizeSurfaceRuntimeArgs(['reconcile', '--', '--json'])).toEqual([
      '--action',
      'reconcile',
    ]);
    expect(normalizeSurfaceRuntimeArgs(['status', '--surface', 'chronos'])).toEqual([
      '--action',
      'status',
      '--surface',
      'chronos',
    ]);
  });

  it('keeps explicit action options compatible', () => {
    expect(normalizeSurfaceRuntimeArgs(['--action', 'repair', '--surface', 'chronos'])).toEqual([
      '--action',
      'repair',
      '--surface',
      'chronos',
    ]);
  });

  it('accepts only string arrays for JSON register args and rejects dangerous keys', () => {
    expect(parseSurfaceRegisterArgs('["--port","3000"]')).toEqual(['--port', '3000']);
    expect(() => parseSurfaceRegisterArgs('{"__proto__":{"polluted":true}}')).toThrow(
      'surface register args contains a dangerous JSON key'
    );
    expect(() => parseSurfaceRegisterArgs('{"port":3000}')).toThrow(
      'surface register args must be a JSON array of strings'
    );
  });
});
