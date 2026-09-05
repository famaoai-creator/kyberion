import { describe, expect, it, vi } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { listMemoryQueue } from './refactor/mission-memory-commands.js';
import { ScriptExitError } from './lib/harness.js';

describe('mission memory command output boundary', () => {
  it('keeps memory command output away from direct console streams', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/refactor/mission-memory-commands.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain('print: Print');
    expect(source).not.toContain('process.env.MISSION_ID');
    expect(source).toContain("registeredEnv('MISSION_ID')");
  });

  it('routes the queue table through the supplied printer', () => {
    const output: unknown[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      listMemoryQueue('queued', (value) => output.push(value));
      expect(output[0]).toBe('');
      expect(String(output[1])).toContain('CANDIDATE_ID');
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('returns memory command failures through the governed script error', async () => {
    const { approveMemoryCandidate, promoteMemoryCandidate } =
      await import('./refactor/mission-memory-commands.js');

    expect(() => approveMemoryCandidate('')).toThrowError(ScriptExitError);
    await expect(promoteMemoryCandidate('')).rejects.toBeInstanceOf(ScriptExitError);
  });
});
