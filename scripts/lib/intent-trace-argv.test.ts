import { describe, expect, it } from 'vitest';
import { withImplicitTraceSubcommand } from './intent-trace-argv.js';

describe('withImplicitTraceSubcommand', () => {
  it('makes `trace` implicit when run as the intent:trace package script', () => {
    expect(withImplicitTraceSubcommand(['corr-1', '--limit', '5'], 'intent:trace')).toEqual([
      'trace',
      'corr-1',
      '--limit',
      '5',
    ]);
    expect(withImplicitTraceSubcommand(['--json', 'corr-1'], 'intent:trace')[0]).toBe('trace');
  });

  it('keeps an explicit `trace` (no double verb) and other contexts unchanged', () => {
    expect(withImplicitTraceSubcommand(['trace', 'corr-1'], 'intent:trace')).toEqual([
      'trace',
      'corr-1',
    ]);
    expect(withImplicitTraceSubcommand(['corr-1'], undefined)).toEqual(['corr-1']);
    expect(withImplicitTraceSubcommand(['corr-1'], 'intent')).toEqual(['corr-1']);
    expect(withImplicitTraceSubcommand([], 'intent:trace')).toEqual([]);
  });

  it('routes a natural-language positional to `trace` untouched — the id guard rejects it', () => {
    // The argv layer only adds the implicit verb; it must not decompose a
    // multi-word question into unrelated-mission exploration. intent.ts
    // rejects whitespace-bearing ids as invalid_input before scanning.
    expect(withImplicitTraceSubcommand(['why did this fail'], 'intent:trace')).toEqual([
      'trace',
      'why did this fail',
    ]);
    expect(withImplicitTraceSubcommand(['trace', 'corr-1', 'extra'], 'intent:trace')).toEqual([
      'trace',
      'corr-1',
      'extra',
    ]);
  });
});
