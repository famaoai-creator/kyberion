import { describe, expect, it } from 'vitest';
import { parseScriptFlags } from './harness.js';

describe('script harness', () => {
  it('normalizes shared flags without consuming positional arguments', () => {
    expect(parseScriptFlags(['--json', '--dry-run', 'catalog.json', '--check'])).toEqual({
      json: true,
      dryRun: true,
      check: true,
      quiet: false,
      positional: ['catalog.json'],
    });
  });

  it('honors a script-declared flag surface', () => {
    expect(parseScriptFlags(['--json', '--check'], ['check'])).toEqual({
      json: false,
      dryRun: false,
      check: true,
      quiet: false,
      positional: ['--json'],
    });
  });
});
