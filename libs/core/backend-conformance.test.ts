import { describe, expect, it } from 'vitest';
import { runBackendConformance } from './backend-conformance.js';

describe('backend conformance matrix (QM-06)', () => {
  it('records live CLI probes separately from declared capabilities', () => {
    const calls: string[] = [];
    const report = runBackendConformance({
      now: '2026-08-08T00:00:00.000Z',
      exec: (command, args) => {
        calls.push(`${command} ${args.join(' ')}`);
        return args[0] === '--help' ? 'usage: --output-schema --json' : `${command} 1.0.0`;
      },
    });

    expect(report.results).toHaveLength(6);
    expect(calls).toHaveLength(12);
    expect(report.results.every((result) => result.version.status === 'verified')).toBe(true);
    expect(report.results.every((result) => result.help.status === 'verified')).toBe(true);
    expect(report.results[0]?.capabilities.structured_output.status).toBe('verified');
    expect(report.results[0]?.capabilities.session_continuity.status).toBe('declared');
    expect(report.results[0]?.capabilities.streaming.status).toBe('declared');
    expect(report.results[0]?.capabilities.tool_calling.status).toBe('declared');
    expect(report.results[0]?.capabilities.native_subagent.status).toBe('declared');
  });

  it('marks a missing CLI unavailable without converting its declaration into proof', () => {
    const report = runBackendConformance({
      exec: () => {
        throw new Error('binary not found');
      },
    });
    expect(report.results.every((result) => result.version.status === 'unavailable')).toBe(true);
    expect(report.results.every((result) => result.help.status === 'unavailable')).toBe(true);
    expect(
      report.results.every((result) => result.capabilities.abort.status === 'unavailable')
    ).toBe(true);
    expect(
      report.results.every((result) => result.capabilities.native_subagent.status === 'unavailable')
    ).toBe(true);
  });
});
