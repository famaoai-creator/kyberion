import { describe, expect, it } from 'vitest';
import { normalizeSurfaceRuntimeArgs } from './surface_runtime.js';

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
});
