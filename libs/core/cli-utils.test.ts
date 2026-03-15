import { describe, expect, it } from 'vitest';
import { createStandardYargs } from './cli-utils.js';

describe('cli-utils', () => {
  it('parses standard options and defaults the tier', async () => {
    const argv = await createStandardYargs([
      'node',
      'script',
      '--input',
      'in.json',
      '--out',
      'out.json',
    ]).parse();

    expect(argv.input).toBe('in.json');
    expect(argv.out).toBe('out.json');
    expect(argv.tier).toBe('public');
  });

  it('accepts the short aliases', async () => {
    const argv = await createStandardYargs([
      'node',
      'script',
      '-i',
      'data.yaml',
      '-o',
      'data.json',
      '--tier',
      'confidential',
    ]).parse();

    expect(argv.input).toBe('data.yaml');
    expect(argv.out).toBe('data.json');
    expect(argv.tier).toBe('confidential');
  });
});
