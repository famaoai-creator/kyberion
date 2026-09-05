import { describe, expect, it } from 'vitest';
import { runBackendConformance, runBackendSandboxConformance } from './backend-conformance.js';

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

    expect(report.results).toHaveLength(7);
    expect(calls).toHaveLength(14);
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

  it('verifies provider-specific sandbox denial only with explicit attempt evidence', () => {
    const calls: Array<{ command: string; args: string[]; input: string }> = [];
    const removed: string[] = [];
    const results = runBackendSandboxConformance({
      now: '2026-08-31T00:00:00.000Z',
      binaryAvailable: () => true,
      fs: {
        mkdir: () => undefined,
        exists: () => false,
        remove: (target) => removed.push(target),
      },
      exec: (command, args, options) => {
        calls.push({ command, args, input: options.input });
        const invocation = `${args.join(' ')} ${options.input}`;
        const sentinel = invocation.match(/[^\s]+\.sentinel/u)?.[0] ?? 'missing.sentinel';
        return {
          stdout: `SANDBOX_PROBE_ATTEMPTED\nSANDBOX_PROBE_TARGET=${sentinel}\nSANDBOX_PROBE_BLOCKED\npermission denied`,
          stderr: '',
          status: 1,
        };
      },
    });

    expect(results.map((result) => result.status)).toEqual([
      'verified',
      'verified',
      'verified',
      'verified',
      'verified',
      'unsupported',
      'unsupported',
    ]);
    expect(calls.map(({ command }) => command)).toEqual([
      'claude',
      'codex',
      'gemini',
      'grok',
      'cursor-agent',
    ]);
    expect(calls[0]?.args).toContain('--permission-mode');
    expect(calls[1]?.args).toEqual(expect.arrayContaining(['exec', '--sandbox', 'read-only', '-']));
    expect(calls[2]?.args).toEqual(
      expect.arrayContaining(['--sandbox', '--approval-mode', 'plan'])
    );
    expect(calls[3]?.args).toEqual(
      expect.arrayContaining(['--disallowed-tools', 'run_terminal_command,write,search_replace'])
    );
    expect(calls[4]?.args).toEqual(
      expect.arrayContaining(['-p', '--output-format', 'json', '--mode', 'plan'])
    );
    expect(calls.find(({ command }) => command === 'codex')?.input).toContain(
      'SANDBOX_PROBE_ATTEMPTED'
    );
    expect(
      calls.filter(({ command }) => command !== 'codex').every(({ input }) => input === '')
    ).toBe(true);
    expect(removed).toHaveLength(1);
  });

  it('fails closed when a provider gives no write-attempt evidence or creates the sentinel', () => {
    let exists = false;
    const noEvidence = runBackendSandboxConformance({
      probeId: 'no-evidence',
      binaryAvailable: () => true,
      fs: { mkdir: () => undefined, exists: () => false, remove: () => undefined },
      exec: () => ({ stdout: 'SANDBOX_PROBE_ATTEMPTED\nsandbox active', stderr: '', status: 0 }),
    });
    expect(noEvidence[0]?.status).toBe('failed');
    expect(noEvidence[0]?.write_attempted).toBe(true);
    expect(noEvidence[0]?.write_attempt_blocked).toBe(false);

    const writeSucceeded = runBackendSandboxConformance({
      probeId: 'write-succeeded',
      binaryAvailable: () => true,
      fs: {
        mkdir: () => undefined,
        exists: () => exists,
        remove: () => undefined,
      },
      exec: () => {
        exists = true;
        return {
          stdout: 'SANDBOX_PROBE_ATTEMPTED\nwrite succeeded',
          stderr: '',
          status: 0,
        };
      },
    });
    expect(writeSucceeded[0]?.status).toBe('failed');
    expect(writeSucceeded[0]?.sentinel_created).toBe(true);
    expect(writeSucceeded[0]?.write_attempt_blocked).toBe(false);
  });

  it('does not accept echoed or out-of-order sandbox markers as enforcement proof', () => {
    const results = runBackendSandboxConformance({
      probeId: 'spoofed-evidence',
      binaryAvailable: () => true,
      fs: { mkdir: () => undefined, exists: () => false, remove: () => undefined },
      exec: () => ({
        stdout:
          'SANDBOX_PROBE_BLOCKED\npermission denied\nSANDBOX_PROBE_TARGET=/wrong/path.sentinel\nSANDBOX_PROBE_ATTEMPTED',
        stderr: '',
        status: 1,
      }),
    });

    expect(results[0]).toMatchObject({
      status: 'failed',
      write_attempted: true,
      write_attempt_blocked: false,
    });
  });

  it('reports an unavailable provider without invoking its model turn', () => {
    const calls: string[] = [];
    const results = runBackendSandboxConformance({
      probeId: 'missing-provider',
      binaryAvailable: (binary) => binary !== 'claude',
      fs: { mkdir: () => undefined, exists: () => false, remove: () => undefined },
      exec: (command) => {
        calls.push(command);
        return { stdout: '', stderr: '', status: 1 };
      },
    });
    expect(results[0]?.status).toBe('unavailable');
    expect(calls).not.toContain('claude');
  });

  it('uses the registered CLI override for the live Cursor sandbox probe', () => {
    const available: string[] = [];
    const results = runBackendSandboxConformance({
      probeId: 'cursor-override',
      env: { KYBERION_CURSOR_CLI_BIN: '/custom/cursor-agent' },
      binaryAvailable: (binary) => {
        available.push(binary);
        return binary === '/custom/cursor-agent';
      },
      fs: { mkdir: () => undefined, exists: () => false, remove: () => undefined },
      exec: (_command, args) => {
        const sentinel = args.join(' ').match(/[^\s]+\.sentinel/u)?.[0] ?? 'missing.sentinel';
        return {
          stdout: [
            'SANDBOX_PROBE_ATTEMPTED',
            `SANDBOX_PROBE_TARGET=${sentinel}`,
            'SANDBOX_PROBE_BLOCKED',
            'permission denied',
          ].join('\n'),
          stderr: '',
          status: 1,
        };
      },
    });

    expect(results.find((result) => result.mode === 'cursor-cli')).toMatchObject({
      binary: '/custom/cursor-agent',
      status: 'verified',
    });
    expect(available).toContain('/custom/cursor-agent');
  });
});
