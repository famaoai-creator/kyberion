import { describe, expect, it } from 'vitest';
import { FIRST_RUN_DEFAULT_URL, parseFirstRunCommand } from './organization_first_run.js';

describe('organization first-run command', () => {
  it('parses code with defaults and overrides', () => {
    expect(parseFirstRunCommand(['code'])).toEqual({ action: 'code', url: FIRST_RUN_DEFAULT_URL });
    expect(
      parseFirstRunCommand(['code', '--ttl-minutes', '10', '--url', 'https://desk.example.com/x'])
    ).toEqual({ action: 'code', ttlMinutes: 10, url: 'https://desk.example.com' });
    expect(parseFirstRunCommand(['status'])).toEqual({ action: 'status' });
  });

  it('returns help and rejects bad input', () => {
    expect(parseFirstRunCommand([])).toBeNull();
    expect(parseFirstRunCommand(['--help'])).toBeNull();
    expect(() => parseFirstRunCommand(['reset'])).toThrow(/unknown first-run command/);
    expect(() => parseFirstRunCommand(['code', '--ttl-minutes', '1.5'])).toThrow(/integer/);
    expect(() => parseFirstRunCommand(['code', '--url', 'ftp://x'])).toThrow(/origin/);
    expect(() => parseFirstRunCommand(['code', '--url'])).toThrow(/requires a value/);
  });
});
