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
});
