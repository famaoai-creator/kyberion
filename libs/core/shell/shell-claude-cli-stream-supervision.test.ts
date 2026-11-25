import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { withDelegationProgress } from '../mission/delegation-progress.js';
import {
  claudeStreamProgressEvent,
  extractClaudeStreamResult,
  ShellClaudeCliBackend,
} from './shell-claude-cli-backend.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

/** A child that stays silent until killed, like a CLI hung at launch. */
function silentChild(): any {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal: string) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit('close', null));
    return true;
  });
  return child;
}

describe('claude-cli stream supervision', () => {
  it('reads the final result record of a stream-json run', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'final answer' }),
    ].join('\n');
    expect(extractClaudeStreamResult(stdout)).toBe('final answer');
    expect(extractClaudeStreamResult(JSON.stringify({ type: 'result', result: 'one' }))).toBe(
      'one'
    );
    expect(extractClaudeStreamResult('plain text')).toBe('plain text');
  });

  it('counts assistant and tool records as progress, never init', () => {
    expect(
      claudeStreamProgressEvent(JSON.stringify({ type: 'system', subtype: 'init' }))
    ).toBeUndefined();
    expect(claudeStreamProgressEvent(JSON.stringify({ type: 'assistant' }))).toBe(
      'assistant_message'
    );
    expect(claudeStreamProgressEvent(JSON.stringify({ type: 'user' }))).toBe('tool_completed');
    expect(claudeStreamProgressEvent('not json')).toBeUndefined();
  });

  it('fails a CLI that prints nothing at launch as a timeout, long before the hard ceiling', async () => {
    const child = silentChild();
    spawnMock.mockReturnValueOnce(child);
    const backend = new ShellClaudeCliBackend({
      bin: 'claude',
      model: 'opus',
      timeoutMs: 60_000,
      startupTimeoutMs: 50,
    });
    const started = Date.now();
    await expect(backend.delegateTask('task')).rejects.toThrow(/timed out: startup stalled/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('forwards stream progress to an enclosing supervised delegation', async () => {
    const child = silentChild();
    spawnMock.mockReturnValueOnce(child);
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);
      child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n`);
      child.stdout.write(`${JSON.stringify({ type: 'result', result: 'done' })}\n`);
      child.stdout.end();
      child.exitCode = 0;
      child.emit('close', 0);
    });
    const events: string[] = [];
    const backend = new ShellClaudeCliBackend({ bin: 'claude', model: 'opus' });
    const result = await withDelegationProgress(
      (event) => events.push(event),
      () => backend.delegateTask('task')
    );
    expect(result).toBe('done');
    expect(events).toContain('assistant_message');
  });
});
