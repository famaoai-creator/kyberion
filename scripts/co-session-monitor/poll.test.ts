import { describe, expect, it } from 'vitest';
import { parseMonitorArgs } from './poll.js';

describe('co-session-monitor parseMonitorArgs', () => {
  it('defaults to agy provider and derived participant id', () => {
    const opts = parseMonitorArgs([]);
    expect(opts.provider).toBe('agy');
    expect(opts.participant_id).toBe('agy-monitor');
  });

  it('accepts provider and participant id', () => {
    const opts = parseMonitorArgs(['--provider', 'gemini', '--participant-id', 'gemini-1']);
    expect(opts.provider).toBe('gemini');
    expect(opts.participant_id).toBe('gemini-1');
  });

  it('accepts --flag=value form', () => {
    const opts = parseMonitorArgs(['--provider=codex', '--interval-ms=100', '--max-wait-ms=1000']);
    expect(opts.provider).toBe('codex');
    expect(opts.interval_ms).toBe(100);
    expect(opts.max_wait_ms).toBe(1000);
  });

  it('does not swallow a following flag as a value', () => {
    const opts = parseMonitorArgs(['--provider', '--interval-ms', '500']);
    expect(opts.provider).toBe('agy');
    expect(opts.interval_ms).toBe(500);
  });

  it('fails fast on an unknown provider instead of looping silently', () => {
    expect(() => parseMonitorArgs(['--provider', 'bogus'])).toThrow(/invalid --provider/);
    expect(() => parseMonitorArgs(['--provider=--interval-ms'])).toThrow(/invalid --provider/);
  });
});
